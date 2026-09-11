// ═══════════════════════════════════════════════════════════════════
// BACKGROUND SERVICE WORKER
// Stays alive independently of the popup.
// Popup sends: START_SCAN | STOP_SCAN | CLEAR_DATA
// Worker saves all state to chrome.storage so popup can read anytime.
// ═══════════════════════════════════════════════════════════════════

let isRunning = false;
let stopRequested = false;
let activeTabId = null;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function waitForTabLoad(tabId, timeout = 15000) {
  return new Promise((resolve) => {
    const start = Date.now();
    function check() {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError) { resolve(false); return; }
        if (tab.status === 'complete') { resolve(true); return; }
        if (Date.now() - start > timeout) { resolve(false); return; }
        setTimeout(check, 400);
      });
    }
    check();
  });
}

// Clear all cookies on x.com and twitter.com to reset session completely
async function clearXCookies() {
  const domains = ['x.com', '.x.com', 'twitter.com', '.twitter.com'];
  for (const domain of domains) {
    try {
      const cookies = await chrome.cookies.getAll({ domain });
      for (const cookie of cookies) {
        const url = `https://${cookie.domain.startsWith('.') ? cookie.domain.substring(1) : cookie.domain}${cookie.path}`;
        await chrome.cookies.remove({ url, name: cookie.name });
      }
    } catch (e) {
      console.error('Error clearing cookies for domain', domain, e);
    }
  }
}

// Set list of name-value cookie objects for x.com / twitter.com
async function setXCookies(cookieArray) {
  const domains = ['x.com', '.x.com', 'twitter.com', '.twitter.com'];
  for (const item of cookieArray) {
    for (const domain of domains) {
      try {
        await chrome.cookies.set({
          url: `https://${domain.startsWith('.') ? domain.substring(1) : domain}`,
          name: item.name,
          value: item.value,
          domain: domain,
          path: '/',
          secure: true,
          sameSite: 'no_restriction'
        });
      } catch (e) {
        console.error('Error setting cookie', item.name, 'on domain', domain, e);
      }
    }
  }
}

// Save partial state patch into storage
async function patchState(patch) {
  const cur = await chrome.storage.local.get(['aboutState']);
  const prev = cur.aboutState || {};
  await chrome.storage.local.set({ aboutState: { ...prev, ...patch } });
}

// ── Content script: injected into each /about page ──────────────────────────
// Based on the EXACT HTML from provided source files:
// - "Account based in" uses data-testid="pivot" with location pin SVG
// - "Connected via" uses data-testid="pivot" with globe SVG
// Both have a label div + value div with color rgb(113,118,123)
function scrapeAboutPage() {
  const results = {
    accountBasedIn: '',
    connectedVia: '',
    dateJoined: '',
    verified: false,
    verifiedSince: ''
  };

  try {
    // All info blocks are [data-testid="pivot"] elements
    const pivots = document.querySelectorAll('[data-testid="pivot"]');

    pivots.forEach(pivot => {
      // Get the label (first div text) and value (second div text, grey color)
      const textDivs = pivot.querySelectorAll('div[dir="ltr"]');
      if (textDivs.length < 2) return;

      const label = textDivs[0]?.textContent?.trim() || '';
      const value = textDivs[1]?.textContent?.trim() || '';

      if (!label || !value) return;

      if (label === 'Account based in') {
        results.accountBasedIn = value;
      }
      if (label === 'Connected via') {
        results.connectedVia = value;
      }
      if (label === 'Date joined') {
        results.dateJoined = value;
      }
      if (label === 'Verified') {
        results.verified = true;
        results.verifiedSince = value;
      }
    });

    // Also check if user is verified via icon in header
    if (!results.verified) {
      results.verified = !!document.querySelector('[data-testid="icon-verified"]');
    }

  } catch (e) {
    // silently fail, return empty
  }

  return results;
}

// ── Scrape a single profile ──────────────────────────────────────────────────
async function scrapeProfile(tabId, username) {
  const url = `https://x.com/${username}/about`;

  try {
    await chrome.tabs.update(tabId, { url, active: true });
    await sleep(600);
    await waitForTabLoad(tabId, 12000);
    await sleep(2800); // wait for React to paint the about page

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: scrapeAboutPage
    });

    const data = results[0]?.result || {};
    return {
      username,
      profileUrl: `https://x.com/${username}`,
      accountBasedIn: data.accountBasedIn || '—',
      connectedVia: data.connectedVia || '—',
      dateJoined: data.dateJoined || '—',
      verified: data.verified || false,
      verifiedSince: data.verifiedSince || '',
      status: 'done'
    };
  } catch (e) {
    return {
      username,
      profileUrl: `https://x.com/${username}`,
      accountBasedIn: '—',
      connectedVia: '—',
      dateJoined: '—',
      verified: false,
      verifiedSince: '',
      status: 'error'
    };
  }
}

