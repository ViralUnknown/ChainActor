// popup.js

let allUsers = [];
let verifiedOnly = false;
let isRunning = false;

// DOM refs
const dot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const countBadge = document.getElementById('count-badge');
const btnStart = document.getElementById('btn-start');
const btnStop = document.getElementById('btn-stop');
const btnCsv = document.getElementById('btn-csv');
const btnTxt = document.getElementById('btn-txt');
const btnClear = document.getElementById('btn-clear');
const verifiedToggle = document.getElementById('verified-toggle');
const speedInput = document.getElementById('speed');
const speedVal = document.getElementById('speed-val');
const searchInput = document.getElementById('search');
const userList = document.getElementById('user-list');
const pageGuide = document.getElementById('page-guide');

// Speed display
speedInput.addEventListener('input', () => {
  const ms = parseInt(speedInput.value);
  speedVal.textContent = (ms / 1000).toFixed(1) + 's';
});

// Verified toggle
verifiedToggle.addEventListener('click', () => {
  verifiedOnly = !verifiedOnly;
  verifiedToggle.classList.toggle('on', verifiedOnly);
});

// Search filter
searchInput.addEventListener('input', () => renderList());

function setRunning(running) {
  isRunning = running;
  dot.className = 'status-dot ' + (running ? 'running' : 'stopped');
  statusText.textContent = running ? 'Extracting…' : 'Stopped';
  btnStart.disabled = running;
  btnStop.disabled = !running;
}

function updateCount(n) {
  countBadge.textContent = n + ' user' + (n !== 1 ? 's' : '');
  btnCsv.disabled = n === 0;
  btnTxt.disabled = n === 0;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function isValidPage(url) {
  return url && (url.includes('x.com') || url.includes('twitter.com'));
}

function isFollowersPage(url) {
  return url && (url.includes('/followers') || url.includes('/following'));
}

// Start
btnStart.addEventListener('click', async () => {
  const tab = await getActiveTab();

  if (!isValidPage(tab?.url)) {
    pageGuide.classList.add('show');
    return;
  }

  if (!isFollowersPage(tab?.url)) {
    pageGuide.classList.add('show');
  } else {
    pageGuide.classList.remove('show');
  }

  const delay = parseInt(speedInput.value);

  chrome.tabs.sendMessage(tab.id, {
    action: 'START',
    delay,
    verifiedOnly
  }, () => {
    if (chrome.runtime.lastError) {
      // Content script not ready, inject manually
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js']
      }, () => {
        setTimeout(() => {
          chrome.tabs.sendMessage(tab.id, { action: 'START', delay, verifiedOnly });
        }, 500);
      });
    }
  });

  setRunning(true);
});

// Stop
btnStop.addEventListener('click', async () => {
  const tab = await getActiveTab();
  chrome.tabs.sendMessage(tab.id, { action: 'STOP' }, () => {});
  setRunning(false);
  statusText.textContent = 'Stopped — ' + allUsers.length + ' users found';
});

// Clear
btnClear.addEventListener('click', async () => {
  allUsers = [];
  renderList();
  updateCount(0);
  getActiveTab().then(tab => {
    if (tab) chrome.tabs.sendMessage(tab.id, { action: 'CLEAR' }, () => {});
  });
});

// Export CSV
btnCsv.addEventListener('click', () => {
  const rows = [['Name', 'Username', 'Verified']];
  allUsers.forEach(u => rows.push([
    `"${u.name.replace(/"/g, '""')}"`,
    u.username,
    u.verified ? 'Yes' : 'No'
  ]));
  const csv = rows.map(r => r.join(',')).join('\n');
  download('x_users.csv', csv, 'text/csv');
});

// Export usernames list
btnTxt.addEventListener('click', () => {
  const text = allUsers.map(u => u.username).join('\n');
  download('x_usernames.txt', text, 'text/plain');
});

function download(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Render user list
function renderList() {
  const q = searchInput.value.toLowerCase().trim();
  const filtered = q
    ? allUsers.filter(u =>
        u.name.toLowerCase().includes(q) ||
        u.username.toLowerCase().includes(q)
      )
    : allUsers;

  if (filtered.length === 0) {
    userList.innerHTML = `
      <div class="empty-state">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
        ${q ? 'No matches for "' + q + '"' : 'Start extraction on a followers or following page'}
      </div>`;
    return;
  }

  userList.innerHTML = filtered.map(u => {
    const initials = (u.name || u.username).slice(0, 2).replace('@', '');
    const verifiedBadge = u.verified
      ? `<span class="verified-icon"><svg viewBox="0 0 24 24"><path d="M22.25 12c0-1.43-.88-2.67-2.19-3.34.46-1.39.2-2.9-.81-3.91-1.01-1.01-2.52-1.27-3.91-.81-.66-1.31-1.9-2.19-3.34-2.19-1.43 0-2.67.88-3.34 2.19-1.39-.46-2.9-.2-3.91.81-1.01 1.01-1.27 2.52-.81 3.91-1.31.67-2.19 1.91-2.19 3.34 0 1.43.88 2.67 2.19 3.34-.46 1.39-.2 2.9.81 3.91 1.01 1.01 2.52 1.27 3.91.81.67 1.31 1.91 2.19 3.34 2.19 1.43 0 2.67-.88 3.34-2.19 1.39.46 2.9.2 3.91-.81 1.01-1.01 1.27-2.52.81-3.91 1.31-.67 2.19-1.91 2.19-3.34zm-11.71 4.2L6.8 12.46l1.41-1.42 2.26 2.26 4.8-5.23 1.47 1.36-6.2 6.77z"/></svg></span>`
      : '';
    return `
      <div class="user-item">
        <div class="avatar">${initials}</div>
        <div class="user-info">
          <div class="user-name">${escHtml(u.name)}${verifiedBadge}</div>
          <div class="user-handle">${escHtml(u.username)}</div>
        </div>
      </div>`;
  }).join('');
}

function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Listen for live updates from content script
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'UPDATE' && msg.data) {
    allUsers = msg.data;
    updateCount(allUsers.length);
    renderList();
  }
});

// On popup open, fetch any existing data
(async () => {
  const tab = await getActiveTab();
  if (!tab || !isValidPage(tab.url)) {
    pageGuide.classList.add('show');
    return;
  }
  chrome.tabs.sendMessage(tab.id, { action: 'GET_DATA' }, (res) => {
    if (chrome.runtime.lastError || !res) return;
    allUsers = res.data || [];
    updateCount(allUsers.length);
    renderList();
  });
})();

// Init
updateCount(0);
renderList();
