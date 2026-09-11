import { Actor, log } from 'apify';
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import { setTimeout } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

Actor.on('aborting', async () => {
    log.warning('Actor aborting signal received. Exiting gracefully...');
    await setTimeout(1000);
    await Actor.exit();
});

await Actor.init();

const input = (await Actor.getInput()) || {};
const {
    followsPerRun = 8,
    delaySeconds = 60,
    cookies: rawCookiesInput = [],
    auth_token = '',
    ct0 = '',
    supabaseUrl = process.env.AIS_SUPABASE_URL || process.env.SUPABASE_URL,
    supabaseAnonKey = process.env.AIS_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY,
} = input;

log.info('Starting Actor 5: Follow Actor (Cron Run)', { followsPerRun, delaySeconds });

if (!supabaseUrl || !supabaseAnonKey) {
    log.error('Supabase credentials missing. Follow actor requires Supabase connection.');
    await Actor.exit();
}

const supabase = createClient(supabaseUrl, supabaseAnonKey);

// ── Cookie Parsing Helper ────────────────────────────────────────────────────
function parseCookies(inputCookie) {
    let rawString = '';
    if (typeof inputCookie === 'object' && inputCookie !== null) {
        if (Array.isArray(inputCookie.cookies)) return inputCookie.cookies;
        rawString = inputCookie.cookie_string || inputCookie.cookies || '';
    } else if (typeof inputCookie === 'string') {
        rawString = inputCookie;
    }

    if (!rawString.trim()) return [];

    return rawString
        .split(';')
        .map((c) => c.trim())
        .filter((c) => c.length > 0)
        .map((c) => {
            const idx = c.indexOf('=');
            if (idx === -1) return null;
            return {
                name: c.substring(0, idx).trim(),
                value: c.substring(idx + 1).trim(),
                domain: '.x.com',
                path: '/',
                secure: true,
                sameSite: 'Lax',
            };
        })
        .filter((c) => c !== null);
}

let cookiesToInject = [];
if (Array.isArray(rawCookiesInput)) {
    for (const item of rawCookiesInput) {
        cookiesToInject.push(...parseCookies(item));
    }
} else if (rawCookiesInput) {
    cookiesToInject.push(...parseCookies(rawCookiesInput));
}

if (auth_token) {
    cookiesToInject.push({
        name: 'auth_token',
        value: auth_token.trim(),
        domain: '.x.com',
        path: '/',
        secure: true,
        sameSite: 'Lax',
    });
}
if (ct0) {
    cookiesToInject.push({
        name: 'ct0',
        value: ct0.trim(),
        domain: '.x.com',
        path: '/',
        secure: true,
        sameSite: 'Lax',
    });
}

// ── Query Candidates: Lowest follower count first ────────────────────────────
log.info(`Querying up to ${followsPerRun} ready_to_follow accounts (ordered by follower_count ASC)...`);
const { data: candidates, error: queryErr } = await supabase
    .from('commenter_usernames')
    .select('username, follower_count')
    .eq('status', 'ready_to_follow')
    .order('follower_count', { ascending: true })
    .limit(followsPerRun);

if (queryErr) {
    log.error(`Supabase query error: ${queryErr.message}`);
    await Actor.exit();
}

if (!candidates || candidates.length === 0) {
    log.info('No accounts ready to follow in Supabase. Exiting run.');
    await Actor.exit();
}

log.info(`Found ${candidates.length} candidates to follow this run.`);

// ── Launch Master Brave Instance ─────────────────────────────────────────────
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brave-actor5-'));
const braveExecutablePath = process.env.BRAVE_PATH || '/usr/bin/brave-browser';

const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: braveExecutablePath,
    headless: true,
    args: [
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
    ],
});

if (cookiesToInject.length > 0) {
    await context.addCookies(cookiesToInject);
    log.info(`Injected ${cookiesToInject.length} cookies.`);
}

await context.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (['image', 'media', 'font'].includes(type)) {
        return route.abort();
    }
    return route.continue();
});

const page = await context.newPage();
let successfulFollows = 0;

for (let i = 0; i < candidates.length; i++) {
    const { username, follower_count } = candidates[i];
    const profileUrl = `https://x.com/${username}`;

    log.info(`[${i + 1}/${candidates.length}] Visiting @${username} (Followers: ${follower_count}) ...`);

    try {
        await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
        await setTimeout(3000);

        // Check if rate limited or suspended
        const isRateLimited = await page.evaluate(() => {
            const body = document.body.innerText || '';
            return (
                body.includes('Rate limit exceeded') ||
                body.includes('You are unable to follow more people at this time') ||
                body.includes('Something went wrong')
            );
        });

        if (isRateLimited) {
            log.warning('Rate limit or restriction modal detected! Aborting follow run early to protect account.');
            break;
        }

        // Find Follow button
        const followState = await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('[data-testid$="-follow"], [data-testid$="-unfollow"], button'));
            for (const b of buttons) {
                const txt = (b.textContent || '').trim();
                const testId = b.getAttribute('data-testid') || '';
                if (testId.endsWith('-unfollow') || txt === 'Following' || txt === 'Requested') {
                    return 'already_following';
                }
                if (testId.endsWith('-follow') || txt === 'Follow') {
                    b.click();
                    return 'clicked';
                }
            }
            return 'not_found';
        });

        if (followState === 'clicked') {
            log.info(`[FOLLOWED] Successfully followed @${username}!`);
            successfulFollows++;

            // Update status in commenter_usernames
            await supabase
                .from('commenter_usernames')
                .update({ status: 'following' })
                .eq('username', username);

            // Log follow event in follow_log
            await supabase.from('follow_log').insert({
                username,
                followed_at: new Date().toISOString(),
                follows_back: false,
            });

            await Actor.pushData({
                username,
                status: 'followed',
                timestamp: new Date().toISOString(),
            });
        } else if (followState === 'already_following') {
            log.info(`[@${username}] Already following. Updating status.`);
            await supabase
                .from('commenter_usernames')
                .update({ status: 'following' })
                .eq('username', username);
        } else {
            log.warning(`[@${username}] Could not locate follow button.`);
        }
    } catch (err) {
        log.error(`Error processing follow for @${username}: ${err.message}`);
    }

    // Delay between follows if not the last one
    if (i < candidates.length - 1) {
        log.info(`Waiting ${delaySeconds} seconds before next follow action...`);
        await setTimeout(delaySeconds * 1000);
    }
}

log.info(`Actor 5 run finished. Followed ${successfulFollows} accounts.`);
await context.close();
await Actor.exit();
