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
    daysThreshold = 5, // Exactly 5 days as confirmed
    delayBetweenBlocks = 3000,
    cookies: rawCookiesInput = [],
    auth_token = '',
    ct0 = '',
    supabaseUrl = process.env.AIS_SUPABASE_URL || process.env.SUPABASE_URL,
    supabaseAnonKey = process.env.AIS_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY,
} = input;

log.info(`Starting Actor 6: Blocker (Checking accounts followed >= ${daysThreshold} days ago)`, {
    maxProfilesToProcess,
    daysThreshold,
});

if (!supabaseUrl || !supabaseAnonKey) {
    log.error('Supabase credentials missing. Actor 6 requires Supabase connection.');
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

// ── Query Candidates: Followed >= 5 days ago, not yet blocked ─────────────────
const cutoffDate = new Date(Date.now() - daysThreshold * 24 * 60 * 60 * 1000).toISOString();
log.info(`Looking for accounts followed before: ${cutoffDate} with blocked_at IS NULL...`);

const { data: candidates, error: queryErr } = await supabase
    .from('follow_log')
    .select('id, username, followed_at')
    .lt('followed_at', cutoffDate)
    .is('blocked_at', null)
    .limit(maxProfilesToProcess);

if (queryErr) {
    log.error(`Supabase query error: ${queryErr.message}`);
    await Actor.exit();
}

if (!candidates || candidates.length === 0) {
    log.info(`No accounts found older than ${daysThreshold} days needing block review. Done.`);
    await Actor.exit();
}

log.info(`Found ${candidates.length} candidates to check for followback.`);

// ── Launch Browser Persistent Context ─────────────────────────────────────────
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brave-actor6-'));
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
let blockedCount = 0;
let followedBackCount = 0;

for (const candidate of candidates) {
    const username = candidate.username;
    const profileUrl = `https://x.com/${username}`;

    log.info(`Checking followback status for @${username} (followed on ${candidate.followed_at})...`);

    try {
        await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
        await setTimeout(3000);

        // 1. Check "Follows you" badge
        const followsYou = await page.evaluate(() => {
            const indicator = document.querySelector('[data-testid="userFollowIndicator"]');
            if (indicator && indicator.textContent.includes('Follows you')) return true;

            // Alternative check in profile header text
            const spans = Array.from(document.querySelectorAll('span, div'));
            return spans.some((s) => (s.textContent || '').trim() === 'Follows you');
        });

        if (followsYou) {
            log.info(`[KEEPER] @${username} FOLLOWS YOU BACK! Updating DB, skipping block.`);
            await supabase
                .from('follow_log')
                .update({ follows_back: true, checked_at: new Date().toISOString() })
                .eq('id', candidate.id);

            await supabase
                .from('commenter_usernames')
                .update({ status: 'followed_back' })
                .eq('username', username);

            followedBackCount++;
            continue;
        }

        // 2. Did NOT follow back -> Proceed with block
        log.info(`[NO FOLLOWBACK] @${username} does not follow back after ${daysThreshold} days. Initiating block...`);

        // Click user actions ("...") button
        const moreBtn = await page.waitForSelector('[data-testid="userActions"]', { timeout: 8000 }).catch(() => null);
        if (!moreBtn) {
            log.warning(`[@${username}] Could not find userActions menu.`);
            continue;
        }

        await moreBtn.click();
        await setTimeout(1000);

        // Find & click "Block @username"
        const blockClicked = await page.evaluate(() => {
            const menuItems = Array.from(document.querySelectorAll('[role="menuitem"]'));
            const blockItem = menuItems.find((el) => {
                const txt = (el.textContent || '').toLowerCase();
                return txt.includes('block @') || txt.startsWith('block');
            });
            if (blockItem) {
                blockItem.click();
                return true;
            }
            return false;
        });

        if (!blockClicked) {
            log.warning(`[@${username}] Could not find block option in menu.`);
            await page.keyboard.press('Escape');
            continue;
        }

        await setTimeout(1000);

        // Confirm modal button
        const confirmBtn = await page.waitForSelector('[data-testid="confirmationSheetConfirm"]', { timeout: 6000 }).catch(() => null);
        if (confirmBtn) {
            await confirmBtn.click();
            await setTimeout(1200);
            log.info(`[BLOCKED] Successfully blocked @${username}!`);

            const nowIso = new Date().toISOString();
            await supabase
                .from('follow_log')
                .update({
                    follows_back: false,
                    blocked_at: nowIso,
                    checked_at: nowIso,
                })
                .eq('id', candidate.id);

            await supabase
                .from('commenter_usernames')
                .update({ status: 'blocked' })
                .eq('username', username);

            await Actor.pushData({
                username,
                action: 'blocked',
                blockedAt: nowIso,
            });
            blockedCount++;
        }
    } catch (err) {
        log.error(`Error processing block for @${username}: ${err.message}`);
    }

    await setTimeout(delayBetweenBlocks);
}

log.info(`Actor 6 finished. Blocked: ${blockedCount} | Followed back & kept: ${followedBackCount}`);
await context.close();
await Actor.exit();
