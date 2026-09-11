const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const usernameInput = document.getElementById('usernameInput');
const statusBox = document.getElementById('statusBox');
const statusText = document.getElementById('statusText');
const progressFill = document.getElementById('progressFill');
const countRow = document.getElementById('countRow');
const totalCount = document.getElementById('totalCount');
const blockedCount = document.getElementById('blockedCount');
const skippedCount = document.getElementById('skippedCount');

let isRunning = false;

function parseUsernames(raw) {
  return [...new Set(
    raw.split(/[\n,]+/)
      .map(u => u.trim().replace(/^@/, '').toLowerCase())
      .filter(u => u.length > 0 && /^[a-z0-9_]{1,15}$/.test(u))
  )];
}

function updateUI(stats, currentIndex, total, currentUsername, isRunning) {
  if (isRunning || currentIndex > 0) {
    statusBox.classList.add('visible');
    countRow.style.display = 'flex';
    startBtn.disabled = true;
    stopBtn.disabled = !isRunning;

    blockedCount.textContent = stats.blocked;
    skippedCount.textContent = stats.skipped;
    totalCount.textContent = total;

    const progress = total > 0 ? (currentIndex / total) * 100 : 0;
    progressFill.style.width = progress + '%';

    if (isRunning) {
      statusText.textContent = `⏳ Blocking @${currentUsername} (${currentIndex} of ${total})...`;
    } else {
      statusText.textContent = `✅ Done! Blocked: ${stats.blocked} | Skipped: ${stats.skipped}`;
    }
  }
}

// Poll for status updates every 500ms
setInterval(() => {
  chrome.runtime.sendMessage({ action: 'getStatus' }, (response) => {
    if (response) {
      updateUI(response.stats, response.currentIndex, response.total, response.currentUsername, response.isRunning);
    }
  });
}, 500);

startBtn.addEventListener('click', () => {
  const raw = usernameInput.value;
  const usernames = parseUsernames(raw);

  if (usernames.length === 0) {
    statusBox.classList.add('visible');
    statusText.textContent = '⚠️ No valid usernames found.';
    return;
  }

  isRunning = true;
  startBtn.disabled = true;
  stopBtn.disabled = false;
  statusBox.classList.add('visible');
  countRow.style.display = 'flex';

  chrome.runtime.sendMessage({
    action: 'startBlocking',
    usernames: usernames
  }, () => {
    statusText.textContent = `⏳ Starting to block ${usernames.length} users...`;
  });
});

stopBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'stopBlocking' }, () => {
    stopBtn.disabled = true;
    statusText.textContent = '🛑 Stopping...';
  });
});

// Load saved usernames
chrome.storage.local.get(['savedUsernames'], (res) => {
  if (res.savedUsernames) {
    usernameInput.value = res.savedUsernames;
  }
});

usernameInput.addEventListener('input', (e) => {
  chrome.storage.local.set({ savedUsernames: e.target.value });
});

// Get initial status
chrome.runtime.sendMessage({ action: 'getStatus' }, (response) => {
  if (response) {
    updateUI(response.stats, response.currentIndex, response.total, response.currentUsername, response.isRunning);
    isRunning = response.isRunning;
  }
});
