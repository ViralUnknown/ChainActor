import { Actor, log } from 'apify';
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import { setTimeout } from 'node:timers/promises';
import fs from 'node:fs';

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

// Handle Playwright internal CDP assertions (e.g. Duplicate target) gracefully
process.on('uncaughtException', (err) => {
    if (err.message && err.message.includes('Duplicate target')) {
        log.warning(`[Playwright CDP Warning] Handled duplicate target event: ${err.message}`);
        return;
    }
    log.error(`Uncaught Exception: ${err.stack || err.message}`);
});

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
            serviceWorkers: 'block',
        });
    } catch (err) {
        log.warning(`Browserless connection failed (${err.message}). Falling back to container local Playwright Chrome...`);
        browser = null;
        context = null;
    }
}

if (!browser) {
    const bravePath = process.env.BRAVE_PATH || '/usr/bin/brave-browser';
    const executablePath = fs.existsSync(bravePath) ? bravePath : undefined;

    if (executablePath) {
        log.info('Launching Brave Browser with Brave Shields in container...', { executablePath });
    } else {
        log.info('Launching local Playwright Chrome in container...');
    }

    browser = await chromium.launch({
        ...(executablePath ? { executablePath } : {}),
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-blink-features=AutomationControlled',
            '--enable-features=BraveShields',
        ],
    });
    context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        serviceWorkers: 'block',
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
const page = await context.newPage();
const INSPIRATION_URL = 'https://x.com/i/jf/creators/inspiration/top_posts';
log.info(`Navigating to: ${INSPIRATION_URL}`);

try {
    await page.goto(INSPIRATION_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
} catch (e) {
    log.warning(`Navigation warning: ${e.message}. Continuing...`);
}
await setTimeout(4000);

// ── Step 2: Ensure Country is Nigeria ─────────────────────────────────────────
async function ensureNigeriaSelected(page) {
    log.info('Checking if Nigeria country filter is active...');

    const getHeaderStatus = async () => {
        return await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button, div[role="button"]'));
            const trigger = buttons.find((b) => {
                const txt = (b.textContent || '').trim();
                return txt.includes('NGA') || txt.includes('EN') || txt.includes('All Countries') || txt.includes('Country') || txt.includes('Filter') || txt.includes('💬') || txt.includes('🌎');
            });
            const text = trigger ? trigger.textContent.trim() : '';
            return {
                text,
                isNga: text.includes('NGA') || text.includes('🇳🇬 NGA') || text.includes('🇳🇬'),
            };
        });
    };

    let headerStatus = await getHeaderStatus();
    log.info(`Country filter header button status: "${headerStatus.text}" (isNga: ${headerStatus.isNga})`);

    if (headerStatus.isNga) {
        log.info('✓ Nigeria filter already active.');
        return;
    }

    log.info('Nigeria filter not active. Opening filter modal...');
    for (let attempt = 1; attempt <= 3; attempt++) {
        log.info(`Nigeria selection attempt ${attempt}/3...`);
        try {
            // 1. Open filter modal if not open
            const isModalOpen = await page.evaluate(() => !!document.querySelector('div[role="dialog"], [aria-modal="true"]'));
            if (!isModalOpen) {
                await page.evaluate(() => {
                    const buttons = Array.from(document.querySelectorAll('button, div[role="button"]'));
                    const trigger = buttons.find((b) => {
                        const txt = (b.textContent || '').trim();
                        return txt.includes('NGA') || txt.includes('EN') || txt.includes('All Countries') || txt.includes('Country') || txt.includes('Filter') || txt.includes('💬') || txt.includes('🌎');
                    });
                    if (trigger) trigger.click();
                });
                await setTimeout(2000);
            }

            // 2. Ensure "Country" tab inside modal is active
            await page.evaluate(() => {
                const modal = document.querySelector('div[role="dialog"], [aria-modal="true"]') || document.body;
                const buttons = Array.from(modal.querySelectorAll('button, div[role="button"], span'));
                const countryTab = buttons.find((b) => {
                    const txt = (b.textContent || '').trim();
                    return txt === 'Country' || txt.includes('Country') || txt.includes('🌎');
                });
                if (countryTab) countryTab.click();
            });
            await setTimeout(2000);

            // 3. Scroll to and click Nigeria option in modal list
            const ngLocator = page.locator('text="Nigeria"').first();
            if (await ngLocator.count() > 0) {
                await ngLocator.scrollIntoViewIfNeeded().catch(() => {});
                await setTimeout(500);
                await ngLocator.click({ force: true }).catch(() => {});
            }

            // Fallback JS click on Nigeria row/button/span inside modal
            await page.evaluate(() => {
                const modal = document.querySelector('div[role="dialog"], [aria-modal="true"]') || document.body;
                const elements = Array.from(modal.querySelectorAll('*'));
                const ngElem = elements.find((el) => {
                    const txt = (el.textContent || '').trim();
                    return (txt === 'Nigeria' || txt.includes('Nigeria')) && el.children.length === 0;
                });
                if (ngElem) {
                    const clickTarget = ngElem.closest('button, [role="button"], [role="option"], div') || ngElem;
                    clickTarget.scrollIntoView?.({ block: 'center' });
                    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(evtType => {
                        clickTarget.dispatchEvent(new MouseEvent(evtType, { bubbles: true, cancelable: true, view: window }));
                    });
                }
            });
            await setTimeout(2500);

            // 4. Close modal if still visible
            await page.evaluate(() => {
                const closeBtn = document.querySelector('button[aria-label="Close"], button span svg[data-icon="icon-close"]')?.closest('button');
                if (closeBtn) closeBtn.click();
            });
            await setTimeout(3000);

            // 5. Check Header Status Confirmation
            headerStatus = await getHeaderStatus();
            log.info(`After attempt ${attempt}, header button status: "${headerStatus.text}" (isNga: ${headerStatus.isNga})`);
            if (headerStatus.isNga) {
                log.info(`✓ Verified header button updated to "${headerStatus.text}". Nigeria country filter selected successfully.`);
                return;
            }
        } catch (err) {
            log.warning(`Attempt ${attempt} failed with error: ${err.message}`);
        }
    }

    if (!headerStatus.isNga) {
        log.warning(`❌ Nigeria filter could not be verified. Header button status remains: "${headerStatus.text}". Proceeding...`);
    }
}

