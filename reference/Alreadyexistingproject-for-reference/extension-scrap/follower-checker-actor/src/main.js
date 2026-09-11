import { Actor, log } from 'apify';
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import { setTimeout } from 'node:timers/promises';

const MAX_CONCURRENCY = 10;

// ── Graceful Abort Handling ───────────────────────────────────────────────────
Actor.on('aborting', async () => {
    log.warning('Actor aborting signal received. Exiting...');
    await setTimeout(1000);
    await Actor.exit();
});

// ── Init ──────────────────────────────────────────────────────────────────────
await Actor.init();

const input = (await Actor.getInput()) || {};
const {
    usernames = [],
    delayBetweenRequests = 2000,
    batchSize = 6,
    supabaseUrl = process.env.SUPABASE_URL,
    supabaseAnonKey = process.env.SUPABASE_ANON_KEY,
} = input;

if (!Array.isArray(usernames) || usernames.length === 0) {
    log.error('No target usernames provided in input.');
    await Actor.exit();
}

log.info(`Starting 10-worker parallel Brave scraper for ${usernames.length} profiles.`, {
    maxConcurrency: MAX_CONCURRENCY,
    delayBetweenRequests,
});

// ── Supabase (Optional) ───────────────────────────────────────────────────────
let supabaseClient = null;
if (supabaseUrl && supabaseAnonKey) {
    try {
        supabaseClient = createClient(supabaseUrl, supabaseAnonKey);
        log.info('Supabase client initialized for cloud streaming.');
    } catch (err) {
        log.warning(`Failed to initialize Supabase client: ${err.message}`);
    }
}

// ── Helper: Supabase Batch Buffer ─────────────────────────────────────────────
let supabaseBuffer = [];

async function flushToSupabase(batch) {
    if (!batch.length || !supabaseClient) return;
    const rows = batch.map((item) => ({
        username: item.username,
        follower_text: item.followerText,
        follower_count: item.followerCount,
        following_text: item.followingText,
        following_count: item.followingCount,
        is_verified: item.isVerified,
        scraped_at: item.scrapedAt,
    }));
    const { error } = await supabaseClient
        .from('scraped_profiles')
        .upsert(rows, { onConflict: 'username' });
    if (error) {
        log.error(`[Supabase] Upsert error: ${error.message}`);
    } else {
        log.info(`[Supabase] Flushed ${batch.length} profiles.`);
    }
}

async function bufferForSupabase(result) {
    if (!supabaseClient) return;
    supabaseBuffer.push(result);
    if (supabaseBuffer.length >= batchSize) {
        const batch = supabaseBuffer.splice(0, batchSize);
        await flushToSupabase(batch);
    }
}

