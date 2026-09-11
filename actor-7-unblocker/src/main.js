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
    maxProfilesToProcess = 30,
    daysThreshold = 3, // Exactly 3 days unblock delay
    delayBetweenUnblocks = 3000,
    cookies: rawCookiesInput = [],
    auth_token = '',
    ct0 = '',
    supabaseUrl = process.env.AIS_SUPABASE_URL || process.env.SUPABASE_URL,
    supabaseAnonKey = process.env.AIS_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY,
} = input;

log.info(`Starting Actor 7: Unblocker (Checking accounts blocked >= ${daysThreshold} days ago)`, {
    maxProfilesToProcess,
    daysThreshold,
});

if (!supabaseUrl || !supabaseAnonKey) {
    log.error('Supabase credentials missing. Actor 7 requires Supabase connection.');
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

// ── Query Candidates: Blocked >= 3 days ago and unblocked_at IS NULL ──────────
const cutoffDate = new Date(Date.now() - daysThreshold * 24 * 60 * 60 * 1000).toISOString();
log.info(`Looking for accounts blocked before: ${cutoffDate} with unblocked_at IS NULL...`);

const { data: candidates, error: queryErr } = await supabase
    .from('follow_log')
    .select('id, username, blocked_at')
    .not('blocked_at', 'is', null)
    .lt('blocked_at', cutoffDate)
    .is('unblocked_at', null)
    .limit(maxProfilesToProcess);

if (queryErr) {
    log.error(`Supabase query error: ${queryErr.message}`);
    await Actor.exit();
}

if (!candidates || candidates.length === 0) {
    log.info(`No accounts found blocked >= ${daysThreshold} days ago needing unblock. Done.`);
    await Actor.exit();
}

log.info(`Found ${candidates.length} accounts eligible to unblock.`);

// ── Launch Browser Persistent Context ─────────────────────────────────────────
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brave-actor7-'));
const braveExecutablePath = process.env.BRAVE_PATH || '/usr/bin/brave-browser';
const executablePath = fs.existsSync(braveExecutablePath) ? braveExecutablePath : undefined;

const context = await chromium.launchPersistentContext(userDataDir, {
    ...(executablePath ? { executablePath } : {}),
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
let unblockedCount = 0;

for (const candidate of candidates) {
    const username = candidate.username;
    const profileUrl = `https://x.com/${username}`;

    log.info(`Visiting @${username} to unblock (blocked on ${candidate.blocked_at})...`);

    try {
        await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
        await setTimeout(3000);

        // Check if "Blocked" button is directly visible on profile or in userActions
        const unblockedDirectly = await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            const blockedBtn = buttons.find((b) => (b.textContent || '').trim().toLowerCase() === 'blocked');
            if (blockedBtn) {
                blockedBtn.click();
                return true;
            }
            return false;
        });

        let confirmNeeded = unblockedDirectly;

        if (!unblockedDirectly) {
            // Check in userActions menu
            const moreBtn = await page.waitForSelector('[data-testid="userActions"]', { timeout: 6000 }).catch(() => null);
            if (moreBtn) {
                await moreBtn.click();
                await setTimeout(1000);

                const unblockClicked = await page.evaluate(() => {
                    const menuItems = Array.from(document.querySelectorAll('[role="menuitem"]'));
                    const unblockItem = menuItems.find((el) => {
                        const txt = (el.textContent || '').toLowerCase();
                        return txt.includes('unblock @') || txt.startsWith('unblock');
                    });
                    if (unblockItem) {
                        unblockItem.click();
                        return true;
                    }
                    return false;
                });

                if (unblockClicked) {
                    confirmNeeded = true;
                } else {
                    await page.keyboard.press('Escape');
                }
            }
        }

        if (confirmNeeded) {
            await setTimeout(1000);
            const confirmBtn = await page.waitForSelector('[data-testid="confirmationSheetConfirm"]', { timeout: 6000 }).catch(() => null);
            if (confirmBtn) {
                await confirmBtn.click();
                await setTimeout(1000);
            }

            const nowIso = new Date().toISOString();
            log.info(`[UNBLOCKED] Successfully unblocked @${username}!`);

            await supabase
                .from('follow_log')
                .update({ unblocked_at: nowIso })
                .eq('id', candidate.id);

            await supabase
                .from('commenter_usernames')
                .update({ status: 'unblocked' })
                .eq('username', username);

            await Actor.pushData({
                username,
                action: 'unblocked',
                unblockedAt: nowIso,
            });
            unblockedCount++;
        } else {
            log.warning(`[@${username}] Neither "Blocked" button nor unblock menu option found. Account might already be unblocked.`);
            // Mark as unblocked in DB so it doesn't get stuck forever
            await supabase
                .from('follow_log')
                .update({ unblocked_at: new Date().toISOString() })
                .eq('id', candidate.id);
        }
    } catch (err) {
        log.error(`Error unblocking @${username}: ${err.message}`);
    }

    await setTimeout(delayBetweenUnblocks);
}

log.info(`Actor 7 finished. Unblocked: ${unblockedCount} accounts.`);
await context.close();
await Actor.exit();