// ── Main orchestrator ────────────────────────────────────────────────────────
async function startScan(usernames, useCookieSwitching, cookies) {
  if (isRunning) return;
  isRunning = true;
  stopRequested = false;

  // Initialize state in storage
  await chrome.storage.local.set({
    aboutState: {
      running: true,
      usernames,
      queueStatus: usernames.map(() => 'pending'),
      results: [],
      current: 0,
      total: usernames.length,
      status: 'Starting...',
      statusColor: '#e6edf2'
    }
  });

  let currentCookieIndex = 0;

  // If cookie switching is enabled, set the first account cookie before opening tab
  if (useCookieSwitching && cookies && cookies.length > 0) {
    await patchState({
      status: `🔑 Applying cookies for Account 1...`,
      statusColor: '#dbab09'
    });
    await clearXCookies();
    await setXCookies(cookies[0]);
    await sleep(500);
  }

  // Open a dedicated active tab
  let tab = await chrome.tabs.create({ url: 'https://x.com', active: true });
  activeTabId = tab.id;
  await sleep(2000);

  const allResults = [];

  for (let i = 0; i < usernames.length; i++) {
    if (stopRequested) {
      await patchState({
        status: '⏹ Stopped.',
        statusColor: '#8b949e',
        running: false
      });
      break;
    }

    // Check if the tab still exists. If it was closed, stop scan cleanly.
    try {
      if (!activeTabId) {
        throw new Error('Tab closed');
      }
      await chrome.tabs.get(activeTabId);
    } catch (err) {
      await patchState({
        status: '⏹ Stopped: Scraping tab was closed.',
        statusColor: '#ff7b72',
        running: false
      });
      break;
    }

    // Account rotation logic: change cookies after every 42nd profile's about page is scraped.
    // e.g. i = 42, 84, 126... (representing 42, 84, 126 completed profile scrapes)
    if (useCookieSwitching && cookies && cookies.length > 1 && i > 0 && i % 42 === 0) {
      currentCookieIndex = (currentCookieIndex + 1) % cookies.length;

      await patchState({
        status: `🔄 Switching to Account ${currentCookieIndex + 1}...`,
        statusColor: '#58a6ff'
      });

      // Clear current tab to clean session/tab state
      try {
        await chrome.tabs.remove(activeTabId);
      } catch (e) { }

      // Clear cookies and set next cookie set
      await clearXCookies();
      await setXCookies(cookies[currentCookieIndex]);
      await sleep(1000);

      // Recreate tab with the new session
      tab = await chrome.tabs.create({ url: 'https://x.com', active: true });
      activeTabId = tab.id;
      await sleep(2500);
    }

    const username = usernames[i];

    // Update queue: mark current as active
    const curState = await chrome.storage.local.get(['aboutState']);
    const qs = [...(curState.aboutState?.queueStatus || [])];
    qs[i] = 'active';
    await patchState({
      queueStatus: qs,
      current: i + 1,
      status: `⏳ Scraping @${username} (${i + 1} of ${usernames.length})...`,
      statusColor: '#e6edf2'
    });

    const result = await scrapeProfile(activeTabId, username);
    allResults.push(result);

    // Mark done/error in queue
    const curState2 = await chrome.storage.local.get(['aboutState']);
    const qs2 = [...(curState2.aboutState?.queueStatus || [])];
    qs2[i] = result.status === 'done' ? 'done' : 'error';

    await patchState({
      queueStatus: qs2,
      results: [...allResults],
      progress: Math.round((i + 1) / usernames.length * 100)
    });

    // Short pause between profiles
    if (i < usernames.length - 1 && !stopRequested) {
      await sleep(800);
    }
  }

  try {
    if (activeTabId) {
      await chrome.tabs.remove(activeTabId);
    }
  } catch (e) { }
  activeTabId = null;
  isRunning = false;

  const doneCount = allResults.filter(r => r.status === 'done').length;
  await patchState({
    running: false,
    status: `✅ Done! Scraped ${doneCount} of ${usernames.length} profiles.`,
    statusColor: '#3fb950'
  });
}

// ── Message listener ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'START_SCAN') {
    startScan(message.usernames, message.useCookieSwitching, message.cookies);
    sendResponse({ ok: true });
  }
  if (message.type === 'STOP_SCAN') {
    stopRequested = true;
    if (activeTabId) {
      chrome.tabs.remove(activeTabId).catch(() => { });
    }
    sendResponse({ ok: true });
  }
  if (message.type === 'CLEAR_DATA') {
    chrome.storage.local.remove('aboutState');
    sendResponse({ ok: true });
  }
  return true;
});
