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
    batchSize = 100,
    concurrency = 5,
    delayBetweenRequests = 1600,
    cookies: rawCookiesInput = [],
    auth_token = '',
    ct0 = '',
    maxRetries = 1,
    supabaseUrl = process.env.AIS_SUPABASE_URL || process.env.SUPABASE_URL,
    supabaseAnonKey = process.env.AIS_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY,
} = input;

log.info('Starting Actor 2: Parallel Multi-Browser About Location Scraper', {
    batchSize,
    concurrency,
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
// Each parallel worker rotates cookies every 46, 47, 48, or 49 profiles.
function getRandomRotationThreshold() {
    return 46 + Math.floor(Math.random() * 4);
}

// ── Persistent Browser Context Creation per Worker ───────────────────────────
const braveExecutablePath = process.env.BRAVE_PATH || '/usr/bin/brave-browser';
const executablePath = fs.existsSync(braveExecutablePath) ? braveExecutablePath : undefined;

async function createWorkerPersistentContext(cookieData, workerId) {
    // Unique per-worker persistent directory to prevent locks across concurrent instances
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `brave-w${workerId}-${Date.now()}-`));
    const alias = cookieData?.alias || `Worker #${workerId + 1}`;

    log.info(`[Worker ${workerId + 1}] Launching isolated browser context for [${alias}]...`, {
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

    // Inject cookies into this isolated worker session
    if (cookieData?.cookies?.length > 0) {
        await context.addCookies(cookieData.cookies);
        log.debug(`[Worker ${workerId + 1}] Injected ${cookieData.cookies.length} cookies.`);
    }

    // Resource blocking: abort heavy media/fonts to save RAM and accelerate parallel tabs
    await context.route('**/*', (route) => {
        const type = route.request().resourceType();
        if (['image', 'media', 'font'].includes(type)) {
            return route.abort();
        }
        return route.continue();
    });

    // Session warm-up: load x.com/home so cookies are committed to persistent disk storage
    if (cookieData?.cookies?.length > 0) {
        const warmupPage = await context.newPage();
        try {
            await warmupPage.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 25000 });
            log.debug(`[Worker ${workerId + 1}] Session warm-up complete for [${alias}].`);
        } catch {
            log.debug(`[Worker ${workerId + 1}] Session warm-up timed out — proceeding.`);
        } finally {
            await warmupPage.close().catch(() => {});
        }
    }

    return { context, userDataDir, alias };
}