// ── Helper: Sanitize Username ─────────────────────────────────────────────────
function sanitizeUsername(raw) {
    return raw
        .replace(/https?:\/\/(www\.)?(x\.com|twitter\.com)\//i, '')
        .replace(/^@/, '')
        .split('/')[0]
        .trim()
        .toLowerCase();
}

// ── Helper: Parse Follower Count Text ────────────────────────────────────────
function parseCount(text) {
    if (!text) return 0;
    const clean = text.replace(/,/g, '').trim();
    if (clean.endsWith('K')) return Math.round(parseFloat(clean) * 1_000);
    if (clean.endsWith('M')) return Math.round(parseFloat(clean) * 1_000_000);
    if (clean.endsWith('B')) return Math.round(parseFloat(clean) * 1_000_000_000);
    return parseInt(clean) || 0;
}

// ── Launch Single Master Brave Instance ──────────────────────────────────────
log.info('Launching Brave Browser (master instance)...');
const browser = await chromium.launch({
    executablePath: '/usr/bin/brave-browser',
    headless: true,
    args: [
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
    ],
});

// ── Worker: Scrape a Single Profile ──────────────────────────────────────────
async function scrapeProfile(username, isRetry = false) {
    const context = await browser.newContext({
        userAgent:
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    try {
        // Block heavy resources to conserve bandwidth & RAM
        await page.route('**/*', (route) => {
            const type = route.request().resourceType();
            if (['image', 'media', 'font', 'stylesheet'].includes(type)) {
                route.abort();
            } else {
                route.continue();
            }
        });

        log.info(`[@${username}] Navigating...`);
        await page.goto(`https://x.com/${username}`, {
            waitUntil: 'domcontentloaded',
            timeout: 30_000,
        });
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await setTimeout(3000);

        const data = await page.evaluate(() => {
            const isVerified = !!(
                document.querySelector('[data-testid="icon-verified"]') ||
                document.querySelector('[data-icon="icon-verified"]') ||
                document.querySelector('[aria-label="Verified account"]')
            );

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

            return { isVerified, followerText, followingText };
        });

        const result = {
            username,
            followerText: data.followerText || '0',
            followerCount: parseCount(data.followerText),
            followingText: data.followingText || '0',
            followingCount: parseCount(data.followingText),
            isVerified: data.isVerified,
            scrapedAt: new Date().toISOString(),
        };

        // ── Stream immediately — no array accumulation ──
        await Actor.pushData(result);
        await bufferForSupabase(result);

        log.info(
            `[@${username}] ✓ Followers: ${result.followerText} | Following: ${result.followingText} | Verified: ${result.isVerified}`,
        );
        return true;
    } catch (err) {
        log.error(`[@${username}] ✗ Scrape failed${isRetry ? ' (Final)' : ' (Will Retry)'}: ${err.message}`);

        if (isRetry) {
            const errResult = {
                username,
                followerText: 'Error',
                followerCount: 0,
                followingText: 'Error',
                followingCount: 0,
                isVerified: false,
                scrapedAt: new Date().toISOString(),
            };
            await Actor.pushData(errResult);
            await bufferForSupabase(errResult);
        }
        return false;
    } finally {
        // Always release context memory regardless of success/failure
        await context.close();
    }

    if (delayBetweenRequests > 0) {
        await setTimeout(delayBetweenRequests + Math.floor(Math.random() * 500));
    }
}

// ── Concurrency Queue: Running in Parallel ─────────────────────────
// Uses a worker-drain pattern: spawn N workers that each pull from a shared
// queue until it's empty.
async function runWithConcurrency(items, limit, task) {
    const queue = [...items];
    const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
        while (queue.length > 0) {
            const item = queue.shift();
            if (item) await task(item);
        }
    });
    await Promise.all(workers);
}

// Main execution logic
const sanitizedUsernames = usernames.map(sanitizeUsername).filter(Boolean);
const failedUsernames = [];

log.info(`Processing ${sanitizedUsernames.length} profiles with ${MAX_CONCURRENCY} parallel workers...`);

await runWithConcurrency(sanitizedUsernames, MAX_CONCURRENCY, async (username) => {
    const success = await scrapeProfile(username, false);
    if (!success) {
        failedUsernames.push(username);
    }
});

// ── Retry Phase ───────────────────────────────────────────────────────────────
if (failedUsernames.length > 0) {
    log.warning(`Starting retry phase for ${failedUsernames.length} failed profiles...`);
    // Wait a brief moment before retrying to let target platform cool down
    await setTimeout(5000);
    
    await runWithConcurrency(failedUsernames, MAX_CONCURRENCY, async (username) => {
        await scrapeProfile(username, true); // Mark isRetry = true so failure is permanent this time
    });
}

// ── Final Supabase Flush ──────────────────────────────────────────────────────
if (supabaseClient && supabaseBuffer.length > 0) {
    await flushToSupabase(supabaseBuffer);
}

log.info('All profiles processed. Scraper run complete.');

// ── Cleanup ───────────────────────────────────────────────────────────────────
await browser.close();
await Actor.exit();
