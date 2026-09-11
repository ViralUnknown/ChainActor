import { Actor, log } from 'apify';
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import { setTimeout } from 'node:timers/promises';

Actor.on('aborting', async () => {
    log.warning('Actor aborting signal received. Exiting gracefully...');
    await setTimeout(1000);
    await Actor.exit();
});

await Actor.init();

const input = (await Actor.getInput()) || {};
const {
    batchSize = 50,
    minFollowers = 200,
    maxConcurrency = 5,
    delayBetweenRequests = 1500,
    supabaseUrl = process.env.AIS_SUPABASE_URL || process.env.SUPABASE_URL,
    supabaseAnonKey = process.env.AIS_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY,
} = input;

if (!supabaseUrl || !supabaseAnonKey) {
    log.error('Supabase credentials missing. Actor 3 requires Supabase to read and update leads.');
    await Actor.exit();
}

const supabase = createClient(supabaseUrl, supabaseAnonKey);

// ── Fetch Candidates from Supabase ───────────────────────────────────────────
log.info(`Fetching up to ${batchSize} Nigerian accounts with status 'about_checked'...`);
const { data: candidates, error: fetchErr } = await supabase
    .from('commenter_usernames')
    .select('username')
    .eq('is_nigerian', true)
    .eq('status', 'about_checked')
    .limit(batchSize);

if (fetchErr) {
    log.error(`Supabase fetch error: ${fetchErr.message}`);
    await Actor.exit();
}

if (!candidates || candidates.length === 0) {
    log.info('No pending candidates ready for follower checks in Supabase.');
    await Actor.exit();
}

log.info(`Found ${candidates.length} Nigerian accounts to check.`);

// ── Helper: Parse Counts (K, M, B) ───────────────────────────────────────────
function parseCount(text) {
    if (!text) return 0;
    const clean = text.replace(/,/g, '').trim();
    if (clean.endsWith('K') || clean.endsWith('k')) return Math.round(parseFloat(clean) * 1_000);
    if (clean.endsWith('M') || clean.endsWith('m')) return Math.round(parseFloat(clean) * 1_000_000);
    if (clean.endsWith('B') || clean.endsWith('b')) return Math.round(parseFloat(clean) * 1_000_000_000);
    return parseInt(clean, 10) || 0;
}

// ── Launch Master Brave Instance ─────────────────────────────────────────────
const braveExecutablePath = process.env.BRAVE_PATH || '/usr/bin/brave-browser';
const browser = await chromium.launch({
    executablePath: braveExecutablePath,
    headless: true,
    args: [
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
    ],
});

let passedCount = 0;
let deletedCount = 0;

async function checkProfile(username) {
    const context = await browser.newContext({
        userAgent:
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    try {
        await page.route('**/*', (route) => {
            const type = route.request().resourceType();
            if (['image', 'media', 'font', 'stylesheet'].includes(type)) {
                route.abort();
            } else {
                route.continue();
            }
        });

        await page.goto(`https://x.com/${username}`, {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
        });
        await setTimeout(2500);

        const data = await page.evaluate(() => {
            let followerText = '';
            let followingText = '';

            document.querySelectorAll('a[href]').forEach((link) => {
                const href = link.getAttribute('href') || '';
                link.querySelectorAll('span, div').forEach((el) => {
                    const txt = el.textContent.trim();
                    if (!txt || !/^[\d.,KMB]+$/i.test(txt)) return;
                    if (href.endsWith('/followers') || href.endsWith('/verified_followers')) {
                        followerText = txt;
                    }
                    if (href.endsWith('/following')) {
                        followingText = txt;
                    }
                });
            });

            return { followerText, followingText };
        });

        const followerCount = parseCount(data.followerText);
        const followingCount = parseCount(data.followingText);

        // ── Rule Check ──
        // 1. Min 200 followers
        // 2. Ratio rule: Neither followers nor following can exceed 3x the other
        const hasMinFollowers = followerCount >= minFollowers;
        const ratioOk =
            followerCount > 0 &&
            followingCount > 0 &&
            followerCount <= 3 * followingCount &&
            followingCount <= 3 * followerCount;

        if (hasMinFollowers && ratioOk) {
            log.info(`[PASS] @${username} passed! Followers: ${followerCount} | Following: ${followingCount}. Updating to ready_to_follow.`);
            await supabase
                .from('commenter_usernames')
                .update({
                    follower_count: followerCount,
                    following_count: followingCount,
                    ratio_ok: true,
                    status: 'ready_to_follow',
                    follower_checked_at: new Date().toISOString(),
                })
                .eq('username', username);

            await Actor.pushData({
                username,
                followerCount,
                followingCount,
                ratioOk: true,
                status: 'ready_to_follow',
            });
            passedCount++;
        } else {
            const reason = !hasMinFollowers
                ? `< ${minFollowers} followers (${followerCount})`
                : `Ratio outside 1:3 bounds (${followerCount} vs ${followingCount})`;
            log.info(`[DELETE] @${username} failed criteria: ${reason}. Hard deleting from DB.`);
            
            await supabase
                .from('commenter_usernames')
                .delete()
                .eq('username', username);

            await Actor.pushData({
                username,
                followerCount,
                followingCount,
                reason,
                action: 'hard_deleted',
            });
            deletedCount++;
        }
    } catch (err) {
        log.error(`[@${username}] Check failed: ${err.message}`);
    } finally {
        await context.close();
    }

    if (delayBetweenRequests > 0) {
        await setTimeout(delayBetweenRequests);
    }
}

// ── Run parallel queue ────────────────────────────────────────────────────────
const queue = candidates.map((c) => c.username);
const workers = Array.from({ length: Math.min(maxConcurrency, queue.length) }, async () => {
    while (queue.length > 0) {
        const user = queue.shift();
        if (user) await checkProfile(user);
    }
});

await Promise.all(workers);

log.info(`Actor 3 complete. Passed & Ready: ${passedCount} | Deleted: ${deletedCount}`);
await browser.close();
await Actor.exit();
