// ── Popup just reads state from storage and sends commands to background ───

let pollingInterval = null;
let allResults = [];
let currentFilter = 'both'; // 'both', 'verified', 'unverified'

const scanBtn        = document.getElementById('scanBtn');
const stopBtn        = document.getElementById('stopBtn');
const statusBox      = document.getElementById('statusBox');
const progressBar    = document.getElementById('progressBar');
const progressWrap   = document.getElementById('progressWrap');
const queueBox       = document.getElementById('queueBox');
const queueList      = document.getElementById('queueList');
const resultsList    = document.getElementById('resultsList');
const resultsSection = document.getElementById('resultsSection');
const scannedCount   = document.getElementById('scannedCount');
const totalCount     = document.getElementById('totalCount');
const postsDoneEl    = document.getElementById('postsDone');
const copyAllBtn     = document.getElementById('copyAllBtn');
const exportCsvBtn   = document.getElementById('exportCsvBtn');
const exportTxtBtn   = document.getElementById('exportTxtBtn');
const filterSection  = document.getElementById('filterSection');
const filterStats    = document.getElementById('filterStats');
const totalStats     = document.getElementById('totalStats');

function escapeHtml(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function parseLinks(raw) {
  return [...new Set(
    raw.split(/\n/)
      .map(l => l.trim())
      .filter(l => (l.includes('x.com') || l.includes('twitter.com')) && l.includes('/status/'))
      .map(l => l.replace('twitter.com', 'x.com'))
  )];
}

function shortUrl(url) {
  try {
    const parts = url.split('/status/');
    const user = parts[0].split('/').pop();
    const id = parts[1]?.split('/')[0]?.split('?')[0];
    return `@${user} · ${id}`;
  } catch(e) { return url; }
}

function downloadFile(content, fileName, contentType) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: contentType }));
  a.download = fileName;
  a.click();
}

// Apply filter to results
function filterResults(items) {
  if (currentFilter === 'both') return items;
  if (currentFilter === 'verified') return items.filter(u => u.verified);
  if (currentFilter === 'unverified') return items.filter(u => !u.verified);
  return items;
}

// ── Render state from storage ──────────────────────────────────────────────
function renderState(state) {
  if (!state) return;

  // Status
  if (state.status) {
    statusBox.textContent = state.status;
    statusBox.style.color = state.statusColor || '#e6edf2';
    statusBox.classList.add('visible');
  }

  // Buttons
  const running = !!state.running;
  scanBtn.disabled = running;
  stopBtn.disabled = !running;

  // Progress bar
  if (state.progress != null) {
    progressWrap.classList.add('visible');
    progressBar.style.width = state.progress + '%';
  }

  // Queue
  if (state.links && state.links.length > 0) {
    queueBox.classList.add('visible');
    const icons = { pending: '⏳', active: '🔄', done: '✅', error: '❌', stopped: '⏸' };
    const classes = { pending: '', active: 'active', done: 'done', error: 'error', stopped: '' };
    queueList.innerHTML = state.links.map((url, i) => {
      const st = (state.queueStatus || [])[i] || 'pending';
      return `<div class="queue-item ${classes[st]}">
        <span class="q-icon">${icons[st]}</span>
        <span class="q-url" title="${escapeHtml(url)}">${escapeHtml(shortUrl(url))}</span>
      </div>`;
    }).join('');
  }

  // Results
  allResults = state.verified || [];
  const filtered = filterResults(allResults);
  const hasItems = allResults.length > 0;

  scannedCount.textContent = state.totalScanned || 0;
  totalCount.textContent = allResults.length;
  totalStats.textContent = allResults.length;
  filterStats.textContent = filtered.length;
  postsDoneEl.textContent = state.postsDone || 0;
  
  copyAllBtn.disabled = !hasItems;
  exportCsvBtn.disabled = !hasItems;
  exportTxtBtn.disabled = !hasItems;

  if (hasItems) {
    resultsSection.classList.add('visible');
    filterSection.classList.add('visible');
    resultsList.innerHTML = filtered.map(u => `
      <div class="result-item">
        <span class="tick">${u.verified ? '✅' : '○'}</span>
        <span class="name">${escapeHtml(u.displayName)}</span>
        <span class="handle">@${escapeHtml(u.username)}</span>
        <a href="https://x.com/${escapeHtml(u.username)}" target="_blank">View</a>
      </div>
    `).join('');
  } else if (state.links) {
    resultsSection.classList.add('visible');
    filterSection.classList.remove('visible');
    resultsList.innerHTML = '<div class="empty-state">Results will appear here as posts are scanned.</div>';
  }
}

