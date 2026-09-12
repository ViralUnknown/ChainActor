import { Actor, log } from 'apify';
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import { setTimeout } from 'node:timers/promises';
import fs from 'node:fs';

// ── Graceful Abort Handling ──────────────────────────────────────────────────
Actor.on('aborting', async () => {
    log.warning('Actor aborting signal received. Exiting gracefully...');
    await setTimeout(1000);
    await Actor.exit();
});

await Actor.init();

const input = (await Actor.getInput()) || {};
const {
    maxPosts = 10,
    verificationFilter = 'both', // 'verified' | 'unverified' | 'both'
    cookies: rawCookiesInput = [],
    auth_token = '',
    ct0 = '',
    delayBetweenScrolls = 1800,
    supabaseUrl = process.env.AIS_SUPABASE_URL || process.env.SUPABASE_URL,
    supabaseAnonKey = process.env.AIS_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY,
} = input;

log.info('Starting Actor 1: Nigerian Creator Inspiration Commenter Scraper', {
    maxPosts,
    verificationFilter,
    delayBetweenScrolls,
});

// ── Supabase Initialization ──────────────────────────────────────────────────
let supabase = null;
if (supabaseUrl && supabaseAnonKey) {
    try {
        supabase = createClient(supabaseUrl, supabaseAnonKey);
        log.info('Supabase client initialized successfully.');
    } catch (err) {
        log.error(`Supabase init failed: ${err.message}`);
    }
} else {
    log.warning('No Supabase credentials provided.');
}

// ── Cookie Parsing Helper ────────────────────────────────────────────────────
function parseCookies(inputCookie) {
    if (typeof inputCookie === 'object' && inputCookie !== null) {
        if (inputCookie.name && inputCookie.value) {
            return [{
                name: inputCookie.name,
                value: inputCookie.value,
                domain: inputCookie.domain || '.x.com',
                path: inputCookie.path || '/',
                secure: inputCookie.secure ?? true,
                sameSite: inputCookie.sameSite === 'no_restriction' ? 'None' : 'Lax',
            }];
        }
        if (Array.isArray(inputCookie.cookies)) return inputCookie.cookies;
        const rawString = inputCookie.cookie_string || inputCookie.cookies || '';
        return parseCookies(rawString);
    }

    const rawString = typeof inputCookie === 'string' ? inputCookie : '';
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
    cookiesToInject.push({ name: 'auth_token', value: auth_token.trim(), domain: '.x.com', path: '/', secure: true, sameSite: 'Lax' });
}
if (ct0) {
    cookiesToInject.push({ name: 'ct0', value: ct0.trim(), domain: '.x.com', path: '/', secure: true, sameSite: 'Lax' });
}

// ── Launch Brave Browser (Local Container) ─────────────────────────────────────
// No Browserless.io - always use local browser in container
const bravePath = process.env.BRAVE_PATH || '/usr/bin/brave-browser';
const executablePath = fs.existsSync(bravePath) ? bravePath : undefined;

if (executablePath) {
    log.info('Launching Brave Browser in container...', { executablePath });
} else {
    log.info('Brave not found. Launching Playwright Chromium...');
}

const browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    headless: true,
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
    ],
});

const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    serviceWorkers: 'block',
});

// Inject cookies
if (cookiesToInject.length > 0) {
    await context.addCookies(cookiesToInject);
    log.info(`Injected ${cookiesToInject.length} cookies into browser context.`);
}

// Block heavy media on all pages
await context.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (['image', 'media', 'font'].includes(type)) return route.abort();
    return route.continue();
});

// ── Check Already Scraped Posts from Supabase ─────────────────────────────────
const alreadyScrapedPostIds = new Set();
if (supabase) {
    try {
        const { data, error } = await supabase.from('scraped_posts').select('post_id');
        if (!error && data) {
            for (const row of data) alreadyScrapedPostIds.add(row.post_id);
            log.info(`Found ${alreadyScrapedPostIds.size} existing post IDs in Supabase (will skip these).`);
        }
    } catch (e) {
        log.warning(`Could not fetch existing scraped_posts: ${e.message}`);
    }
}

// ── Step 1: Open Master Tab (stays open the whole run) ─────────────────────────
const masterTab = await context.newPage();
const INSPIRATION_URL = 'https://x.com/i/jf/creators/inspiration/top_posts';
log.info(`Navigating to: ${INSPIRATION_URL}`);

