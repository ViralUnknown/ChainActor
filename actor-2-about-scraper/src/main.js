import { Actor, log } from 'apify';
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import { setTimeout } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── Graceful Abort Handling ──────────────────────────────────────────────────
Actor.on('aborting', async () => {
    log.warning('Actor aborting signal received. Exiting gracefully...');
    await setTimeout(1000);
    await Actor.exit();
});

await Actor.init();

const input = (await Actor.getInput()) || {};
const {
    batchSize = 50,
    delayBetweenRequests = 1800,
    cookies: rawCookiesInput = [],
    auth_token = '',
    ct0 = '',
    supabaseUrl = process.env.AIS_SUPABASE_URL || process.env.SUPABASE_URL,
    supabaseAnonKey = process.env.AIS_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY,
} = input;

log.info('Starting Actor 2: About Location Filter Scraper', { batchSize, delayBetweenRequests });

// ── Supabase Client ──────────────────────────────────────────────────────────
if (!supabaseUrl || !supabaseAnonKey) {
    log.error('Supabase credentials missing. Actor 2 requires Supabase to read and update leads.');
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

// ── Fetch Pending Commenters from Supabase ───────────────────────────────────
log.info(`Fetching up to ${batchSize} pending commenter usernames from Supabase...`);
const { data: pendingUsers, error: fetchErr } = await supabase
    .from('commenter_usernames')
    .select('username')
    .eq('status', 'pending')
    .limit(batchSize);

if (fetchErr) {
    log.error(`Failed to fetch pending leads: ${fetchErr.message}`);
    await Actor.exit();
}

if (!pendingUsers || pendingUsers.length === 0) {
    log.info('No pending leads found in Supabase queue. Done.');
    await Actor.exit();
}

log.info(`Found ${pendingUsers.length} pending profiles to check.`);

// ── Launch Brave Browser Persistent Context ──────────────────────────────────
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brave-actor2-'));
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
    log.info(`Injected ${cookiesToInject.length} cookies into browser context.`);
}

// Block heavy media
await context.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (['image', 'media', 'font'].includes(type)) {
        return route.abort();
    }
    return route.continue();
});

const page = await context.newPage();

let processedCount = 0;
let keptCount = 0;
let deletedCount = 0;

for (const userRow of pendingUsers) {
    const username = userRow.username;
    const targetUrl = `https://x.com/${username}/about`;

    log.info(`[${processedCount + 1}/${pendingUsers.length}] Checking @${username}/about ...`);

    try {
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        try {
            await page.waitForSelector('[data-testid="pivot"]', { timeout: 12000 });
        } catch {
            await setTimeout(2500);
        }

        const profileData = await page.evaluate(() => {
            let accountBasedIn = '';
            let connectedVia = '';

            document.querySelectorAll('[data-testid="pivot"]').forEach((pivot) => {
                const ltrDivs = pivot.querySelectorAll('div[dir="ltr"]');
                if (ltrDivs.length >= 2) {
                    const label = ltrDivs[0].textContent.trim();
                    const val = ltrDivs[1].textContent.trim();
                    if (label === 'Account based in') {
                        accountBasedIn = val;
                    } else if (label === 'Connected via') {
                        connectedVia = val;
                    }
                }
            });

            return { accountBasedIn, connectedVia };
        });

        const accountBasedIn = profileData.accountBasedIn || 'N/A';
        const connectedVia = profileData.connectedVia || 'N/A';

        // Check if either field indicates Nigeria
        const isNigerian =
            accountBasedIn.toLowerCase().includes('nigeria') ||
            connectedVia.toLowerCase().includes('nigeria');

        if (isNigerian) {
            log.info(`[PASS] @${username} is Nigerian! Based in: "${accountBasedIn}", Connected: "${connectedVia}". Updating Supabase.`);
            await supabase
                .from('commenter_usernames')
                .update({
                    account_based_in: accountBasedIn,
                    connected_via: connectedVia,
                    is_nigerian: true,
                    status: 'about_checked',
                    about_checked_at: new Date().toISOString(),
                })
                .eq('username', username);

            await Actor.pushData({
                username,
                accountBasedIn,
                connectedVia,
                isNigerian: true,
                status: 'about_checked',
            });
            keptCount++;
        } else {
            // Hard DELETE rejected non-Nigerian accounts from Supabase as requested
            log.info(`[DELETE] @${username} is not Nigerian (Based in: "${accountBasedIn}", Connected: "${connectedVia}"). Hard deleting from DB.`);
            await supabase
                .from('commenter_usernames')
                .delete()
                .eq('username', username);

            await Actor.pushData({
                username,
                accountBasedIn,
                connectedVia,
                isNigerian: false,
                action: 'hard_deleted',
            });
            deletedCount++;
        }
    } catch (err) {
        log.error(`Error processing @${username}: ${err.message}`);
    }

    processedCount++;
    if (delayBetweenRequests > 0) {
        await setTimeout(delayBetweenRequests);
    }
}

log.info(`Actor 2 complete. Processed: ${processedCount} | Kept (Nigerian): ${keptCount} | Deleted (Non-Nigerian): ${deletedCount}`);
await context.close();
await Actor.exit();
