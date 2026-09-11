import { chromium } from 'playwright';

async function run() {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    
    // Set user agent to a common browser
    await context.setExtraHTTPHeaders({
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();
    
    console.log('Navigating to x.com/danbedix...');
    try {
        await page.goto('https://x.com/danbedix', { waitUntil: 'networkidle', timeout: 30000 });
        console.log('Page loaded. Waiting 5 seconds...');
        await page.waitForTimeout(5000);
        
        const title = await page.title();
        console.log('Page Title:', title);
        
        const html = await page.content();
        console.log('HTML length:', html.length);
        
        // Let's see if there are any links containing "/followers"
        const links = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('a')).map(a => ({
                href: a.getAttribute('href'),
                text: a.innerText
            })).filter(l => l.href && (l.href.includes('follower') || l.href.includes('following')));
        });
        console.log('Follower/Following links found:', links);
        
        // Let's capture the text of some buttons or headings to see if it's a login screen
        const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 1000));
        console.log('First 1000 chars of body text:', bodyText);

        await page.screenshot({ path: 'screenshot.png' });
        console.log('Screenshot saved as screenshot.png');
    } catch (err) {
        console.error('Error:', err);
    } finally {
        await browser.close();
    }
}

run();
