import { Actor, log } from 'apify';
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import { setTimeout } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── Graceful Abort Handling ──────────────────────────────────────────────────
Actor.on('aborting', async () => {
    log.warning('Actor aborting signal received. Persisting state and exiting...');
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
    maxRetries = 1,
    supabaseUrl = process.env.AIS_SUPABASE_URL || process.env.SUPABASE_URL,
    supabaseAnonKey = process.env.AIS_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY,
} = input;

log.info('Starting Actor 2: About Location Filter Scraper with Multi-Cookie Rotation Pool', {
    batchSize,
    delayBetweenRequests,
    maxRetries,
});

// ── Supabase Client ──────────────────────────────────────────────────────────
if (!supabaseUrl || !supabaseAnonKey) {
    log.error('Supabase credentials missing. Actor 2 requires Supabase to read and update leads.');
    await Actor.exit();
}

const supabase = createClient(supabaseUrl, supabaseAnonKey);

// ── Cookie Parsing Helper ────────────────────────────────────────────────────
function parseRawCookies(inputCookie, index = 0) {
    let rawString = '';
    let alias = `Account #${index + 1}`;

    if (typeof inputCookie === 'object' && inputCookie !== null) {
        if (Array.isArray(inputCookie.cookies)) {
            return {
                cookies: inputCookie.cookies,
                alias: inputCookie.alias || alias,
            };
        }
        rawString = inputCookie.cookie_string || inputCookie.cookies || '';
        alias = inputCookie.alias || alias;
    } else if (typeof inputCookie === 'string') {
        rawString = inputCookie;
    }

    if (!rawString || !rawString.trim()) {
        return { cookies: [], alias };
    }

    const parsedCookies = rawString
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

    return { cookies: parsedCookies, alias };
}

// Build multi-cookie rotation pool
const rawList = Array.isArray(rawCookiesInput) ? rawCookiesInput : (rawCookiesInput ? [rawCookiesInput] : []);
const cookiePool = rawList
    .map((item, idx) => parseRawCookies(item, idx))
    .filter((entry) => entry.cookies.length > 0);

// Direct auth_token & ct0 inputs as priority slot if provided
if (auth_token || ct0) {
    const directCookies = [];
    if (auth_token) {
        directCookies.push({
            name: 'auth_token',
            value: auth_token.trim(),
            domain: '.x.com',
            path: '/',
            secure: true,
            sameSite: 'Lax',
        });
    }
    if (ct0) {
        directCookies.push({
            name: 'ct0',
            value: ct0.trim(),
            domain: '.x.com',
            path: '/',
            secure: true,
            sameSite: 'Lax',
        });
    }
    if (directCookies.length > 0) {
        cookiePool.unshift({ cookies: directCookies, alias: 'Primary (Direct auth_token/ct0)' });
    }
}

log.info(`Configured multi-cookie pool with ${cookiePool.length} account session(s).`);
if (cookiePool.length === 0) {
    log.warning('No session cookies provided. Unauthenticated requests to X.com /about may hit rate limits quickly.');
}

// ── 46 to 49 Shuffle Threshold Generator ─────────────────────────────────────
// X has a strict ~50 request rate limit on /about.
// We shuffle between 46 and 49 (46, 47, 48, or 49) before rotating to the next account.
function getRandomRotationThreshold() {
    return 46 + Math.floor(Math.random() * 4);
}

// ── Persistent Browser Context Creation ──────────────────────────────────────
const braveExecutablePath = process.env.BRAVE_PATH || '/usr/bin/brave-browser';
const executablePath = fs.existsSync(braveExecutablePath) ? braveExecutablePath : undefined;

async function createBravePersistentContext(cookieData, sessionIndex) {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `brave-session-${sessionIndex}-${Date.now()}-`));
    const alias = cookieData?.alias || `Session #${sessionIndex + 1}`;

    log.info(`[${alias}] Launching persistent browser context...`, {
        executable: executablePath || 'Playwright Chromium',
        userDataDir,
    });

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

    // Inject cookies
    if (cookieData?.cookies?.length > 0) {
        await context.addCookies(cookieData.cookies);
        log.info(`[${alias}] Injected ${cookieData.cookies.length} cookies.`);
    }

    // Block images, media, fonts for fast lightweight scraping
    await context.route('**/*', (route) => {
        const type = route.request().resourceType();
        if (['image', 'media', 'font'].includes(type)) {
            return route.abort();
        }
        return route.continue();
    });

    // Warm-up: load x.com/home so cookies are committed to persistent session
    if (cookieData?.cookies?.length > 0) {
        const warmupPage = await context.newPage();
        try {
            await warmupPage.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 25000 });
            log.info(`[${alias}] Session warm-up completed successfully.`);
        } catch {
            log.debug(`[${alias}] Session warm-up timed out — proceeding.`);
        } finally {
            await warmupPage.close().catch(() => {});
        }
    }

    return { context, userDataDir, alias };
}

