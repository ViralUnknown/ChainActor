// popup.js

const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const countEl = document.getElementById('count');
const verifiedCountEl = document.getElementById('verifiedCount');
const statusEl = document.getElementById('status');
const copyBtn = document.getElementById('copyBtn');
const downloadBtn = document.getElementById('downloadBtn');
const clearBtn = document.getElementById('clearBtn');
const preview = document.getElementById('preview');
const previewContainer = document.getElementById('previewContainer');
const filterAllBtn = document.getElementById('filterAll');
const filterVerifiedBtn = document.getElementById('filterVerified');

let allFollowers = [];
let isRunning = false;
let filterMode = 'all'; // 'all' | 'verified'

function updateUI(followers) {
  allFollowers = followers;
  const verified = followers.filter(f => f.isVerified).length;

  countEl.textContent = followers.length;
  verifiedCountEl.textContent = verified;

  if (followers.length > 0) {
    previewContainer.style.display = 'block';
    preview.innerHTML = '';

    followers.slice(0, 15).forEach(f => {
      const div = document.createElement('div');
      div.className = 'preview-item';
      if (f.isVerified) div.classList.add('verified');
      div.textContent = f.username + (f.isVerified ? ' ✓' : '');
      preview.appendChild(div);
    });

    if (followers.length > 15) {
      const more = document.createElement('div');
      more.className = 'preview-item';
      more.textContent = `... and ${followers.length - 15} more`;
      preview.appendChild(more);
    }
  }
}

function setStatus(text, type = 'normal') {
  statusEl.textContent = text;
  statusEl.classList.remove('success', 'error', 'running');
  if (type === 'success') statusEl.classList.add('success');
  if (type === 'error') statusEl.classList.add('error');
  if (type === 'running') statusEl.classList.add('running');
}

function setFilterMode(mode) {
  filterMode = mode;
  filterAllBtn.classList.toggle('active', mode === 'all');
  filterVerifiedBtn.classList.toggle('active', mode === 'verified');
}

// Small helper so we don't chain .catch() onto a callback-style API,
// which is what silently broke messaging before.
function sendMessageToActiveTab(message, onSuccess, onError) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) {
      if (onError) onError(new Error('No active tab'));
      return;
    }
    chrome.tabs.sendMessage(tabs[0].id, message, (response) => {
      if (chrome.runtime.lastError) {
        if (onError) onError(chrome.runtime.lastError);
        return;
      }
      if (onSuccess) onSuccess(response);
    });
  });
}

// Load data from storage on popup open
chrome.storage.local.get(['myFollowers'], (result) => {
  if (result.myFollowers) {
    updateUI(result.myFollowers);
  }
});

// Listen for updates from content script
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'UPDATE') {
    updateUI(msg.data);
    isRunning = msg.isRunning;
    setStatus(`⏳ Extracting... (${msg.count} found)`, 'running');
    startBtn.disabled = isRunning;
    stopBtn.disabled = !isRunning;
  } else if (msg.type === 'FINISHED') {
    isRunning = false;
    setStatus(`✅ Done! Extracted ${msg.total} followers`, 'success');
    startBtn.disabled = false;
    stopBtn.disabled = true;
  }
});

filterAllBtn.addEventListener('click', () => {
  if (isRunning) return;
  setFilterMode('all');
});

filterVerifiedBtn.addEventListener('click', () => {
  if (isRunning) return;
  setFilterMode('verified');
});

startBtn.addEventListener('click', () => {
  setStatus('⏳ Starting extraction...', 'running');
  startBtn.disabled = true;
  stopBtn.disabled = false;

  sendMessageToActiveTab(
    { action: 'START', filterMode },
    () => {
      setStatus('⏳ Extracting... (you can close this popup, it keeps going)', 'running');
      isRunning = true;
    },
    () => {
      setStatus('❌ Not on X.com — open x.com and try again', 'error');
      startBtn.disabled = false;
      stopBtn.disabled = true;
    }
  );
});

stopBtn.addEventListener('click', () => {
  setStatus('🛑 Stopping...', 'normal');
  stopBtn.disabled = true;

  sendMessageToActiveTab(
    { action: 'STOP' },
    (response) => {
      if (response) {
        setStatus(`✅ Stopped! Extracted ${response.count} followers`, 'success');
        startBtn.disabled = false;
        isRunning = false;
      }
    },
    () => {
      setStatus('❌ Could not reach the page', 'error');
      startBtn.disabled = false;
    }
  );
});

copyBtn.addEventListener('click', async () => {
  if (allFollowers.length === 0) {
    setStatus('Nothing to copy yet', 'error');
    return;
  }

  const text = allFollowers.map(f => f.username).join('\n');

  try {
    await navigator.clipboard.writeText(text);
    copyBtn.textContent = '✅ Copied!';
  } catch (err) {
    // Fallback: clipboard API can fail in a popup context (focus/permissions).
    // Use a hidden textarea + execCommand as a reliable backup.
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      copyBtn.textContent = '✅ Copied!';
    } catch (fallbackErr) {
      copyBtn.textContent = '❌ Copy failed';
      console.error('Copy failed:', err, fallbackErr);
    }
  }

  setTimeout(() => {
    copyBtn.textContent = '📋 Copy All';
  }, 2000);
});

downloadBtn.addEventListener('click', () => {
  if (allFollowers.length === 0) {
    setStatus('Nothing to download yet', 'error');
    return;
  }

  const timestamp = new Date().toISOString().split('T')[0];
  const filename = `my_followers_${timestamp}.txt`;

  const text = allFollowers.map(f => f.username).join('\n');
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();

  URL.revokeObjectURL(url);
});

clearBtn.addEventListener('click', () => {
  if (confirm('Clear all extracted followers?')) {
    sendMessageToActiveTab(
      { action: 'CLEAR' },
      () => {
        allFollowers = [];
        countEl.textContent = '0';
        verifiedCountEl.textContent = '0';
        previewContainer.style.display = 'none';
        setStatus('Cleared', 'normal');
        startBtn.disabled = false;
        stopBtn.disabled = true;
      },
      () => {
        setStatus('❌ Could not reach the page', 'error');
      }
    );
  }
});

// Check if already running on popup open
sendMessageToActiveTab(
  { action: 'GET_DATA' },
  (response) => {
    if (response && response.isRunning) {
      startBtn.disabled = true;
      stopBtn.disabled = false;
      isRunning = true;
      setStatus('⏳ Currently extracting...', 'running');
    }
  },
  () => {
    // Not on X.com or content script not present yet — fine, just stay idle.
  }
);