try {
    await masterTab.goto(INSPIRATION_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
} catch (e) {
    log.warning(`Navigation warning: ${e.message}. Continuing...`);
}
await setTimeout(5000);

// ── Step 2: Ensure NGA Country Filter Is Active ────────────────────────────────
// Reference (CodeSnippets.txt):
//   NGA button selector: button.jf4o1ez2  -> <p>🇳🇬 NGA</p>
//   Nigeria list row: <button> containing two separate <p> elements: one "🇳🇬", one "Nigeria"
//   Close button: svg[data-icon="icon-close"] inside a button
async function ensureNigeriaSelected(page) {
    log.info('Checking if Nigeria (🇳🇬 NGA) filter is active...');

    const getNgaButtonText = async () => page.evaluate(() => {
        const ngaBtn = document.querySelector('button.jf4o1ez2');
        return ngaBtn ? ngaBtn.textContent.trim() : '';
    });

    let headerText = await getNgaButtonText();
    log.info(`NGA filter button text: "${headerText}"`);

    const isNga = (txt) => txt.includes('NGA') || txt.includes('\uD83C\uDDF3\uD83C\uDDEC NGA');

    if (isNga(headerText)) {
        log.info('✓ Nigeria (🇳🇬 NGA) filter already active.');
        return;
    }

    for (let attempt = 1; attempt <= 3; attempt++) {
        log.info(`Nigeria selection attempt ${attempt}/3...`);
        try {
            // 1. Click the country header button to open modal
            const opened = await page.evaluate(() => {
                const ngaBtn = document.querySelector('button.jf4o1ez2');
                if (ngaBtn) { ngaBtn.click(); return true; }
                return false;
            });

            if (!opened) {
                log.warning('Country filter button (button.jf4o1ez2) not found. Retrying...');
                await setTimeout(2000);
                continue;
            }

            await setTimeout(2500);

            // 2. Click the "Country" tab (CodeSnippets shows it has <p>Country</p> inside)
            await page.evaluate(() => {
                const allButtons = Array.from(document.querySelectorAll('button'));
                const countryTab = allButtons.find((b) => {
                    const paras = Array.from(b.querySelectorAll('p'));
                    return paras.some((p) => p.textContent.trim() === 'Country');
                });
                if (countryTab) countryTab.click();
            });

            await setTimeout(2000);

            // 3. Click the Nigeria button
            // CodeSnippets: it has two <p> children — one with just "🇳🇬" and one with "Nigeria"
            const clickedNg = await page.evaluate(() => {
                const allButtons = Array.from(document.querySelectorAll('button'));
                const nigeriaBtn = allButtons.find((b) => {
                    const paras = Array.from(b.querySelectorAll('p'));
                    const hasFlag = paras.some((p) => p.textContent.trim() === '\uD83C\uDDF3\uD83C\uDDEC');
                    const hasText = paras.some((p) => p.textContent.trim() === 'Nigeria');
                    return hasFlag && hasText;
                });
                if (nigeriaBtn) {
                    nigeriaBtn.scrollIntoView({ block: 'center' });
                    nigeriaBtn.click();
                    return true;
                }
                return false;
            });

            if (!clickedNg) {
                log.warning('Nigeria button not found in list. Closing modal and retrying...');
                await page.evaluate(() => {
                    const closeBtn = document.querySelector('svg[data-icon="icon-close"]')?.closest('button');
                    if (closeBtn) closeBtn.click();
                });
                await setTimeout(2000);
                continue;
            }

            log.info('✓ Clicked Nigeria option.');
            await setTimeout(3000);

            // 4. Close modal
            await page.evaluate(() => {
                const closeBtn = document.querySelector('svg[data-icon="icon-close"]')?.closest('button');
                if (closeBtn) closeBtn.click();
            });
            await setTimeout(3000);

            // 5. Confirm header now shows NGA
            headerText = await getNgaButtonText();
            log.info(`After attempt ${attempt}, NGA button text: "${headerText}"`);

            if (isNga(headerText)) {
                log.info(`✓ Confirmed: header shows "${headerText}". Nigeria filter active!`);
                return;
            }

        } catch (err) {
            log.warning(`Nigeria selection attempt ${attempt} error: ${err.message}`);
        }
    }

    log.warning(`❌ Nigeria filter NOT confirmed after 3 attempts. Header: "${headerText}". Proceeding...`);
}

await ensureNigeriaSelected(masterTab);

// ── Step 3: Sort by Most Replies ───────────────────────────────────────────────
// HTML (from CodeSnippets): <button type="button" class="jf-element">...<p class="jf-element">Most Replies</p>...
// Unselected svg: data-icon="icon-reply-stroke" | Selected svg: data-icon="icon-reply"
async function setSortToMostReplies(page) {
    log.info('Setting sort to Most Replies...');

    // Check if it's already selected: selected button has svg data-icon="icon-reply" (filled, no "-stroke")
    const isMostRepliesSelected = async () => page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(
            (b) => Array.from(b.querySelectorAll('p')).some((p) => p.textContent.trim() === 'Most Replies')
        );
        if (!btn) return false;
        const svg = btn.querySelector('svg[data-icon]');
        return svg ? svg.getAttribute('data-icon') === 'icon-reply' : false;
    });

    if (await isMostRepliesSelected()) {
        log.info('✓ Most Replies already selected.');
        return;
    }

    // Use Playwright locator to directly click the "Most Replies" button
    // The button is: <button type="button" class="jf-element"> containing <p>Most Replies</p>
    try {
        const repliesBtn = page.locator('button:has(p:text-is("Most Replies"))').first();
        await repliesBtn.waitFor({ state: 'visible', timeout: 8000 });
        await repliesBtn.click();
        log.info('✓ Clicked "Most Replies" button via locator.');
    } catch {
        // Fallback: JS click
        log.info('Locator click failed, trying JS fallback...');
        await page.evaluate(() => {
            const btn = Array.from(document.querySelectorAll('button')).find(
                (b) => Array.from(b.querySelectorAll('p')).some((p) => p.textContent.trim() === 'Most Replies')
            );
            if (btn) btn.click();
        });
    }

    await setTimeout(4000);

    if (await isMostRepliesSelected()) {
        log.info('✓ "Most Replies" sort confirmed active (svg icon-reply detected).');
    } else {
        log.warning('"Most Replies" clicked but svg icon not yet "icon-reply". Page may still re-rendering — proceeding.');
    }
}

