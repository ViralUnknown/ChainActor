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

// Initialize Apify SDK
await Actor.init();

// Fetch input parameters defined in input_schema.json
const input = (await Actor.getInput()) || {};
const {
    usernames = [],
    cookies: rawCookiesInput = [],
    delayBetweenRequests = 1600,
    batchSize = 25,
    executionMode = 'sequential',
    regionFilter = '',
    maxRetries = 1,
    auth_token = '',
    ct0 = '',
    supabaseUrl = process.env.AIS_SUPABASE_URL || process.env.SUPABASE_URL,
    supabaseAnonKey = process.env.AIS_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
} = input;

if (!Array.isArray(usernames) || usernames.length === 0) {
    log.error('No target usernames provided in input schema.');
    await Actor.exit();
}

// Normalise handles — accepts plain handles, @handles, or full x.com/twitter.com profile URLs
function extractUsername(raw) {
    if (typeof raw !== 'string') return raw;
    const s = raw.trim();
    // Extract username segment from x.com or twitter.com URLs (ignores trailing paths like /about)
    const urlMatch = s.match(/(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]+)/i);
    if (urlMatch) return urlMatch[1];
    // Strip any number of leading @ symbols
    return s.replace(/^@+/, '');
}

const normalizedUsernames = usernames
    .map(extractUsername)
    .filter((u) => u && u.length > 0);

log.info(`Starting About Info Scraper for ${normalizedUsernames.length} target handles...`, {
    executionMode,
    delayBetweenRequests,
    batchSize,
    maxRetries
});

// ── Initialize Supabase Client (Optional Cloud Stream Persistence) ─────────
let supabaseClient = null;
if (supabaseUrl && supabaseAnonKey) {
    try {
        supabaseClient = createClient(supabaseUrl, supabaseAnonKey);
        log.info('Supabase client initialized successfully for cloud streaming.');
    } catch (err) {
        log.warning(`Failed to initialize Supabase client: ${err.message}`);
    }
}

// ── Cookie Parsing Helper ────────────────────────────────────────────────────
function parseRawCookies(inputCookie) {
    let rawString = '';
    let alias = 'Default Account';

    if (typeof inputCookie === 'object' && inputCookie !== null) {
        if (Array.isArray(inputCookie.cookies)) return inputCookie;
        rawString = inputCookie.cookie_string || inputCookie.cookies || '';
        alias = inputCookie.alias || alias;
    } else if (typeof inputCookie === 'string') {
        rawString = inputCookie;
    }

    if (!rawString || !rawString.trim()) return { cookies: [], origins: [], alias };

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
                sameSite: 'Lax'
            };
        })
        .filter((c) => c !== null);

    return { cookies: parsedCookies, origins: [], alias };
}

// Prepare cookie pool
let cookiePool = (Array.isArray(rawCookiesInput) ? rawCookiesInput : [rawCookiesInput])
    .map(parseRawCookies)
    .filter((s) => s.cookies.length > 0);

if (auth_token || ct0) {
    const directCookies = [];
    if (auth_token) directCookies.push({ name: 'auth_token', value: auth_token.trim(), domain: '.x.com', path: '/', secure: true, sameSite: 'Lax' });
    if (ct0) directCookies.push({ name: 'ct0', value: ct0.trim(), domain: '.x.com', path: '/', secure: true, sameSite: 'Lax' });
    
    // Unshift to make it the primary cookie slot
    if (directCookies.length > 0) {
        cookiePool.unshift({ cookies: directCookies, origins: [], alias: 'Direct Auth/CT0' });
    }
}

if (cookiePool.length === 0) {
    log.warning('No session cookies or auth_token/ct0 provided. Unauthenticated requests to X.com may be limited or redirected to login.');
}

// ── Safe Navigation Helper ───────────────────────────────────────────────────
async function safeGoto(page, url, timeout = 90000) {
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    } catch (e) {
        if (e.message && e.message.includes('Timeout')) {
            log.warning(`Navigation timeout for ${url} — proceeding with DOM evaluation.`);
        } else {
            throw e;
        }
    }
}

