// ═══════════════════════════════════════════════════════════════════
// POPUP.JS — Display layer only.
// All scraping is in background.js. Popup just:
//   1. Sends commands (START / STOP / CLEAR)
//   2. Polls chrome.storage every second to update UI
//   3. Handles filtering + export on the results it reads
// ═══════════════════════════════════════════════════════════════════

let pollingInterval = null;
let allResults = [];
let filteredResults = [];
let activeFilters = []; // [{value, mode}]
let sortCol = null;
let sortDir = 1;

// Quick preset regions
const PRESETS = [
  { label: '🇳🇬 Nigeria', value: 'Nigeria' },
  { label: '🇬🇭 Ghana', value: 'Ghana' },
  { label: '🇿🇦 South Africa', value: 'South Africa' },
  { label: '🇺🇸 USA', value: 'United States' },
  { label: '🇬🇧 UK', value: 'United Kingdom' },
  { label: '🇨🇦 Canada', value: 'Canada' },
  { label: '🇯🇵 Japan', value: 'Japan' },
  { label: '🇰🇷 Korea', value: 'Korea' },
  { label: '🇮🇳 India', value: 'India' },
];

// ── DOM refs ─────────────────────────────────────────────────────────────────
const scanBtn         = document.getElementById('scanBtn');
const stopBtn         = document.getElementById('stopBtn');
const clearBtn        = document.getElementById('clearBtn');
const statusBox       = document.getElementById('statusBox');
const progressBar     = document.getElementById('progressBar');
const progressWrap    = document.getElementById('progressWrap');
const filterSection   = document.getElementById('filterSection');
const filterInput     = document.getElementById('filterInput');
const filterMode      = document.getElementById('filterMode');
const filterTags      = document.getElementById('filterTags');
const filterCount     = document.getElementById('filterCount');
const statsRow        = document.getElementById('statsRow');
const totalCount      = document.getElementById('totalCount');
const showingCount    = document.getElementById('showingCount');
const errorCount      = document.getElementById('errorCount');
const resultsWrap     = document.getElementById('resultsWrap');
const resultsBody     = document.getElementById('resultsBody');
const exportRow       = document.getElementById('exportRow');
const copyBtn         = document.getElementById('copyBtn');
const exportCsvBtn    = document.getElementById('exportCsvBtn');
const exportFilteredBtn = document.getElementById('exportFilteredBtn');

// New Cookie DOM refs
const cookiesHeader      = document.getElementById('cookiesHeader');
const cookiesContent     = document.getElementById('cookiesContent');
const cookieSwitchToggle = document.getElementById('cookieSwitchToggle');
const cookieInput        = document.getElementById('cookieInput');

// ── Helpers ───────────────────────────────────────────────────────────────────
function escHtml(s) {
  return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function parseUsernames(raw) {
  return [...new Set(
    raw.split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0)
      .map(l => {
        // Full URL: extract username
        if (l.includes('x.com/') || l.includes('twitter.com/')) {
          const m = l.match(/(?:x\.com|twitter\.com)\/([A-Za-z0-9_]{1,15})/);
          return m ? m[1] : null;
        }
        // @handle or plain handle
        return l.replace(/^@/, '').replace(/\/$/, '');
      })
      .filter(u => u && /^[A-Za-z0-9_]{1,15}$/.test(u))
  )];
}

// Parse cookies text inputs into array of cookies arrays (e.g. [[{name, value}, ...], ...])
function parseCookiesInput(raw) {
  return raw.split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => {
      // If it contains '=' and looks like a cookie string: name1=val1; name2=val2
      if (line.includes('=')) {
        return line.split(';').map(part => {
          const eq = part.indexOf('=');
          if (eq === -1) return null;
          const name = part.substring(0, eq).trim();
          const value = part.substring(eq + 1).trim();
          if (!name || !value) return null;
          return { name, value };
        }).filter(Boolean);
      } else {
        // Otherwise, treat the whole line as the auth_token value itself
        return [{ name: 'auth_token', value: line }];
      }
    })
    .filter(arr => arr.length > 0);
}

function downloadFile(content, name, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
}

// ── Filter logic ──────────────────────────────────────────────────────────────
function applyFilters(results) {
  if (activeFilters.length === 0) return results;

  return results.filter(r => {
    const basedIn = (r.accountBasedIn || '').toLowerCase();
    const connVia = (r.connectedVia || '').toLowerCase();

    for (const f of activeFilters) {
      const val = f.value.toLowerCase();
      const matches = basedIn.includes(val) || connVia.includes(val);
      if (f.mode === 'include' && !matches) return false;
      if (f.mode === 'exclude' && matches) return false;
    }
    return true;
  });
}