await setSortToMostReplies(masterTab);

// ── Step 3.5: Save Screenshot ──────────────────────────────────────────────────
try {
    const screenshot = await masterTab.screenshot({ type: 'png' });
    await Actor.setValue('INSPIRATION_FILTERED.png', screenshot, { contentType: 'image/png' });
    log.info('✓ Saved screenshot: INSPIRATION_FILTERED.png');
} catch (screenErr) {
    log.warning(`Could not save screenshot: ${screenErr.message}`);
}

// ── Step 4: Harvest Post URLs from Master Tab ──────────────────────────────────
// Scroll the master tab to find all target posts FIRST, then scrape them
log.info(`Harvesting up to ${maxPosts} post URLs from filtered timeline...`);
const targetPosts = [];
const seenPostIds = new Set();
let harvestScrolls = 0;

while (targetPosts.length < maxPosts && harvestScrolls < 25) {
    const batch = await masterTab.evaluate(() => {
        const links = Array.from(document.querySelectorAll('article[data-testid="tweet"] a[href*="/status/"]'));
        const found = [];
        for (const a of links) {
            const href = a.getAttribute('href') || '';
            const match = href.match(/([A-Za-z0-9_]+)\/status\/(\d+)/);
            if (match) {
                // Build clean URL without query params
                const cleanUrl = `https://x.com/${match[1]}/status/${match[2]}`;
                found.push({ url: cleanUrl, postId: match[2] });
            }
        }
        return found;
    });

    for (const p of batch) {
        if (targetPosts.length >= maxPosts) break;
        if (!seenPostIds.has(p.postId) && !alreadyScrapedPostIds.has(p.postId)) {
            seenPostIds.add(p.postId);
            targetPosts.push(p);
        }
    }

    if (targetPosts.length >= maxPosts) break;

    log.info(`Found ${targetPosts.length}/${maxPosts} posts. Scrolling master tab...`);
    await masterTab.evaluate(() => window.scrollBy(0, 1500));
    await setTimeout(3000);
    harvestScrolls++;
}

log.info(`✓ Collected ${targetPosts.length} target posts.`);