// ── Persistent Brave Context ─────────────────────────────────────────────────
// Each cookie slot gets its own isolated profile directory under /tmp/brave_sessions/
// so concurrent workers never share the same directory and hit lock conflicts.
async function createBravePersistentContext(cookieData, sessionIndex) {
    // 1. Unique temporary per-session directory — prevents Brave's profile lock conflicts
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `brave-session-${sessionIndex}-`));

    // 2. Brave executable — falls back to env override for local testing
    const braveExecutablePath = process.env.BRAVE_PATH || '/usr/bin/brave-browser';

    log.info(`Launching Brave persistent context for session #${sessionIndex}`, {
        userDataDir,
        braveExecutablePath
    });

    // 3. launchPersistentContext replaces both chromium.launch() and browser.newContext()
    const context = await chromium.launchPersistentContext(userDataDir, {
        executablePath: braveExecutablePath,
        headless: true, // Must be true inside standard Docker/Apify containers
        args: [
            '--disable-dev-shm-usage',
            '--no-sandbox',
            '--disable-gpu',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled'
        ]
    });

    // 4. Inject cookies directly into this isolated persistent session
    if (cookieData && cookieData.cookies && cookieData.cookies.length > 0) {
        await context.addCookies(cookieData.cookies);
        log.debug(`Injected ${cookieData.cookies.length} cookies into session #${sessionIndex}.`);
    }

    // 5. Block non-essential heavy resources (RAM optimisation — same as before)
    await context.route('**/*', (route) => {
        const url = route.request().url();
        if (url.includes('x.com') || url.includes('twitter.com')) {
            const type = route.request().resourceType();
            if (['image', 'media', 'font', 'other'].includes(type)) {
                return route.abort();
            }
        }
        return route.continue();
    });

    // 6. Session warm-up: load x.com/home so cookies are fully committed to the session
    //    before any profile scraping begins. Without this, fresh temp dirs can miss
    //    cookie data on the very first navigation causing N/A results.
    if (cookieData && cookieData.cookies && cookieData.cookies.length > 0) {
        const warmupPage = await context.newPage();
        try {
            await warmupPage.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 30000 });
            log.debug(`Session #${sessionIndex} warm-up complete.`);
        } catch {
            log.debug(`Session #${sessionIndex} warm-up timed out — proceeding anyway.`);
        } finally {
            await warmupPage.close().catch(() => {});
        }
    }

    return context;
}

// ── Single Profile Scraper ───────────────────────────────────────────────────
async function scrapeSingleAbout(context, username, accountAlias = 'Account') {
    if (!username) return null;

    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });

    let scrapedResult = null;

    try {
        const targetUrl = `https://x.com/${username}/about`;
        await safeGoto(page, targetUrl);

        try {
            await page.waitForSelector('[data-testid="pivot"]', { timeout: 20000 });
        } catch {
            await setTimeout(3000);
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

        scrapedResult = {
            username,
            accountBasedIn: profileData.accountBasedIn || 'N/A',
            connectedVia: profileData.connectedVia || 'N/A',
            scrapedAt: new Date().toISOString()
        };
    } catch (err) {
        log.error(`[${accountAlias}] Error scraping about info for @${username}: ${err.message}`);
        scrapedResult = {
            username,
            accountBasedIn: 'Error',
            connectedVia: 'Error',
            scrapedAt: new Date().toISOString()
        };
    } finally {
        await page.close().catch(() => {});
    }

    // ── Save to Apify Dataset ────────────────────────────────────────────────
    if (scrapedResult) {
        await Actor.pushData(scrapedResult);
        log.info(`Scraped @${username} — Based in: "${scrapedResult.accountBasedIn}" | Connected via: "${scrapedResult.connectedVia}"`);
    }

    // ── Direct Supabase Cloud Stream (Optional) ──────────────────────────────
    if (scrapedResult && supabaseClient) {
        try {
            const { error } = await supabaseClient.from('about_info_results').upsert(
                {
                    username: scrapedResult.username,
                    account_based_in: scrapedResult.accountBasedIn,
                    connected_via: scrapedResult.connectedVia,
                    scraped_at: scrapedResult.scrapedAt
                },
                { onConflict: 'username' }
            );

            if (error) {
                log.error(`[Supabase] Upsert error for @${username}: ${error.message}`);
            } else {
                log.info(`[Supabase] Streamed @${username} to cloud DB.`);
            }
        } catch (dbErr) {
            log.error(`[Supabase] Exception: ${dbErr.message}`);
        }
    }

    return scrapedResult;
}