function buildPresetTags() {
  filterTags.innerHTML = PRESETS.map(p => `
    <span class="filter-tag" data-value="${escHtml(p.value)}">${escHtml(p.label)}</span>
  `).join('');

  filterTags.querySelectorAll('.filter-tag').forEach(tag => {
    tag.addEventListener('click', () => {
      const val = tag.dataset.value;
      const mode = filterMode.value;
      const existing = activeFilters.findIndex(f => f.value === val);
      if (existing >= 0) {
        activeFilters.splice(existing, 1);
        tag.className = 'filter-tag';
      } else {
        activeFilters.push({ value: val, mode });
        tag.className = `filter-tag active-${mode}`;
      }
      renderTable();
    });
  });
}

// ── Table rendering ───────────────────────────────────────────────────────────
function renderTable() {
  filteredResults = applyFilters(allResults);

  // Sort
  if (sortCol) {
    filteredResults.sort((a, b) => {
      const av = (a[sortCol] || '').toLowerCase();
      const bv = (b[sortCol] || '').toLowerCase();
      return av < bv ? -sortDir : av > bv ? sortDir : 0;
    });
  }

  // Stats
  const errors = allResults.filter(r => r.status === 'error').length;
  totalCount.textContent = allResults.length;
  showingCount.textContent = filteredResults.length;
  errorCount.textContent = errors;
  filterCount.textContent = activeFilters.length > 0 ? `${filteredResults.length} shown` : '';

  const hasResults = allResults.length > 0;
  const hasFiltered = filteredResults.length > 0;

  statsRow.style.display = hasResults ? 'flex' : 'none';
  resultsWrap.classList.toggle('visible', hasResults);
  exportRow.style.display = hasResults ? 'flex' : 'none';
  filterSection.classList.toggle('visible', hasResults);

  copyBtn.disabled = !hasFiltered;
  exportCsvBtn.disabled = !hasResults;
  exportFilteredBtn.disabled = !hasFiltered;

  if (filteredResults.length === 0) {
    resultsBody.innerHTML = `<tr><td colspan="4" class="no-results">No results match the current filter.</td></tr>`;
    return;
  }

  resultsBody.innerHTML = filteredResults.map(r => `
    <tr>
      <td class="username"><a href="${escHtml(r.profileUrl)}" target="_blank">@${escHtml(r.username)}</a></td>
      <td class="${r.accountBasedIn === '—' ? 'dim' : ''}">${escHtml(r.accountBasedIn)}</td>
      <td class="${r.connectedVia === '—' ? 'dim' : ''}">${escHtml(r.connectedVia)}</td>
      <td>
        ${r.verified ? '<span class="badge badge-verified">✓</span>' : ''}
        ${r.status === 'error' ? '<span class="badge badge-error">err</span>' : ''}
      </td>
    </tr>
  `).join('');
}

// ── State renderer (called every poll tick) ───────────────────────────────────
function renderState(state) {
  if (!state) return;

  // Status bar
  if (state.status) {
    statusBox.textContent = state.status;
    statusBox.style.color = state.statusColor || '#e6edf2';
    statusBox.classList.add('visible');
  }

  // Buttons
  scanBtn.disabled = !!state.running;
  stopBtn.disabled = !state.running;

  // Progress
  if (state.progress != null) {
    progressWrap.classList.add('visible');
    progressBar.style.width = state.progress + '%';
  }

  // Results
  if (state.results) {
    allResults = state.results;
    renderTable();
  }
}

// ── Polling: reads storage every second ──────────────────────────────────────
function startPolling() {
  if (pollingInterval) return;
  pollingInterval = setInterval(() => {
    chrome.storage.local.get(['aboutState'], res => {
      renderState(res.aboutState);
      if (!res.aboutState?.running) stopPolling();
    });
  }, 1000);
}

// ── Toggle Cookies Accordion Panel ──────────────────────────────────────────
cookiesHeader.addEventListener('click', () => {
  const isExpanded = cookiesContent.classList.toggle('expanded');
  cookiesHeader.classList.toggle('active', isExpanded);
  chrome.storage.local.set({ cookiesPanelExpanded: isExpanded });
});

