// content.js — injected into x.com / twitter.com

let isRunning = false;
let users = new Map(); // dedup by username
let interval = null;

function extractUsers(verifiedOnly) {
  const cells = document.querySelectorAll('[data-testid="UserCell"]');

  cells.forEach(cell => {
    // Username link
    const usernameLink =
      cell.querySelector('a[href^="/"][role="link"]') ||
      Array.from(cell.querySelectorAll('a')).find(a =>
        a.textContent.trim().startsWith('@') ||
        a.getAttribute('href')?.match(/^\/[a-zA-Z0-9_]+$/)
      );

    if (!usernameLink) return;

    const rawHref = usernameLink.getAttribute('href') || '';
    const username =
      usernameLink.textContent.trim().replace('@', '') ||
      rawHref.replace('/', '');

    if (!username || username.length < 1) return;
    if (users.has(username)) return;

    // Display name
    const nameEl =
      cell.querySelector('div[dir="auto"] strong') ||
      cell.querySelector('span span');
    const name = nameEl ? nameEl.textContent.trim() : username;

    // Verified badge
    const verified =
      !!cell.querySelector('svg[data-testid="icon-verified"]') ||
      !!cell.querySelector('[aria-label*="Verified"]') ||
      false;

    if (verifiedOnly && !verified) return;

    users.set(username, {
      name: name || username,
      username: '@' + username,
      verified
    });

    // Push update to popup
    chrome.runtime.sendMessage({
      type: 'UPDATE',
      data: Array.from(users.values()),
      count: users.size
    }).catch(() => {}); // popup might be closed
  });
}

function startScrolling(delay, verifiedOnly) {
  if (interval) clearInterval(interval);

  interval = setInterval(() => {
    if (!isRunning) return;

    extractUsers(verifiedOnly);
    window.scrollBy(0, 800);
  }, delay);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'START') {
    isRunning = true;
    users.clear();
    startScrolling(msg.delay || 800, msg.verifiedOnly || false);
    sendResponse({ status: 'started' });
  } else if (msg.action === 'STOP') {
    isRunning = false;
    if (interval) clearInterval(interval);
    sendResponse({ status: 'stopped', count: users.size });
  } else if (msg.action === 'GET_DATA') {
    sendResponse({ data: Array.from(users.values()), count: users.size });
  } else if (msg.action === 'CLEAR') {
    users.clear();
    sendResponse({ status: 'cleared' });
  }
  return true; // keep channel open for async
});

// Initial extraction when page loads
setTimeout(() => extractUsers(false), 2000);