async function cleanupWorkerSession(sessionObj) {
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

// ── Single Profile Scraper ───────────────────────────────────────────────────
async function scrapeAboutProfile(context, username, workerLabel) {
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });

    try {
        const targetUrl = `https://x.com/${username}/about`;
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

        const currentUrl = page.url();
        // Check for login wall or redirect
        if (currentUrl.includes('/i/flow/login') || currentUrl.includes('/login')) {
            return {
                username,
                isRateLimited: true,
                errorMessage: 'Redirected to login wall',
            };
        }

        try {
            await page.waitForSelector('[data-testid="pivot"]', { timeout: 12000 });
        } catch {
            await setTimeout(1500);
        }

        // Check for rate limit or error banners on page
        const pageText = await page.evaluate(() => document.body?.innerText || '');
        if (
            pageText.includes('Rate limit exceeded') ||
            pageText.includes('Something went wrong, but don’t fret') ||
            pageText.includes('Cannot load account information')
        ) {
            return {
                username,
                isRateLimited: true,
                errorMessage: 'Rate limit or error message on page',
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

log.info(`Found ${pendingUsers.length} pending profiles to process in parallel.`);

// ── Shared State & Statistics ────────────────────────────────────────────────
let processedCount = 0;
let keptCount = 0;
let deletedCount = 0;
const retryQueue = [];

// ── Parallel Worker Architecture ─────────────────────────────────────────────
async function runParallelScraper(targetList, numWorkers) {
    // Thread-safe work queue
    const queue = [...targetList];
    const actualConcurrency = Math.min(numWorkers, queue.length) || 1;

    log.info(`Spawning ${actualConcurrency} parallel Brave worker(s) across shared queue of ${queue.length} handles...`);

    async function workerThread(workerId) {
        // Assign distinct initial cookie slot to worker
        let cookieIndex = workerId % (cookiePool.length || 1);
        let currentStorage = cookiePool.length > 0 ? cookiePool[cookieIndex] : null;

        // Launch an isolated persistent browser context for this worker
        let session = await createWorkerPersistentContext(currentStorage, workerId);

        let profileCounter = 0;
        let nextRotationAt = getRandomRotationThreshold();

        log.info(`[Worker ${workerId + 1}] Online with [${session.alias}]. Will rotate after ${nextRotationAt} profiles (46-49 shuffle).`);

        try {
            while (queue.length > 0) {
                const userRow = queue.shift();
                if (!userRow) break;

                const username = typeof userRow === 'string' ? userRow : userRow.username;

                // 46-49 Shuffle: Rotate session cookie for this worker independently
                if (profileCounter > 0 && cookiePool.length > 1 && profileCounter >= nextRotationAt) {
                    log.info(`[Worker ${workerId + 1}] Reached ${profileCounter} profiles (46-49 shuffle). Rotating cookie session...`);
                    await cleanupWorkerSession(session);

                    cookieIndex = (cookieIndex + 1) % cookiePool.length;
                    session = await createWorkerPersistentContext(cookiePool[cookieIndex], workerId);

                    profileCounter = 0;
                    nextRotationAt = getRandomRotationThreshold();
                    log.info(`[Worker ${workerId + 1}] Switched to [${session.alias}]. Next rotation at ${nextRotationAt}.`);
                }

                log.info(`[Worker ${workerId + 1}] [${session.alias}] (Req ${profileCounter + 1}/${nextRotationAt} | Remaining: ${queue.length}) -> @${username}/about`);

                let result = await scrapeAboutProfile(session.context, username, `Worker #${workerId + 1}`);

                // Rate-limit auto-rotation: if rate limited or redirected to login, rotate this worker immediately
                if (result.isRateLimited) {
                    log.warning(`[Worker ${workerId + 1}] [RATE-LIMIT] @${username} triggered limit/auth wall on [${session.alias}]: ${result.errorMessage}. Rotating immediately...`);
                    await cleanupWorkerSession(session);

                    cookieIndex = (cookieIndex + 1) % (cookiePool.length || 1);
                    session = await createWorkerPersistentContext(cookiePool[cookieIndex], workerId);

                    profileCounter = 0;
                    nextRotationAt = getRandomRotationThreshold();

                    log.info(`[Worker ${workerId + 1}] Retrying @${username} with fresh rotated session [${session.alias}]...`);
                    result = await scrapeAboutProfile(session.context, username, `Worker #${workerId + 1}`);
                }

                // If still rate limited or errored out, enqueue for retry pass — do NOT hard delete
                if (result.isRateLimited || result.accountBasedIn === 'Error') {
                    log.warning(`[Worker ${workerId + 1}] Could not confirm @${username} (${result.errorMessage || 'Error'}). Added to retry queue.`);
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
                    log.info(`[Worker ${workerId + 1}] [PASS] @${username} is Nigerian! (Based: "${accountBasedIn}", Connected: "${connectedVia}")`);
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
                    log.info(`[Worker ${workerId + 1}] [DELETE] @${username} is non-Nigerian (Based: "${accountBasedIn}", Connected: "${connectedVia}"). Hard deleting from DB.`);
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

                if (delayBetweenRequests > 0) {
                    await setTimeout(delayBetweenRequests);
                }
            }
        } catch (err) {
            log.error(`[Worker ${workerId + 1}] Fatal worker error: ${err.message}`);
        } finally {
            await cleanupWorkerSession(session);
            log.info(`[Worker ${workerId + 1}] Finished queue tasks and shut down.`);
        }
    }

    // Spawn N workers with a 4-second stagger delay between startup to avoid CPU/RAM spikes
    const workerPromises = Array.from({ length: actualConcurrency }, async (_, i) => {
        if (i > 0) {
            log.info(`[Worker ${i + 1}] Staggering startup: waiting ${i * 4}s...`);
            await setTimeout(i * 4000);
        }
        return workerThread(i);
    });

    await Promise.all(workerPromises);
}

// ── Run Primary Parallel Scrape ──────────────────────────────────────────────
await runParallelScraper(pendingUsers, concurrency);

// ── Retry Pass for Failed Handles ────────────────────────────────────────────
if (retryQueue.length > 0 && maxRetries > 0) {
    log.info(`Starting retry pass for ${retryQueue.length} failed/rate-limited handles using 2 workers...`);
    const retryTargets = [...retryQueue];
    retryQueue.length = 0; // Reset queue
    await setTimeout(3000);
    await runParallelScraper(retryTargets, Math.min(2, concurrency));
}

log.info('====================================================');
log.info(`Actor 2 completed successfully.`);
log.info(`Total Processed: ${processedCount}`);
log.info(`Kept (Nigerian): ${keptCount}`);
log.info(`Deleted (Non-Nigerian): ${deletedCount}`);
log.info(`Failed/Unresolved Retries: ${retryQueue.length}`);
log.info('====================================================');

await Actor.exit();