async function cleanupSession(sessionObj) {
    if (!sessionObj) return;
    try {
        if (sessionObj.context) {
            await sessionObj.context.close().catch(() => {});
        }
    } catch {}
    if (sessionObj.userDataDir) {
        try {
            fs.rmSync(sessionObj.userDataDir, { recursive: true, force: true });
        } catch {}
    }
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

// ── Scrape Single About Profile ──────────────────────────────────────────────
async function scrapeAboutProfile(context, username, alias) {
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });

    try {
        const targetUrl = `https://x.com/${username}/about`;
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

        const currentUrl = page.url();
        // Detect login redirect or auth wall
        if (currentUrl.includes('/i/flow/login') || currentUrl.includes('/login')) {
            return {
                username,
                isRateLimited: true,
                errorMessage: 'Redirected to login page (session expired or unauthenticated)',
            };
        }

        // Wait for pivot elements
        try {
            await page.waitForSelector('[data-testid="pivot"]', { timeout: 12000 });
        } catch {
            await setTimeout(2000);
        }

        // Check if rate limited message or error banner is visible
        const pageText = await page.evaluate(() => document.body?.innerText || '');
        if (
            pageText.includes('Rate limit exceeded') ||
            pageText.includes('Something went wrong, but don’t fret') ||
            pageText.includes('Cannot load account information')
        ) {
            return {
                username,
                isRateLimited: true,
                errorMessage: 'Rate limit or temporary X error detected on page',
            };
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

        return {
            username,
            accountBasedIn: profileData.accountBasedIn || 'N/A',
            connectedVia: profileData.connectedVia || 'N/A',
            isRateLimited: false,
        };
    } catch (err) {
        return {
            username,
            accountBasedIn: 'Error',
            connectedVia: 'Error',
            isRateLimited: false,
            errorMessage: err.message,
        };
    } finally {
        await page.close().catch(() => {});
    }
}

// ── Multi-Rotable Session Pool Controller ────────────────────────────────────
let cookieIndex = 0;
let profileCounter = 0;
let nextRotationAt = getRandomRotationThreshold();

let currentSession = await createBravePersistentContext(
    cookiePool[cookieIndex],
    cookieIndex
);

log.info(`Initial session active: [${currentSession.alias}]. Will rotate after ${nextRotationAt} profiles (46-49 shuffle).`);

async function rotateToNextCookie(reason = 'Threshold reached') {
    if (cookiePool.length <= 1) {
        log.warning(`Rotation triggered (${reason}), but only 1 cookie account is in pool. Re-initializing current session...`);
        await cleanupSession(currentSession);
        await setTimeout(2000);
        currentSession = await createBravePersistentContext(cookiePool[0], 0);
        profileCounter = 0;
        nextRotationAt = getRandomRotationThreshold();
        return;
    }

    const previousAlias = currentSession.alias;
    await cleanupSession(currentSession);

    cookieIndex = (cookieIndex + 1) % cookiePool.length;
    const nextCookie = cookiePool[cookieIndex];

    profileCounter = 0;
    nextRotationAt = getRandomRotationThreshold();

    log.info(`[ROTATION] ${reason}. Rotating from [${previousAlias}] -> [${nextCookie.alias}]. Next shuffle at ${nextRotationAt} profiles.`);
    currentSession = await createBravePersistentContext(nextCookie, cookieIndex);
}