await ensureNigeriaSelected(page);

// ── Step 3: Sort by Most Replies ───────────────────────────────────────────────
async function setSortToMostReplies(page) {
    log.info('Setting sort to Most Replies...');
    try {
        const switched = await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            const repliesBtn = buttons.find((b) => (b.textContent || '').trim().includes('Most Replies'));
            if (repliesBtn) { repliesBtn.click(); return true; }
            return false;
        });
        if (switched) {
            await setTimeout(4000);
            log.info('✓ "Most Replies" sort applied successfully.');
        } else {
            log.warning('Could not find "Most Replies" button.');
        }
    } catch (e) {
        log.warning(`Could not switch sort: ${e.message}`);
    }
}

await setSortToMostReplies(page);

// ── Step 3.5: Capture & Store Navigation Screenshot ──────────────────────────
try {
    const screenshot = await page.screenshot({ type: 'png' });
    await Actor.setValue('INSPIRATION_FILTERED.png', screenshot, { contentType: 'image/png' });
    log.info('✓ Saved screenshot to Key-Value store artifact: INSPIRATION_FILTERED.png');
} catch (screenErr) {
    log.warning(`Could not save screenshot artifact: ${screenErr.message}`);
}

// ── Step 4: Harvest Post URLs from Inspiration Timeline ────────────────────────
log.info(`Harvesting up to ${maxPosts} posts from filtered Inspiration timeline...`);
const targetPosts = [];
const targetPostIds = new Set();
let scrollAttempts = 0;

while (targetPosts.length < maxPosts && scrollAttempts < 20) {
    const batch = await page.evaluate(() => {
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

    for (const p of batch) {
        if (targetPosts.length >= maxPosts) break;
        if (!targetPostIds.has(p.postId) && !alreadyScrapedPostIds.has(p.postId)) {
            targetPostIds.add(p.postId);
            targetPosts.push(p);
        }
    }

    if (targetPosts.length >= maxPosts) break;

    log.info(`Found ${targetPosts.length}/${maxPosts} target posts. Scrolling timeline...`);
    await page.evaluate(() => window.scrollBy(0, 1500));
    await setTimeout(3000);
    scrollAttempts++;
}

log.info(`✓ Collected ${targetPosts.length} posts to scrape.`);

// ── Step 5: Scrape Commenters from Each Post (Using Single Page) ─────────────
async function scrapePostCommenters(page, postUrl, postId) {
    log.info(`[Post ${postId}] Opening: ${postUrl}`);
    const scrapedCommenters = new Map();

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

        await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

        let tweetsFound = false;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                await page.waitForSelector('[data-testid="tweet"]', { timeout: 10000 });
                tweetsFound = true;
                break;
            } catch {
                log.info(`[Post ${postId}] Waiting for tweets (attempt ${attempt + 1}/3)...`);
                await page.evaluate(() => window.scrollBy(0, 300));
                await setTimeout(3000);
            }
        }

        if (!tweetsFound) {
            log.warning(`[Post ${postId}] No tweets found after 3 attempts. Skipping.`);
            return;
        }

        await setTimeout(3000);

        let consecutiveEmptyScrolls = 0;
        let lastHeight = 0;
        let atBottom = false;

        while (consecutiveEmptyScrolls < 3 && !atBottom) {
            const currentBatch = await page.evaluate(() => {
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

            const { newScrollHeight, reachedBottom } = await page.evaluate(() => {
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
            log.warning(`[Post ${postId}] Browser session closed mid-scrape. Streamed ${scrapedCommenters.size} usernames before disconnect.`);
        } else {
            log.error(`[Post ${postId}] Error: ${msg}`);
        }
    }
}

let completedCount = 0;
for (const post of targetPosts) {
    await scrapePostCommenters(page, post.url, post.postId);
    completedCount++;
    log.info(`Progress: ${completedCount}/${targetPosts.length} posts completed.`);
}

log.info(`Actor 1 finished. Completed ${completedCount} posts.`);
await browser.close();
await Actor.exit();
