let isRunning = false;
let stopRequested = false;
let currentIndex = 0;
let usernames = [];
let stats = { unblocked: 0, skipped: 0, total: 0 };

async function waitForTabLoad(tabId, timeout = 12000) {
  return new Promise((resolve) => {
    const start = Date.now();
    function check() {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError) { resolve(false); return; }
        if (tab.status === 'complete') { resolve(true); return; }
        if (Date.now() - start > timeout) { resolve(false); return; }
        setTimeout(check, 300);
      });
    }
    check();
  });
}

async function unblockUser(username) {
  // Create a fresh tab starting at about:blank - active: true brings it to foreground
  const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
  
  await new Promise(r => setTimeout(r, 300));
  
  // Navigate to profile
  await chrome.tabs.update(tab.id, { url: 'https://x.com/' + username });
  await new Promise(r => setTimeout(r, 800));
  await waitForTabLoad(tab.id, 12000);
  await new Promise(r => setTimeout(r, 1500));

  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async () => {
        function waitFor(selector, timeout = 8000) {
          return new Promise((resolve) => {
            const start = Date.now();
            const interval = setInterval(() => {
              const el = document.querySelector(selector);
              if (el) { clearInterval(interval); resolve(el); }
              if (Date.now() - start > timeout) { clearInterval(interval); resolve(null); }
            }, 300);
          });
        }

        try {
          await new Promise(r => setTimeout(r, 500));
          const bodyText = document.body.innerText || '';
          if (bodyText.includes("This account doesn't exist") || bodyText.includes("Account suspended")) {
            return { status: 'skipped', reason: 'Account not found or suspended' };
          }

          const moreBtn = await waitFor('[data-testid="userActions"]', 8000);
          if (!moreBtn) return { status: 'skipped', reason: 'Profile actions button not found' };

          moreBtn.click();
          await new Promise(r => setTimeout(r, 1000));

          const menuItems = Array.from(document.querySelectorAll('[role="menuitem"]'));
          const unblockItem = menuItems.find(el => {
            const txt = el.textContent.toLowerCase();
            return txt.includes('unblock @') || txt.match(/^unblock\s/);
          });

          if (!unblockItem) {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            return { status: 'skipped', reason: 'Unblock option not found' };
          }

          unblockItem.click();
          await new Promise(r => setTimeout(r, 1000));

          const confirmBtn = await waitFor('[data-testid="confirmationSheetConfirm"]', 6000);
          if (!confirmBtn) return { status: 'skipped', reason: 'Confirmation dialog did not appear' };

          confirmBtn.click();
          await new Promise(r => setTimeout(r, 600));

          return { status: 'unblocked' };
        } catch (e) {
          return { status: 'skipped', reason: e.message };
        }
      }
    });

    const unblockResult = result[0]?.result || { status: 'skipped', reason: 'Script error' };
    
    // Close tab after processing
    try { chrome.tabs.remove(tab.id); } catch(e) {}
    
    return unblockResult;
  } catch (e) {
    try { chrome.tabs.remove(tab.id); } catch(e) {}
    return { status: 'skipped', reason: 'Execution error: ' + e.message };
  }
}

async function startUnblocking(usernameList) {
  usernames = usernameList;
  currentIndex = 0;
  stats = { unblocked: 0, skipped: 0, total: usernames.length };
  isRunning = true;
  stopRequested = false;

  await chrome.storage.local.set({
    unblockerState: {
      isRunning: true,
      currentIndex: 0,
      stats: stats,
      usernames: usernames,
      mode: 'unblocking'
    }
  });

  processNext();
}

async function processNext() {
  if (!isRunning || stopRequested || currentIndex >= usernames.length) {
    isRunning = false;
    await chrome.storage.local.set({
      unblockerState: {
        isRunning: false,
        currentIndex: currentIndex,
        stats: stats,
        usernames: usernames,
        mode: 'unblocking',
        finished: true
      }
    });
    broadcastUpdate();
    return;
  }

  const username = usernames[currentIndex];
  
  await chrome.storage.local.set({
    unblockerState: {
      isRunning: true,
      currentIndex: currentIndex,
      stats: stats,
      usernames: usernames,
      currentUsername: username,
      mode: 'unblocking'
    }
  });

  broadcastUpdate();

  try {
    const result = await unblockUser(username);
    if (result.status === 'unblocked') {
      stats.unblocked++;
    } else {
      stats.skipped++;
    }
  } catch (e) {
    stats.skipped++;
  }

  currentIndex++;
  await new Promise(r => setTimeout(r, 1200));
  processNext();
}

function broadcastUpdate() {
  chrome.runtime.sendMessage({
    action: 'statusUpdate',
    stats: stats,
    currentIndex: currentIndex,
    total: usernames.length,
    isRunning: isRunning,
    currentUsername: currentIndex < usernames.length ? usernames[currentIndex] : null
  }).catch(() => {});
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'startUnblocking') {
    startUnblocking(request.usernames);
    sendResponse({ ok: true });
  } else if (request.action === 'stopUnblocking') {
    stopRequested = true;
    sendResponse({ ok: true });
  } else if (request.action === 'getStatus') {
    sendResponse({
      isRunning: isRunning,
      stats: stats,
      currentIndex: currentIndex,
      total: usernames.length,
      currentUsername: currentIndex < usernames.length ? usernames[currentIndex] : null
    });
  }
});

// Restore state on startup
chrome.storage.local.get(['unblockerState'], (res) => {
  if (res.unblockerState && res.unblockerState.isRunning && !res.unblockerState.finished) {
    usernames = res.unblockerState.usernames;
    currentIndex = res.unblockerState.currentIndex;
    stats = res.unblockerState.stats;
    isRunning = true;
    stopRequested = false;
    processNext();
  }
});