// ── Processing Loop ──────────────────────────────────────────────────────────
let processedCount = 0;
let keptCount = 0;
let deletedCount = 0;
const retryQueue = [];

for (let i = 0; i < pendingUsers.length; i++) {
    const userRow = pendingUsers[i];
    const username = userRow.username;

    log.info(`[${i + 1}/${pendingUsers.length}] [${currentSession.alias}] (Req ${profileCounter + 1}/${nextRotationAt}) Checking @${username}/about ...`);

    let result = await scrapeAboutProfile(currentSession.context, username, currentSession.alias);

    // If rate limited or login redirect, rotate session immediately and retry this user once
    if (result.isRateLimited) {
        log.warning(`[RATE-LIMIT] @${username} hit rate limit / auth wall with [${currentSession.alias}]: ${result.errorMessage}.`);
        await rotateToNextCookie('Hit rate limit / auth wall');
        log.info(`Retrying @${username} immediately using newly rotated session [${currentSession.alias}]...`);
        result = await scrapeAboutProfile(currentSession.context, username, currentSession.alias);
    }

    // If still rate limited or error occurred, push to retryQueue and don't hard-delete yet
    if (result.isRateLimited || result.accountBasedIn === 'Error') {
        log.warning(`Could not confirm location for @${username} (${result.errorMessage || 'Error'}). Enqueued for retry pass.`);
        retryQueue.push(username);
        profileCounter++;
        processedCount++;
        continue;
    }

    const accountBasedIn = result.accountBasedIn;
    const connectedVia = result.connectedVia;

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
        // Confirmed non-Nigerian: hard delete from Supabase
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

    profileCounter++;
    processedCount++;

    // Check if 46-49 shuffle threshold has been reached
    if (profileCounter >= nextRotationAt) {
        await rotateToNextCookie(`Reached ${profileCounter} profiles (within 46-49 shuffle range)`);
    }

    if (delayBetweenRequests > 0) {
        await setTimeout(delayBetweenRequests);
    }
}

// ── Retry Pass for Failed Handles ────────────────────────────────────────────
if (retryQueue.length > 0 && maxRetries > 0) {
    log.info(`Starting retry pass for ${retryQueue.length} failed/rate-limited handles...`);
    // Rotate to fresh cookie before starting retry pass
    await rotateToNextCookie('Starting retry pass');

    for (const username of retryQueue) {
        log.info(`[RETRY] [${currentSession.alias}] Checking @${username}/about ...`);
        const result = await scrapeAboutProfile(currentSession.context, username, currentSession.alias);

        if (result.isRateLimited || result.accountBasedIn === 'Error') {
            log.error(`[RETRY FAILED] @${username} still failed on retry: ${result.errorMessage || 'Unknown error'}. Leaving as pending in Supabase.`);
            continue;
        }

        const accountBasedIn = result.accountBasedIn;
        const connectedVia = result.connectedVia;
        const isNigerian =
            accountBasedIn.toLowerCase().includes('nigeria') ||
            connectedVia.toLowerCase().includes('nigeria');

        if (isNigerian) {
            log.info(`[RETRY PASS] @${username} verified as Nigerian! Updating Supabase.`);
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
            log.info(`[RETRY DELETE] @${username} confirmed non-Nigerian. Hard deleting.`);
            await supabase.from('commenter_usernames').delete().eq('username', username);
            await Actor.pushData({
                username,
                accountBasedIn,
                connectedVia,
                isNigerian: false,
                action: 'hard_deleted',
            });
            deletedCount++;
        }

        profileCounter++;
        if (profileCounter >= nextRotationAt) {
            await rotateToNextCookie(`Reached shuffle limit (${profileCounter}) during retry pass`);
        }
        await setTimeout(delayBetweenRequests);
    }
}

// ── Cleanup & Exit ───────────────────────────────────────────────────────────
await cleanupSession(currentSession);

log.info('====================================================');
log.info(`Actor 2 completed successfully.`);
log.info(`Total Processed: ${processedCount}`);
log.info(`Kept (Nigerian): ${keptCount}`);
log.info(`Deleted (Non-Nigerian): ${deletedCount}`);
log.info(`Pending Retries Remaining: ${retryQueue.length}`);
log.info('====================================================');

await Actor.exit();
