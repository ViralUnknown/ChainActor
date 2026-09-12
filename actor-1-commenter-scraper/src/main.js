import { Actor, log } from 'apify';
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import { setTimeout } from 'node:timers/promises';

// ── Graceful Abort Handling ──────────────────────────────────────────────────
Actor.on('aborting', async () => {
    log.warning('Actor aborting signal received. Saving state and exiting...');
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
    browserlessApiKey = process.env.BROWSERLESS_API_KEY,
    browserlessEndpoint = 'wss://chrome.browserless.io/playwright',
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

// ── Connect to Browserless or Launch Local Container Browser ────────────────
let browser = null;
let context = null;

const cleanBrowserlessKey = (browserlessApiKey || process.env.BROWSERLESS_API_KEY || '').trim();

if (cleanBrowserlessKey) {
    try {
        let baseEndpoint = (browserlessEndpoint || 'wss://chrome.browserless.io').trim();
        baseEndpoint = baseEndpoint.replace(/\/playwright\/?$/, '');
        if (baseEndpoint.endsWith('/')) baseEndpoint = baseEndpoint.slice(0, -1);

        const wsEndpoint = `${baseEndpoint}?token=${cleanBrowserlessKey}&timeout=120000&stealth=true`;
        log.info(`Attempting Browserless connection...`, { endpoint: wsEndpoint.replace(cleanBrowserlessKey, '[REDACTED]') });
        browser = await chromium.connectOverCDP(wsEndpoint);
        log.info('✓ Connected to Browserless. Watch live at: https://chrome.browserless.io/sessions');
        context = await browser.newContext({
            viewport: { width: 1280, height: 900 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        });
    } catch (err) {
        log.warning(`Browserless connection failed (${err.message}). Falling back to container local Playwright Chrome...`);
        browser = null;
        context = null;
    }
}

if (!browser) {
    log.info('Launching local Playwright Chrome in container...');
    browser = await chromium.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-blink-features=AutomationControlled',
        ],
    });
    context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });
}

// Inject cookies
if (cookiesToInject.length > 0) {
    await context.addCookies(cookiesToInject);
    log.info(`Injected ${cookiesToInject.length} cookies into browser context.`);
}

// Block heavy media
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

// ── Step 1: Open Inspiration Page ─────────────────────────────────────────────
const homePage = await context.newPage();
const INSPIRATION_URL = 'https://x.com/i/jf/creators/inspiration/top_posts';
log.info(`Navigating to: ${INSPIRATION_URL}`);

try {
    await homePage.goto(INSPIRATION_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
} catch (e) {
    log.warning(`Navigation warning: ${e.message}. Continuing...`);
}
await setTimeout(4000);

// ── Step 2: Ensure Country is Nigeria ─────────────────────────────────────────
async function ensureNigeriaSelected(page) {
    log.info('Checking if Nigeria country filter is active...');

    const isAlreadyNigeria = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const ngMainBtn = buttons.find((b) => {
            const txt = b.textContent || '';
            return txt.includes('🇳🇬') || txt.includes('NGA');
        });
        if (ngMainBtn) return true;
        const ngItem = buttons.find((b) => (b.textContent || '').includes('Nigeria'));
        if (ngItem && ngItem.querySelector('svg[data-icon="icon-checkmark"]')) return true;
        return false;
    });

    if (isAlreadyNigeria) {
        log.info('Nigeria filter already active.');
        return;
    }

    log.info('Opening country menu to select Nigeria...');
    try {
        const opened = await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            const trigger = buttons.find((b) => {
                const txt = b.textContent || '';
                return txt.includes('All Countries') || txt.includes('Country') || txt.includes('🌎');
            });
            if (trigger) { trigger.click(); return true; }
            return false;
        });

        if (opened) {
            await setTimeout(2500);
            await page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button'));
                const ngOption = buttons.find((b) => {
                    const txt = b.textContent || '';
                    return txt.includes('🇳🇬') || txt.includes('Nigeria');
                });
                if (ngOption) ngOption.click();
            });
            await setTimeout(3000);
            log.info('Nigeria selected.');
        }
    } catch (e) {
        log.warning(`Country selection note: ${e.message}`);
    }
}

await ensureNigeriaSelected(homePage);

// ── Step 3: Sort by Most Replies ───────────────────────────────────────────────
async function setSortToMostReplies(page) {
    log.info('Setting sort to Most Replies...');
    try {
        const switched = await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            const repliesBtn = buttons.find((b) => (b.textContent || '').includes('Most Replies'));
            if (repliesBtn) { repliesBtn.click(); return true; }
            return false;
        });
        if (switched) {
            await setTimeout(3000);
            log.info('"Most Replies" sort applied.');
        }
    } catch (e) {
        log.warning(`Could not switch sort: ${e.message}`);
    }
}

await setSortToMostReplies(homePage);

