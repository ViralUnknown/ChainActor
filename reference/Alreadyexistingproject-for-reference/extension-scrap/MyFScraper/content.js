// content.js - Runs on X.com pages
// Extracts accounts that follow you ("Follows you" badge), optionally verified-only

let isRunning = false;
let followers = new Map(); // username -> data
let scrollTimeoutId = null;
let noNewUsersCount = 0;
let filterMode = 'all'; // 'all' | 'verified'

function passesFollowsYou(cell) {
  const followsYouElement = cell.querySelector('[data-testid="userFollowIndicator"]');
  if (!followsYouElement) return false;
  return followsYouElement.textContent.trim().includes('Follows you');
}

function extractFromCell(cell) {
  if (!passesFollowsYou(cell)) return null;

  const usernameLink = cell.querySelector('a[href^="/"]');
  if (!usernameLink) return null;

  let username = usernameLink.getAttribute('href').replace('/', '');
  if (!username || username.length < 1) return null;

  const nameElement = cell.querySelector('div[dir="auto"] strong');
  const displayName = nameElement ? nameElement.textContent.trim() : username;

  const isVerified = !!cell.querySelector('svg[data-testid="icon-verified"]');

  if (filterMode === 'verified' && !isVerified) return null;

  return {
    username: '@' + username,
    displayName,
    isVerified,
    followsYou: true,
    extractedAt: new Date().toISOString()
  };
}

function scanFollowers() {
  const cells = document.querySelectorAll('[data-testid="UserCell"]');
  let newCount = 0;

  cells.forEach(cell => {
    try {
      const followerData = extractFromCell(cell);
      if (!followerData) return;

      const username = followerData.username.substring(1);
      if (!followers.has(username)) {
        followers.set(username, followerData);
        newCount++;
      }
    } catch (e) {
      console.log('Error processing cell:', e);
    }
  });

  return newCount;
}

function saveToStorage() {
  const data = Array.from(followers.values());
  chrome.storage.local.set({
    myFollowers: data,
    lastUpdated: new Date().toISOString(),
    count: data.length
  });

  chrome.runtime.sendMessage({
    type: 'UPDATE',
    data: data,
    count: data.length,
    isRunning: isRunning
  }).catch(() => {});
}

function stopScrolling() {
  if (scrollTimeoutId) {
    clearTimeout(scrollTimeoutId);
    scrollTimeoutId = null;
  }
  isRunning = false;
  saveToStorage();
}

// Wait for new UserCells to actually appear (or timeout), instead of a fixed sleep.
// Main speed fix: no more flat 1s + 2.5s wait per cycle regardless of render speed.
function waitForNewContent(previousCellCount, callback) {
  const start = Date.now();
  const maxWait = 2000;
  const pollInterval = 150;

  function poll() {
    if (!isRunning) return;

    const currentCellCount = document.querySelectorAll('[data-testid="UserCell"]').length;
    const elapsed = Date.now() - start;

    if (currentCellCount > previousCellCount || elapsed >= maxWait) {
      callback();
    } else {
      scrollTimeoutId = setTimeout(poll, pollInterval);
    }
  }

  scrollTimeoutId = setTimeout(poll, pollInterval);
}

function tick() {
  if (!isRunning) return;

  const previousCellCount = document.querySelectorAll('[data-testid="UserCell"]').length;

  window.scrollBy(0, 1200);

  waitForNewContent(previousCellCount, () => {
    if (!isRunning) return;

    const newCount = scanFollowers();
    saveToStorage();

    if (newCount === 0) {
      noNewUsersCount++;
      if (noNewUsersCount >= 4) {
        console.log('Reached end of followers list');
        stopScrolling();
        chrome.runtime.sendMessage({
          type: 'FINISHED',
          total: followers.size
        }).catch(() => {});
        return;
      }
    } else {
      noNewUsersCount = 0;
    }

    scrollTimeoutId = setTimeout(tick, 400);
  });
}

function startScrolling(mode) {
  if (isRunning) return;
  if (mode) filterMode = mode;

  isRunning = true;
  noNewUsersCount = 0;

  scanFollowers();
  saveToStorage();

  tick();
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'START') {
    startScrolling(msg.filterMode || 'all');
    sendResponse({ status: 'started', count: followers.size });

  } else if (msg.action === 'STOP') {
    stopScrolling();
    sendResponse({ status: 'stopped', count: followers.size });

  } else if (msg.action === 'GET_DATA') {
    const data = Array.from(followers.values());
    sendResponse({ data, count: data.length, isRunning });

  } else if (msg.action === 'SET_FILTER') {
    filterMode = msg.filterMode || 'all';
    sendResponse({ status: 'filter set', filterMode });

  } else if (msg.action === 'CLEAR') {
    followers.clear();
    stopScrolling();
    chrome.storage.local.remove(['myFollowers']);
    sendResponse({ status: 'cleared' });
  }

  return true;
});

// Restore from storage on load. Content script now loads at document_idle,
// so chrome.storage is reliably ready and this runs correctly without
// requiring a manual tab reload.
chrome.storage.local.get(['myFollowers'], (result) => {
  if (result.myFollowers && Array.isArray(result.myFollowers)) {
    result.myFollowers.forEach(item => {
      followers.set(item.username.substring(1), item);
    });
  }
});
