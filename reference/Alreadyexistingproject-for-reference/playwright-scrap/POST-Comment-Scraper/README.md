# X (Twitter) Post Comment Scraper

This Apify Actor extracts data from X (formerly Twitter) posts and scrapes their top-liked comments. It operates as an authenticated user via cookies to ensure stealth and accuracy.

## Features
- **Scrape Main Post**: Extracts the author's username, post text, and the original high-resolution image URL.
- **Top Comments by Likes**: Automatically sorts the post's replies by "Likes" and collects the top responses.
- **Smart Filtering**: Skips comments made by the post's author (useful for ignoring long self-threads) to get genuine public responses.
- **Deep Scraping**: Supports automatic micro-scrolling to lazy-load more comments if needed.

## Input Parameters
The Actor accepts the following inputs (see `.actor/input_schema.json`):

| Field | Type | Description |
| ----- | ---- | ----------- |
| `startUrls` | Array | One or more X post URLs to scrape (e.g., `https://x.com/username/status/123456...`). |
| `auth_token` | String | **Required**. Your X/Twitter `auth_token` cookie. |
| `ct0` | String | **Required**. Your X/Twitter `ct0` cookie. |
| `maxComments` | Integer | The maximum number of comments to extract per post. Default is 10. |

## How to get Authentication Cookies
To scrape X reliably, you need to provide an authenticated session.
1. Log into your X/Twitter account in your browser.
2. Open Developer Tools (F12) -> Application -> Cookies.
3. Find the `auth_token` and `ct0` cookies.
4. Paste the value of each into their respective fields in the input form.

## Output Format
The Actor pushes data directly to the default Apify Dataset. The data is structured flat, which makes it perfect for CSV/Excel exports. 

Example JSON output:
```json
{
  "author_username": "@elonmusk",
  "post_content": "Example post text...",
  "post_image_url": "https://pbs.twimg.com/media/XYZ.jpg&name=orig",
  "comment_1": "This is the top liked comment!",
  "comment_2": "This is the second top liked comment!",
  "comment_3": "..."
}
```

## Running the Actor
This Actor is built using Node.js, Playwright, and Crawlee. 
- Ensure you have [Apify CLI](https://docs.apify.com/cli) installed.
- Deploy it to your Apify console using `apify push`.
- Alternatively, run it in a containerized environment if testing locally.

## Disclaimer
Please ensure you use this scraper in accordance with X/Twitter's Terms of Service. Scraping logged-in requires care; consider using an alt-account rather than your primary personal account for authentication.