// ── Step 5: Scrape Each Post Using a Temporary Tab ────────────────────────────
// Master tab stays untouched. For each post:
//   open new temp tab → navigate → scroll & scrape → stream to Supabase → close tab
async function scrapePostCommenters(context, postUrl, postId) {
    log.info(`[Post ${postId}] Opening temp tab: ${postUrl}`);
    const scrapedCommenters = new Map();
    let postTab = null;

    try {
        if (supabase) {
            const { error: postErr } = await supabase.from('scraped_posts').upsert({
                post_id: postId,
                post_url: postUrl,
                scraped_at: new Date().toISOString(),
                commenter_count: 0,
            });
            if (postErr) log.warning(`[Supabase] scraped_posts note: ${postErr.message}`);
        }

        // Open a brand-new temporary tab
        postTab = await context.newPage();
        await postTab.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

        let tweetsFound = false;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                await postTab.waitForSelector('[data-testid="tweet"]', { timeout: 10000 });
                tweetsFound = true;
                break;
            } catch {
                log.info(`[Post ${postId}] Waiting for tweets (attempt ${attempt + 1}/3)...`);
                await postTab.evaluate(() => window.scrollBy(0, 300));
                await setTimeout(3000);
            }
        }

        if (!tweetsFound) {
            log.warning(`[Post ${postId}] No tweets found. Skipping.`);
            return;
        }

        await setTimeout(3000);

        let consecutiveEmptyScrolls = 0;
        let lastHeight = 0;
        let atBottom = false;

        while (consecutiveEmptyScrolls < 3 && !atBottom) {
            const currentBatch = await postTab.evaluate(() => {
                const tweets = Array.from(document.querySelectorAll('[data-testid="tweet"]'));
                const commentTweets = tweets.length > 1 ? tweets.slice(1) : [];
                const list = [];

                for (const t of commentTweets) {
                    const userNameEl = t.querySelector('[data-testid="User-Name"]');
                    if (!userNameEl) continue;

                    const userLink = userNameEl.querySelector('a[href^="/"]');
                    const rawHref = userLink ? userLink.getAttribute('href') : '';
                    let username = rawHref.startsWith('/') ? rawHref.slice(1).split('/')[0].trim().toLowerCase() : '';

                    if (!username) {
                        const txt = userNameEl.textContent || '';
                        const match = txt.match(/@([A-Za-z0-9_]+)/);
                        if (match) username = match[1].toLowerCase();
                    }

                    if (!username || username === 'i') continue;

                    const isVerified = !!(
                        t.querySelector('[data-testid="icon-verified"]') ||
                        t.querySelector('[data-icon="icon-verified"]') ||
                        t.querySelector('[aria-label="Verified account"]') ||
                        t.querySelector('svg[aria-label="Verified account"]')
                    );

                    list.push({ username, isVerified });
                }
                return { items: list, totalTweets: tweets.length };
            });

            const commenters = currentBatch.items ?? [];
            log.info(`[Post ${postId}] Scroll batch: ${currentBatch.totalTweets} tweets, ${commenters.length} parsed.`);

            const newBatch = [];
            for (const user of commenters) {
                if (verificationFilter === 'verified' && !user.isVerified) continue;
                if (verificationFilter === 'unverified' && user.isVerified) continue;
                if (!scrapedCommenters.has(user.username)) {
                    scrapedCommenters.set(user.username, user);
                    newBatch.push(user);
                }
            }

            if (supabase && newBatch.length > 0) {
                const rows = newBatch.map((c) => ({
                    username: c.username,
                    is_verified: c.isVerified,
                    source_post_id: postId,
                    status: 'pending',
                    scraped_at: new Date().toISOString(),
                }));

                const { error: streamErr } = await supabase
                    .from('commenter_usernames')
                    .upsert(rows, { onConflict: 'username', ignoreDuplicates: true });

                if (streamErr) {
                    log.warning(`[Supabase] Stream error: ${streamErr.message}`);
                } else {
                    log.info(`[Supabase] ✓ Streamed ${newBatch.length} new usernames (post total: ${scrapedCommenters.size}).`);
                }

                for (const row of rows) await Actor.pushData(row);
            }

            const { newScrollHeight, reachedBottom } = await postTab.evaluate(() => {
                window.scrollBy(0, 1200);
                return {
                    newScrollHeight: document.body.scrollHeight,
                    reachedBottom: (window.scrollY + window.innerHeight) >= (document.body.scrollHeight - 50),
                };
            });

            await setTimeout(delayBetweenScrolls);
            atBottom = reachedBottom;

            if (newBatch.length === 0 && newScrollHeight === lastHeight) {
                consecutiveEmptyScrolls++;
            } else {
                consecutiveEmptyScrolls = 0;
            }
            lastHeight = newScrollHeight;
        }

        log.info(`[Post ${postId}] ✓ Done. Scraped ${scrapedCommenters.size} unique commenters.`);

        if (supabase) {
            await supabase.from('scraped_posts').upsert({
                post_id: postId,
                post_url: postUrl,
                scraped_at: new Date().toISOString(),
                commenter_count: scrapedCommenters.size,
            });
        }

    } catch (err) {
        log.error(`[Post ${postId}] Error: ${err.message}`);
    } finally {
        // Always close the temp tab to free resources
        if (postTab && !postTab.isClosed()) {
            await postTab.close().catch(() => {});
            log.info(`[Post ${postId}] Temp tab closed.`);
        }
    }
}

// ── Run Scraping Loop ──────────────────────────────────────────────────────────
let completedCount = 0;
for (const post of targetPosts) {
    await scrapePostCommenters(context, post.url, post.postId);
    completedCount++;
    log.info(`Progress: ${completedCount}/${targetPosts.length} posts completed.`);
}

log.info(`Actor 1 finished. Completed ${completedCount}/${targetPosts.length} posts.`);
await masterTab.close().catch(() => {});
await browser.close();
await Actor.exit();
