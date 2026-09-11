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
    myUsername = '',
    maxFollowingToScan = 1000,
    cookies: rawCookiesInput = [],
    auth_token = '',
    ct0 = '',
    delayBetweenScrolls = 1800,
    supabaseUrl = process.env.AIS_SUPABASE_URL || process.env.SUPABASE_URL,
    supabaseAnonKey = process.env.AIS_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY,
} = input;

const cleanMyUsername = myUsername.replace(/^@/, '').trim().toLowerCase();
if (!cleanMyUsername) {
    log.error('myUsername is required in input (your X.com username to scan following list).');
    await Actor.exit();
}

if (!supabaseUrl || !supabaseAnonKey) {
    log.error('Supabase credentials missing. Actor 4 requires Supabase connection.');
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

// ── Launch Master Brave Instance ─────────────────────────────────────────────
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brave-actor4-'));
const braveExecutablePath = process.env.BRAVE_PATH || '/usr/bin/brave-browser';

log.info('Launching Brave Persistent Context for Following Check...', { userDataDir });
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
const targetUrl = `https://x.com/${cleanMyUsername}/following`;

log.info(`Navigating to your following list: ${targetUrl}`);
try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
} catch (e) {
    log.warning(`Navigation warning: ${e.message}. Continuing...`);
}
await setTimeout(4000);

// ── Scroll & Extract Followed Handles ─────────────────────────────────────────
const myFollowingSet = new Set();
let consecutiveEmptyScrolls = 0;
let lastCount = 0;

log.info('Scanning following list...');

while (myFollowingSet.size < maxFollowingToScan && consecutiveEmptyScrolls < 4) {
    const handles = await page.evaluate(() => {
        const cells = Array.from(document.querySelectorAll('[data-testid="UserCell"]'));
        const extracted = [];
        for (const cell of cells) {
            const link = cell.querySelector('a[href^="/"]');
            if (!link) continue;
            const href = link.getAttribute('href') || '';
            const handle = href.replace('/', '').split('/')[0].trim().toLowerCase();
            if (handle) extracted.push(handle);
        }
        return extracted;
    });

    for (const h of handles) {
        myFollowingSet.add(h);
    }

    if (myFollowingSet.size === lastCount) {
        consecutiveEmptyScrolls++;
    } else {
        consecutiveEmptyScrolls = 0;
    }
    lastCount = myFollowingSet.size;

    log.info(`Scanned ${myFollowingSet.size} accounts you follow so far...`);

    await page.evaluate(() => window.scrollBy(0, 1500));
    await setTimeout(delayBetweenScrolls);
}

log.info(`Completed scan of your following list. Total accounts you follow: ${myFollowingSet.size}`);

// ── Check Supabase ready_to_follow accounts and remove matches ────────────────
log.info("Checking Supabase 'ready_to_follow' leads against your following list...");

const { data: readyUsers, error: readyErr } = await supabase
    .from('commenter_usernames')
    .select('username')
    .eq('status', 'ready_to_follow');

if (readyErr) {
    log.error(`Supabase error reading ready_to_follow: ${readyErr.message}`);
} else if (readyUsers && readyUsers.length > 0) {
    let removedCount = 0;
    for (const row of readyUsers) {
        if (myFollowingSet.has(row.username.toLowerCase())) {
            log.info(`[ALREADY FOLLOWING] @${row.username} is already followed. Hard deleting from queue.`);
            await supabase
                .from('commenter_usernames')
                .delete()
                .eq('username', row.username);

            await Actor.pushData({
                username: row.username,
                action: 'hard_deleted_already_followed',
            });
            removedCount++;
        }
    }
    log.info(`Removed ${removedCount} already-followed accounts from ready_to_follow queue.`);
} else {
    log.info('No ready_to_follow accounts found in Supabase currently.');
}

await context.close();
await Actor.exit();
