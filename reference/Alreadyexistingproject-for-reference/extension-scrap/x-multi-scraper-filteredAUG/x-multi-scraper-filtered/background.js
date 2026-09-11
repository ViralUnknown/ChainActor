// ── State ──────────────────────────────────────────────────────────────────
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

// Save current state to storage so popup can read it anytime
async function saveState(patch) {
  const current = await chrome.storage.local.get(['scanState']);
  const prev = current.scanState || {};
  await chrome.storage.local.set({ scanState: { ...prev, ...patch } });
}

// ── Content script injected into the X tab ────────────────────────────────
function runPostScanner(scrollLimit) {
  window.__stopPostScanner = false;
  const seen = new Set();
  let scrollsDone = 0;
  let noNewCount = 0;
  let lastSize = 0;

  function scan() {
    const newUsers = [];
    document.querySelectorAll('article[data-testid="tweet"]').forEach(article => {
      try {
        const userNameBlock = article.querySelector('[data-testid="User-Name"]');
        if (!userNameBlock) return;

        let username = '';
        const avatarContainer = article.querySelector('[data-testid^="UserAvatar-Container-"]');
        if (avatarContainer) {
          username = avatarContainer.getAttribute('data-testid').replace('UserAvatar-Container-', '').trim().toLowerCase();
        }
        if (!username) {
          userNameBlock.querySelectorAll('a[href]').forEach(link => {
            const m = (link.getAttribute('href') || '').match(/^\/([A-Za-z0-9_]{1,15})$/);
            if (m && m[1]) username = m[1].toLowerCase();
          });
        }
        if (!username || seen.has(username)) return;

        let displayName = username;
        for (const span of userNameBlock.querySelectorAll('span')) {
          const txt = span.textContent.trim();
          if (txt && !txt.startsWith('@') && txt.length > 1 && !txt.includes('·')) {
            displayName = txt; break;
          }
        }

        // Check if user is verified (has the blue checkmark)
        const isVerified = !!userNameBlock.querySelector('[data-testid="icon-verified"]');

        seen.add(username);
        newUsers.push({ username, displayName, verified: isVerified });
      } catch(e) {}
    });

    if (newUsers.length > 0) {
      chrome.runtime.sendMessage({
        type: 'POST_PROGRESS',
        totalScanned: document.querySelectorAll('article[data-testid="tweet"]').length,
        newUsers
      });
    }
  }

  async function scroll() {
    if (window.__stopPostScanner) {
      chrome.runtime.sendMessage({ type: 'POST_DONE' }); return;
    }
    scan();
    if (scrollsDone >= scrollLimit) {
      chrome.runtime.sendMessage({ type: 'POST_DONE' }); return;
    }
    window.scrollBy(0, 900);
    scrollsDone++;
    await new Promise(r => setTimeout(r, 1800));
    if (seen.size === lastSize) {
      noNewCount++;
      if (noNewCount >= 8) { chrome.runtime.sendMessage({ type: 'POST_DONE' }); return; }
    } else { noNewCount = 0; lastSize = seen.size; }
    scroll();
  }

  scan();
  scroll();
}

// ── Per-post scrape ────────────────────────────────────────────────────────
async function scrapePost(tabId, postUrl, scrollLimit) {
  await chrome.tabs.update(tabId, { url: postUrl, active: true });
  await sleep(800);
  await waitForTabLoad(tabId, 15000);
  await sleep(3500);

  return new Promise((resolve) => {
    let localVerified = [];
    let localScanned = 0;
    let done = false;

    const listener = (message, sender) => {
      if (sender.tab?.id !== tabId) return;

      if (message.type === 'POST_PROGRESS') {
        localScanned = message.totalScanned;
        localVerified.push(...message.newUsers);
      }
      if (message.type === 'POST_DONE') {
        if (!done) {
          done = true;
          chrome.runtime.onMessage.removeListener(listener);
          resolve({ scanned: localScanned, verified: localVerified });
        }
      }
    };
    chrome.runtime.onMessage.addListener(listener);

    chrome.scripting.executeScript({
      target: { tabId },
      func: runPostScanner,
      args: [scrollLimit]
    });

    // Safety timeout
    setTimeout(() => {
      if (!done) {
        done = true;
        chrome.runtime.onMessage.removeListener(listener);
        resolve({ scanned: localScanned, verified: localVerified });
      }
    }, scrollLimit * 2000 + 20000);
  });
}