function stopPolling() {
  if (pollingInterval) { clearInterval(pollingInterval); pollingInterval = null; }
}

// ── Button handlers ───────────────────────────────────────────────────────────
scanBtn.addEventListener('click', () => {
  const raw = document.getElementById('usernameInput').value;
  const usernames = parseUsernames(raw);
  if (usernames.length === 0) {
    statusBox.textContent = '⚠️ No valid usernames or links found.';
    statusBox.style.color = '#e3b341';
    statusBox.classList.add('visible');
    return;
  }
  allResults = [];
  renderTable();

  // Send cookie rotation configuration
  const useCookieSwitching = cookieSwitchToggle.checked;
  const cookiesList = parseCookiesInput(cookieInput.value);

  chrome.runtime.sendMessage({
    type: 'START_SCAN',
    usernames,
    useCookieSwitching,
    cookies: cookiesList
  });
  startPolling();
});

stopBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'STOP_SCAN' });
});

clearBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'CLEAR_DATA' });
  allResults = [];
  activeFilters = [];
  buildPresetTags();
  renderTable();
  statusBox.classList.remove('visible');
  progressWrap.classList.remove('visible');
  progressBar.style.width = '0%';
});

// Filter input
filterInput.addEventListener('input', () => renderTable());
filterInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const val = filterInput.value.trim();
    if (val) {
      activeFilters.push({ value: val, mode: filterMode.value });
      filterInput.value = '';
      renderTable();
    }
  }
});

// Sort headers
document.querySelectorAll('thead th.sortable').forEach(th => {
  th.addEventListener('click', () => {
    const col = th.dataset.col;
    if (sortCol === col) { sortDir *= -1; }
    else { sortCol = col; sortDir = 1; }
    renderTable();
  });
});

// Copy usernames
copyBtn.addEventListener('click', () => {
  const text = filteredResults.map(r => '@' + r.username).join('\n');
  navigator.clipboard.writeText(text).then(() => {
    copyBtn.textContent = '✅ Copied!';
    copyBtn.classList.add('copied');
    setTimeout(() => { copyBtn.textContent = '📋 Copy Usernames'; copyBtn.classList.remove('copied'); }, 2000);
  });
});

// Export all CSV
exportCsvBtn.addEventListener('click', () => {
  const rows = ['Username,Profile URL,Account Based In,Connected Via,Verified,Date Joined'];
  allResults.forEach(r => {
    rows.push(`@${r.username},${r.profileUrl},"${r.accountBasedIn}","${r.connectedVia}",${r.verified ? 'Yes' : 'No'},"${r.dateJoined}"`);
  });
  downloadFile(rows.join('\n'), 'x_regions_all.csv', 'text/csv;charset=utf-8;');
});

// Export filtered CSV
exportFilteredBtn.addEventListener('click', () => {
  const rows = ['Username,Profile URL,Account Based In,Connected Via,Verified,Date Joined'];
  filteredResults.forEach(r => {
    rows.push(`@${r.username},${r.profileUrl},"${r.accountBasedIn}","${r.connectedVia}",${r.verified ? 'Yes' : 'No'},"${r.dateJoined}"`);
  });
  downloadFile(rows.join('\n'), 'x_regions_filtered.csv', 'text/csv;charset=utf-8;');
});

// ── Init ──────────────────────────────────────────────────────────────────────
buildPresetTags();

// Restore saved inputs
chrome.storage.local.get(['aboutState', 'savedUsernames', 'savedCookies', 'cookieSwitchEnabled', 'cookiesPanelExpanded'], res => {
  if (res.savedUsernames) document.getElementById('usernameInput').value = res.savedUsernames;
  if (res.savedCookies) cookieInput.value = res.savedCookies;
  cookieSwitchToggle.checked = !!res.cookieSwitchEnabled;

  if (res.cookiesPanelExpanded) {
    cookiesContent.classList.add('expanded');
    cookiesHeader.classList.add('active');
  }

  if (res.aboutState) {
    renderState(res.aboutState);
    if (res.aboutState.running) startPolling();
  }
});

document.getElementById('usernameInput').addEventListener('input', e => {
  chrome.storage.local.set({ savedUsernames: e.target.value });
});

cookieInput.addEventListener('input', e => {
  chrome.storage.local.set({ savedCookies: e.target.value });
});

cookieSwitchToggle.addEventListener('change', e => {
  chrome.storage.local.set({ cookieSwitchEnabled: e.target.checked });
});