// Poll storage every second to update UI
function startPolling() {
  if (pollingInterval) return;
  pollingInterval = setInterval(() => {
    chrome.storage.local.get(['scanState'], (res) => {
      renderState(res.scanState);
      if (!res.scanState?.running) stopPolling();
    });
  }, 1000);
}

function stopPolling() {
  if (pollingInterval) { clearInterval(pollingInterval); pollingInterval = null; }
}

// ── Buttons ────────────────────────────────────────────────────────────────
scanBtn.addEventListener('click', () => {
  const raw = document.getElementById('linksInput').value;
  const links = parseLinks(raw);
  if (links.length === 0) {
    statusBox.textContent = '⚠️ No valid X post links found.';
    statusBox.style.color = '#e3b341';
    statusBox.classList.add('visible');
    return;
  }
  const scrollLimit = parseInt(document.getElementById('scrollLimit').value, 10) || 40;

  chrome.runtime.sendMessage({ type: 'START_SCAN', links, scrollLimit });
  startPolling();
});

stopBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'STOP_SCAN' });
});

copyAllBtn.addEventListener('click', () => {
  const filtered = filterResults(allResults);
  if (!filtered.length) return;
  navigator.clipboard.writeText(filtered.map(u => '@' + u.username).join('\n')).then(() => {
    copyAllBtn.textContent = '✅ Copied!';
    copyAllBtn.classList.add('copied');
    setTimeout(() => { copyAllBtn.textContent = '📋 Copy'; copyAllBtn.classList.remove('copied'); }, 2000);
  });
});

exportCsvBtn.addEventListener('click', () => {
  const filtered = filterResults(allResults);
  if (!filtered.length) return;
  const rows = ['Display Name,Username,Verified,Profile URL'];
  filtered.forEach(u => rows.push(`"${u.displayName.replace(/"/g,'""')}",@${u.username},${u.verified ? 'Yes' : 'No'},https://x.com/${u.username}`));
  downloadFile(rows.join('\n'), 'x_commenters_filtered.csv', 'text/csv;charset=utf-8;');
});

exportTxtBtn.addEventListener('click', () => {
  const filtered = filterResults(allResults);
  if (!filtered.length) return;
  downloadFile(filtered.map(u => '@' + u.username).join('\n'), 'x_commenters_handles.txt', 'text/plain;charset=utf-8;');
});

// ── On popup open: restore state and resume polling if running ─────────────
chrome.storage.local.get(['scanState', 'savedLinks'], (res) => {
  if (res.savedLinks) document.getElementById('linksInput').value = res.savedLinks;
  if (res.scanState) {
    renderState(res.scanState);
    if (res.scanState.running) startPolling();
  }
});

document.getElementById('linksInput').addEventListener('input', (e) => {
  chrome.storage.local.set({ savedLinks: e.target.value });
});

// ── Filter buttons ─────────────────────────────────────────────────────────
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    currentFilter = btn.dataset.filter;
    
    // Update active state
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    
    // Re-render results with new filter
    renderState({
      verified: allResults,
      totalScanned: parseInt(scannedCount.textContent) || 0,
      postsDone: parseInt(postsDoneEl.textContent) || 0,
      links: [] // placeholder
    });
  });
});