// ── Step 4: Scrape Commenters from Each Post ───────────────────────────────────
async function scrapePostCommenters(postUrl, postId) {
    log.info(`[Post ${postId}] Opening: ${postUrl}`);
    const postTab = await context.newPage();
    const scrapedCommenters = new Map();

    try {
        // Register post in Supabase first (foreign key requirement)
        if (supabase) {
            const { error: postErr } = await supabase.from('scraped_posts').upsert({
                post_id: postId,
                post_url: postUrl,
                scraped_at: new Date().toISOString(),
                commenter_count: 0,
            });
            if (postErr) log.warning(`[Supabase] scraped_posts note: ${postErr.message}`);
        }

        await postTab.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

        // Wait for tweets to appear, retry with scroll if not found
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
            log.warning(`[Post ${postId}] No tweets found after 3 attempts. Skipping.`);
            await postTab.close();
            return;
        }

        await setTimeout(3000); // Let replies section settle

        let consecutiveEmptyScrolls = 0;
        let lastHeight = 0;
        let atBottom = false;

        while (consecutiveEmptyScrolls < 3 && !atBottom) {
            // Extract all visible commenters
            const currentBatch = await postTab.evaluate(() => {
                const tweets = Array.from(document.querySelectorAll('[data-testid="tweet"]'));
                const list = [];
                const commentTweets = tweets.length > 1 ? tweets.slice(1) : [];

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

            const commenters = currentBatch.items ?? currentBatch;
            log.info(`[Post ${postId}] Scroll batch: ${currentBatch.totalTweets} tweets, ${commenters.length} parsed.`);

            // Only new usernames this batch
            const newBatch = [];
            for (const user of commenters) {
                if (verificationFilter === 'verified' && !user.isVerified) continue;
                if (verificationFilter === 'unverified' && user.isVerified) continue;
                if (!scrapedCommenters.has(user.username)) {
                    scrapedCommenters.set(user.username, user);
                    newBatch.push(user);
                }
            }

            // ── Stream to Supabase immediately ──────────────────────────────
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

            // Scroll down and detect true bottom
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

        log.info(`[Post ${postId}] ✓ Done. Total unique commenters: ${scrapedCommenters.size}.`);

        // Update final commenter count
        if (supabase) {
            await supabase.from('scraped_posts').upsert({
                post_id: postId,
                post_url: postUrl,
                scraped_at: new Date().toISOString(),
                commenter_count: scrapedCommenters.size,
            });
        }
    } catch (err) {
        const msg = err.message || '';
        if (msg.includes('closed') || msg.includes('disconnected') || msg.includes('Target')) {
            log.warning(`[Post ${postId}] Browserless session closed mid-scrape. Streamed ${scrapedCommenters.size} usernames before disconnect.`);
        } else {
            log.error(`[Post ${postId}] Error: ${msg}`);
        }
    } finally {
        try { await postTab.close(); } catch { /* already closed */ }
    }
}

// ── Main Loop: Harvest posts from Inspiration timeline ────────────────────────
let completedPostsCount = 0;
const postUrlsSeen = new Set();
let pageScrollAttempts = 0;

while (completedPostsCount < maxPosts && pageScrollAttempts < 30) {
    const foundPosts = await homePage.evaluate(() => {
        const links = Array.from(document.querySelectorAll('article[data-testid="tweet"] a[href*="/status/"]'));
        const posts = [];
        for (const a of links) {
            const href = a.getAttribute('href') || '';
            const match = href.match(/([A-Za-z0-9_]+)\/status\/(\d+)/);
            if (match) {
                posts.push({ url: `https://x.com/${match[1]}/status/${match[2]}`, postId: match[2] });
            }
        }
        return posts;
    });

    for (const post of foundPosts) {
        if (completedPostsCount >= maxPosts) break;
        if (postUrlsSeen.has(post.postId) || alreadyScrapedPostIds.has(post.postId)) continue;

        postUrlsSeen.add(post.postId);
        alreadyScrapedPostIds.add(post.postId);

        try {
            await scrapePostCommenters(post.url, post.postId);
        } catch (outerErr) {
            const msg = outerErr.message || '';
            if (msg.includes('closed') || msg.includes('disconnected') || msg.includes('Target')) {
                log.error('Browserless browser session was closed. Cannot continue. Please re-run the actor.');
                break;
            }
            log.error(`Unexpected error on post ${post.postId}: ${msg}`);
        }
        completedPostsCount++;
        log.info(`Progress: ${completedPostsCount}/${maxPosts} posts completed.`);
    }

    if (completedPostsCount >= maxPosts) break;

    log.info('Scrolling Inspiration timeline for more posts...');
    await homePage.evaluate(() => window.scrollBy(0, 1500));
    await setTimeout(3000);
    pageScrollAttempts++;
}

log.info(`Actor 1 finished. Completed ${completedPostsCount} posts.`);
await browser.close();
await Actor.exit();
