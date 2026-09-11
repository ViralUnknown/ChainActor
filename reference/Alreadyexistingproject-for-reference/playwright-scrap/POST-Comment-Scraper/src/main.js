import { Actor } from 'apify';
import { PlaywrightCrawler, log } from 'crawlee';
import { setTimeout } from 'node:timers/promises';

// Initialize the Apify SDK
await Actor.init();

// Handle graceful aborting
Actor.on('aborting', async () => {
    log.warning('Aborting event received, exiting gracefully...');
    await setTimeout(1000);
    await Actor.exit();
});

const input = await Actor.getInput();
const startUrls = input?.startUrls || [];
const auth_token = input?.auth_token || '';
const ct0 = input?.ct0 || '';
const maxComments = input?.maxComments || 10;

if (!startUrls.length) {
    log.error('No startUrls provided. Exiting.');
    await Actor.exit();
}

if (!auth_token || !ct0) {
    log.error('Both auth_token and ct0 cookies must be provided. Exiting.');
    await Actor.exit();
}

const cookies = [
    {
        name: 'auth_token',
        value: auth_token.trim(),
        domain: '.x.com',
        path: '/',
    },
    {
        name: 'ct0',
        value: ct0.trim(),
        domain: '.x.com',
        path: '/',
    }
];

const crawler = new PlaywrightCrawler({
    // Configure Playwright with persistent context settings and anti-bot fingerprints if possible.
    // Crawlee PlaywrightCrawler handles stealth internally reasonably well.
    launchContext: {
        launchOptions: {
            args: ['--disable-blink-features=AutomationControlled'],
        },
    },
    // Set appropriate timeouts
    requestHandlerTimeoutSecs: 180,
    navigationTimeoutSecs: 60,

    preNavigationHooks: [
        async ({ page }) => {
            // Inject cookies into the browser context before loading pages
            await page.context().addCookies(cookies);
        }
    ],

    async requestHandler({ page, request }) {
        log.info(`Processing ${request.url}...`);

        try {
            // Wait for tweet elements to load
            await page.waitForSelector('[data-testid="tweet"]', { timeout: 30000 });
            
            // Wait a bit for images and content to fully render
            await page.waitForTimeout(2000);

            // Extract Main Post Data
            log.info('Extracting main post data...');
            const mainTweet = page.locator('[data-testid="tweet"]').first();
            
            // Author Username
            const userNameText = await mainTweet.locator('[data-testid="User-Name"]').innerText().catch(() => '');
            const authorMatch = userNameText.match(/@[\w_]+/);
            const author_username = authorMatch ? authorMatch[0] : null;
            log.debug(`Main post author: ${author_username}`);

            // Post Content
            // We search globally on the page for the first tweetText since the main tweet wrapper might vary.
            const post_content = await page.locator('[data-testid="tweetText"]').first().innerText().catch(() => "");

            // Post Image URL
            let post_image_url = "";
            try {
                const imgLocator = page.locator('[data-testid="tweetPhoto"] img').first();
                if (await imgLocator.isVisible({ timeout: 5000 })) {
                    const src = await imgLocator.getAttribute('src');
                    if (src && src.includes('pbs.twimg.com/media/')) {
                        // Upgrade URL resolution from small/medium to orig
                        post_image_url = src.replace(/&name=\w+/, '&name=orig');
                    }
                }
            } catch (err) {
                log.debug(`No post image found: ${err.message}`);
            }

            // Comment Sorting
            log.info('Attempting to sort comments by Likes...');
            try {
                // Look for the "Relevant" button (it may be labeled slightly differently depending on locale,
                // but we will look for text "Relevant" as per requirements)
                const relevantButton = page.locator('button', { hasText: 'Relevant' });
                if (await relevantButton.isVisible({ timeout: 5000 })) {
                    await relevantButton.click();
                    await page.waitForSelector('[data-testid="Dropdown"]', { timeout: 5000 });
                    
                    const likesOption = page.locator('[role="menuitem"]', { hasText: 'Likes' });
                    if (await likesOption.isVisible({ timeout: 5000 })) {
                        await likesOption.click();
                        // Wait 3 seconds for network/DOM to re-render comments by likes
                        await page.waitForTimeout(3000);
                        // Re-wait for tweets to appear
                        await page.waitForSelector('[data-testid="tweet"]', { timeout: 15000 });
                    }
                } else {
                    log.debug('Could not find "Relevant" sorting button. Proceeding with default sort.');
                }
            } catch (err) {
                log.warning(`Failed during comment sorting: ${err.message}`);
            }

            // Top Comments Extraction
            log.info(`Extracting up to ${maxComments} comments...`);
            const collectedComments = [];
            let previousCount = 0;
            let noNewCommentsScrolls = 0;

            while (collectedComments.length < maxComments && noNewCommentsScrolls < 5) {
                const allTweets = await page.locator('[data-testid="tweet"]').all();
                
                for (let i = 1; i < allTweets.length; i++) {
                    if (collectedComments.length >= maxComments) break;

                    const commentLocator = allTweets[i];
                    
                    // We need a way to uniquely identify comments to not process them multiple times during scroll.
                    // But in a simple approach, we can just process all visible and rely on an index or text match, 
                    // or better yet, collect all we can, and we'll rebuild the list.
                    // Wait, if we rebuild the list on every scroll, we can just clear collectedComments and repopulate.
                    
                    const cUserNameText = await commentLocator.locator('[data-testid="User-Name"]').innerText().catch(() => '');
                    const cMatch = cUserNameText.match(/@[\w_]+/);
                    const commentAuthor = cMatch ? cMatch[0] : null;

                    // CRITICAL: If commenter handle === post author handle, IGNORE/SKIP
                    if (!commentAuthor || commentAuthor === author_username) {
                        continue;
                    }

                    const commentText = await commentLocator.locator('[data-testid="tweetText"]').innerText().catch(() => null);
                    if (!commentText) {
                        continue;
                    }

                    // Check if we already collected this exact comment (simple dedup by text + author)
                    const isDup = collectedComments.some(c => c.author === commentAuthor && c.text === commentText);
                    if (!isDup) {
                        collectedComments.push({
                            author: commentAuthor,
                            text: commentText
                        });
                    }
                }

                if (collectedComments.length >= maxComments) {
                    break;
                }

                if (collectedComments.length === previousCount) {
                    noNewCommentsScrolls++;
                } else {
                    noNewCommentsScrolls = 0;
                }
                
                previousCount = collectedComments.length;

                // Micro-scroll to trigger lazy loading
                await page.evaluate(() => window.scrollBy(0, 500));
                await page.waitForTimeout(1500); // Wait for new items to load
            }

            log.info(`Extracted ${collectedComments.length} valid comments.`);

            // Output & Dataset
            // Push object to Apify Dataset so it exports as flat CSV columns
            const output = {
                author_username,
                post_content,
                post_image_url,
            };

            // Save up to N non-author comments dynamically as comment_1, comment_2, etc.
            collectedComments.slice(0, maxComments).forEach((c, index) => {
                output[`comment_${index + 1}`] = c.text;
                // output[`comment_${index + 1}_author`] = c.author; // Optionally include author
            });

            await Actor.pushData(output);
            log.info('Successfully saved post and comments to dataset.');

        } catch (error) {
            log.error(`Error processing ${request.url}: ${error.message}`);
        }
    },
    
    // Failed request handler
    async failedRequestHandler({ request, error }) {
        log.error(`Request ${request.url} failed completely after all retries: ${error.message}`);
    }
});

// Run the crawler
await crawler.run(startUrls);

// Exit gracefully
await Actor.exit();