// ── Main orchestrator ──────────────────────────────────────────────────────
async function startScan(links, scrollLimit) {
  if (isRunning) return;
  isRunning = true;
  stopRequested = false;

  // Reset state in storage
  await chrome.storage.local.set({
    scanState: {
      running: true,
      links,
      queueStatus: links.map(() => 'pending'),
      verified: [],
      totalScanned: 0,
      postsDone: 0,
      status: 'Starting...',
      statusColor: '#e6edf2'
    }
  });

  const allVerified = new Map();

  // Don't open a tab here — we'll create fresh tabs in the loop for each post
  activeTabId = null;
  await sleep(500);

  for (let i = 0; i < links.length; i++) {
    if (stopRequested) {
      await saveState({ queueStatus: await getQueueStatus(i, 'stopped'), status: '⏹ Stopped.', statusColor: '#8b949e' });
      break;
    }

    await updateQueueItem(i, 'active');
    await saveState({ status: `⏳ Scraping post ${i + 1} of ${links.length}...`, statusColor: '#e6edf2' });

    try {
      // Close previous tab if exists (except on first iteration)
      if (i > 0 && activeTabId) {
        try {
          await chrome.tabs.remove(activeTabId);
          await sleep(500); // Brief pause before opening new tab
        } catch (e) {
          // Tab may already be closed, that's fine
        }
      }

      // Open fresh tab for this post
      const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
      activeTabId = tab.id;
      await sleep(800);

      const result = await scrapePost(activeTabId, links[i], scrollLimit);

      // Merge verified, dedupe by username
      result.verified.forEach(u => allVerified.set(u.username, u));

      const verifiedArr = Array.from(allVerified.values());
      const current = await chrome.storage.local.get(['scanState']);
      const prev = current.scanState || {};
      const newQueueStatus = [...(prev.queueStatus || [])];
      newQueueStatus[i] = 'done';

      await chrome.storage.local.set({
        scanState: {
          ...prev,
          queueStatus: newQueueStatus,
          verified: verifiedArr,
          totalScanned: (prev.totalScanned || 0) + result.scanned,
          postsDone: (prev.postsDone || 0) + 1,
          progress: Math.round((i + 1) / links.length * 100)
        }
      });

    } catch(e) {
      await updateQueueItem(i, 'error');
    }

    // Close tab after each post to free memory
    if (activeTabId) {
      try {
        await chrome.tabs.remove(activeTabId);
        activeTabId = null;
        await sleep(300); // Brief pause for cleanup
      } catch (e) {
        // Tab may already be closed
      }
    }

    if (i < links.length - 1 && !stopRequested) await sleep(1000);
  }

  // Ensure final tab is closed
  try { 
    if (activeTabId) chrome.tabs.remove(activeTabId); 
  } catch(e) {}
  activeTabId = null;
  isRunning = false;

  const final = await chrome.storage.local.get(['scanState']);
  const fs = final.scanState || {};
  const total = (fs.verified || []).length;
  const posts = fs.postsDone || 0;
  await saveState({
    running: false,
    status: `✅ Done! Found ${total} verified commenter${total !== 1 ? 's' : ''} across ${posts} post${posts !== 1 ? 's' : ''}.`,
    statusColor: '#3fb950'
  });
}

// helpers
async function getQueueStatus(upToIndex, stateForRemaining) {
  const current = await chrome.storage.local.get(['scanState']);
  return (current.scanState?.queueStatus || []).map((s, i) => i >= upToIndex ? stateForRemaining : s);
}

async function updateQueueItem(index, state) {
  const current = await chrome.storage.local.get(['scanState']);
  const prev = current.scanState || {};
  const newQueueStatus = [...(prev.queueStatus || [])];
  newQueueStatus[index] = state;
  await chrome.storage.local.set({ scanState: { ...prev, queueStatus: newQueueStatus } });
}

// ── Message listener from popup ────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'START_SCAN') {
    startScan(message.links, message.scrollLimit);
    sendResponse({ ok: true });
  }
  if (message.type === 'STOP_SCAN') {
    stopRequested = true;
    if (activeTabId) {
      chrome.scripting.executeScript({
        target: { tabId: activeTabId },
        func: () => { window.__stopPostScanner = true; }
      }).catch(() => {});
    }
    sendResponse({ ok: true });
  }
  return true;
});