// ── Parallel Core Runner ─────────────────────────────────────────────────────
async function runParallelScraper(targetUsernames, concurrency = 5) {
    const results = [];
    // Thread-safe copy of target usernames queue
    const queue = [...targetUsernames];

    log.info(`Launching ${concurrency} concurrent Brave workers...`);

    // Define individual worker thread function
    async function workerThread(workerId) {
        // Assign distinct initial cookie session to worker if available
        let cookieIndex = workerId % (cookiePool.length || 1);
        let currentStorage = cookiePool.length > 0 ? cookiePool[cookieIndex] : null;

        // Launch an isolated Brave Persistent Context for THIS specific worker
        let context = await createBravePersistentContext(currentStorage, workerId);

        let profileCounter = 0;
        let nextRotationAt = 43 + Math.floor(Math.random() * 7);

        try {
            while (queue.length > 0) {
                // Safely pull the next handle from the shared queue
                const username = queue.shift();
                if (!username) break;

                // Handle session cookie rotation per worker independently
                if (profileCounter > 0 && cookiePool.length > 0 && profileCounter >= nextRotationAt) {
                    log.info(`[Worker ${workerId + 1}] Rotating session cookie after ${profileCounter} profiles...`);
                    await context.close().catch(() => {});

                    cookieIndex = (cookieIndex + 1) % cookiePool.length;
                    context = await createBravePersistentContext(cookiePool[cookieIndex], workerId);

                    profileCounter = 0;
                    nextRotationAt = 43 + Math.floor(Math.random() * 7);
                }

                const currentAlias = cookiePool[cookieIndex]?.alias || `Worker #${workerId + 1}`;
                
                // Scrape profile
                const data = await scrapeSingleAbout(context, username, currentAlias);
                if (data) {
                    results.push(data);
                }

                profileCounter++;
                await setTimeout(delayBetweenRequests);
            }
        } catch (err) {
            log.error(`[Worker ${workerId + 1}] Uncaught error: ${err.message}`);
        } finally {
            if (context) {
                await context.close().catch(() => {});
            }
            
            // Clean up the temporary directory
            if (context && context._options && context._options.userDataDir) {
                 try {
                     fs.rmSync(context._options.userDataDir, { recursive: true, force: true });
                 } catch (rmErr) {
                     // Ignore cleanup errors
                 }
            }

            log.info(`[Worker ${workerId + 1}] Finished work and context closed.`);
        }
    }

    // Spawn N workers with a 5-second stagger delay between worker initializations
    const workerPromises = Array.from({ length: concurrency }, async (_, i) => {
        if (i > 0) {
            log.info(`[Worker ${i + 1}] Waiting ${i * 5}s before launching...`);
            await setTimeout(i * 5000);
        }
        return workerThread(i);
    });
    
    // Wait for all workers to complete their assigned queues
    await Promise.all(workerPromises);

    return results;
}

// ── Main Execution ───────────────────────────────────────────────────────────
const CONCURRENCY = executionMode === 'parallel' ? 5 : 1;
let allResults = await runParallelScraper(normalizedUsernames, CONCURRENCY);

// ── Retry Logic for Failed / N/A Profiles ─────────────────────────────────────
for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const failedTargets = allResults
        .filter((r) => r.accountBasedIn === 'Error' || (r.accountBasedIn === 'N/A' && r.connectedVia === 'N/A'))
        .map((r) => r.username);

    if (failedTargets.length === 0) break;

    log.info(`Retry pass #${attempt}: Retrying ${failedTargets.length} handles returning N/A or Error...`);
    await setTimeout(2000);

    const retryResults = await runParallelScraper(failedTargets, CONCURRENCY);
    const retryMap = new Map(retryResults.map((r) => [r.username, r]));
    allResults = allResults.map((r) => (retryMap.has(r.username) ? retryMap.get(r.username) : r));
}

// ── Optional Region Filter ────────────────────────────────────────────────────
if (regionFilter && regionFilter.trim() !== '') {
    const targetRegion = regionFilter.trim().toLowerCase();
    const filteredResults = allResults.filter(
        (item) => item.accountBasedIn && item.accountBasedIn.toLowerCase().includes(targetRegion)
    );
    log.info(`Filtered results by region "${regionFilter}": ${filteredResults.length}/${allResults.length} matched.`);
}

log.info('About Info Scraper run completed successfully.');

// Graceful exit
await Actor.exit();