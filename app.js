// ── Storage ───────────────────────────────────────────────────────────────────
const STORE_KEY = 'mlb_dfs_entries';
let entries = [];

function loadEntries() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); } catch { return []; }
}
function persist() {
  localStorage.setItem(STORE_KEY, JSON.stringify(entries));
}

document.addEventListener('DOMContentLoaded', () => {
  entries = loadEntries();
  setupDrop();
  renderAll();
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function g(id)  { return document.getElementById(id); }
function gv(id) { const e = g(id); return e ? e.value.trim() : ''; }

function todayISO() { return new Date().toISOString().split('T')[0]; }
function yesterdayISO() {
  const d = new Date(); d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

function showAlert(id, msg, type = 'success') {
  const el = g(id); if (!el) return;
  const icon = type === 'success' ? 'check' : type === 'danger' ? 'alert-circle' : 'info-circle';
  el.innerHTML = `<div class="alert ${type}"><i class="ti ti-${icon}"></i>${msg}</div>`;
  setTimeout(() => { el.innerHTML = ''; }, 6000);
}

function showTab(name, el) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  g('tab-' + name).classList.add('active');
  el.classList.add('active');
  if (name === 'dashboard') renderDashboard();
  if (name === 'history')   renderHistory();
}

// ── Contest classifier ────────────────────────────────────────────────────────
// Returns 'Cash' or 'GPP' based on contest name and optional FD opponent field
function classifyContest(name, opponent) {
  // FD provides Opponent field: "Tournament" = GPP, otherwise cash
  if (opponent && opponent.toLowerCase() !== 'tournament') return 'Cash';

  const n = (name || '').toLowerCase();

  const cashPatterns = [
    /double.?up/i, /50.?50/i, /fifty.?fifty/i,
    /head.?to.?head/i, /\bh2h\b/i, /\bduel\b/i,
    /multiplier/i, /\bsatellite\b/i,
    /\b(2|3|4|5|6|7|8|9|10).?x\b/i,   // 2x, 3x multiplier
    /\bsolo shot\b/i,                   // DK Solo Shot = Double Up
  ];

  for (const p of cashPatterns) {
    if (p.test(n)) return 'Cash';
  }
  return 'GPP';
}

// Finer-grained contest type label within the class
function contestType(name, opponent) {
  const n = (name || '').toLowerCase();
  if (/double.?up/i.test(n) || /solo shot/i.test(n)) return 'Double Up';
  if (/50.?50/i.test(n) || /fifty.?fifty/i.test(n))  return '50/50';
  if (/head.?to.?head/i.test(n) || /\bh2h\b/i.test(n) || /\bduel\b/i.test(n)) return 'H2H';
  if (/multiplier/i.test(n) || /\d.?x\b/i.test(n))   return 'Multiplier';
  if (opponent && opponent.toLowerCase() !== 'tournament') return 'Cash — Other';
  return 'GPP';
}

// ── CSV parsing ───────────────────────────────────────────────────────────────
function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = splitCSVRow(lines[0]).map(h => h.trim().replace(/^"|"$/g, '').toLowerCase());
  return lines.slice(1).filter(l => l.trim()).map(line => {
    const vals = splitCSVRow(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (vals[i] || '').trim().replace(/^"|"$/g, ''); });
    return obj;
  });
}

function splitCSVRow(row) {
  const res = []; let cur = ''; let inQ = false;
  for (let i = 0; i < row.length; i++) {
    const c = row[i];
    if      (c === '"' && !inQ)                    { inQ = true; }
    else if (c === '"' && inQ && row[i+1] === '"') { cur += '"'; i++; }
    else if (c === '"' && inQ)                     { inQ = false; }
    else if (c === ',' && !inQ)                    { res.push(cur); cur = ''; }
    else                                            { cur += c; }
  }
  res.push(cur);
  return res;
}

function parseMoney(str) {
  return parseFloat((str || '0').replace(/[$, ]/g, '')) || 0;
}

function stripDKSuffix(name) {
  return name.replace(/\s*\(\d+\/\d+\)\s*$/, '').trim();
}

function parseDKDate(str) {
  const m = (str || '').match(/^(\d+)\/(\d+)\/(\d+)/);
  if (!m) return null;
  const [, mo, d, y] = m;
  return `${y}-${mo.padStart(2,'0')}-${d.padStart(2,'0')}`;
}

function parseFDDate(str) {
  if (!str) return null;
  const iso = str.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) return `${us[3]}-${us[1].padStart(2,'0')}-${us[2].padStart(2,'0')}`;
  return null;
}

function detectSite(headers) {
  const h = headers.join(',');
  if (h.includes('entry_key') || h.includes('contest_key') || h.includes('winnings_non_ticket')) return 'DK';
  if (h.includes('entry id')  || h.includes('salarycap')   || h.includes('salary cap'))         return 'FD';
  return null;
}

function normalizeDK(rows) {
  return rows
    .filter(r => (r['sport'] || '').toUpperCase() === 'MLB')
    .map(r => {
      const contest    = stripDKSuffix(r['entry'] || '');
      const pts        = parseFloat(r['points']) || 0;
      const rank       = parseInt(r['place']) || null;
      const win        = +(parseMoney(r['winnings_non_ticket']) + parseMoney(r['winnings_ticket'])).toFixed(2);
      const placesPaid = parseInt(r['places_paid']) || 0;
      const entries    = parseInt(r['contest_entries']) || null;
      const fee        = parseMoney(r['entry_fee']);
      const date       = parseDKDate(r['contest_date_est'] || '');
      const cashed     = placesPaid > 0 && rank !== null ? (rank <= placesPaid ? 'Y' : 'N') : (win > 0 ? 'Y' : 'N');
      const cls        = classifyContest(contest, null);
      const ctype      = contestType(contest, null);
      return { contest, pts, rank, win, entries, fee, date, cashed, cls, ctype };
    })
    .filter(r => r.contest);
}

function normalizeFD(rows) {
  return rows
    .filter(r => (r['sport'] || '').toLowerCase() === 'mlb')
    .map(r => {
      const contest  = (r['title'] || '').trim();
      const pts      = parseFloat(r['score']) || 0;
      const rank     = parseInt(r['position']) || null;
      const win      = parseMoney(r['winnings ($)']);
      const entries  = parseInt(r['entries']) || null;
      const fee      = parseMoney(r['entry ($)']);
      const date     = parseFDDate(r['date'] || '');
      const opponent = r['opponent'] || '';
      const cashed   = win > 0 ? 'Y' : 'N';
      const cls      = classifyContest(contest, opponent);
      const ctype    = contestType(contest, opponent);
      return { contest, pts, rank, win, entries, fee, date, cashed, cls, ctype };
    })
    .filter(r => r.contest);
}

// ── Date filter helpers ───────────────────────────────────────────────────────
function setImportDateRange(preset) {
  const from = g('import-date-from'), to = g('import-date-to');
  if (!from || !to) return;
  if (preset === 'clear')     { from.value = ''; to.value = ''; return; }
  if (preset === 'today')     { from.value = todayISO();     to.value = todayISO();     return; }
  if (preset === 'yesterday') { from.value = yesterdayISO(); to.value = yesterdayISO(); return; }
  if (preset === 'week') {
    const d = new Date(); d.setDate(d.getDate() - 6);
    from.value = d.toISOString().split('T')[0];
    to.value   = todayISO();
  }
}

// ── Import flow ───────────────────────────────────────────────────────────────
function setupDrop() {
  const dz = g('drop-zone'); if (!dz) return;
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag-over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
  dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('drag-over'); handleFile(e.dataTransfer.files[0]); });
}

function handleFile(file) {
  if (!file || !file.name.endsWith('.csv')) {
    showAlert('import-alert', 'Please upload a .csv file.', 'danger'); return;
  }
  const reader = new FileReader();
  reader.onload = e => {
    const rows = parseCSV(e.target.result);
    if (!rows.length) { showAlert('import-alert', 'Could not parse CSV.', 'danger'); return; }
    const site = detectSite(Object.keys(rows[0]));
    if (!site) { showAlert('import-alert', 'Could not detect site — make sure this is a DK or FD export.', 'danger'); return; }

    let norm = site === 'FD' ? normalizeFD(rows) : normalizeDK(rows);
    if (!norm.length) { showAlert('import-alert', `No MLB rows found in this file.`, 'danger'); return; }

    // Date range filter
    const dateFrom = gv('import-date-from');
    const dateTo   = gv('import-date-to');
    if (dateFrom || dateTo) {
      norm = norm.filter(r => {
        if (!r.date) return false;
        if (dateFrom && r.date < dateFrom) return false;
        if (dateTo   && r.date > dateTo)   return false;
        return true;
      });
      if (!norm.length) {
        showAlert('import-alert', 'No rows found in that date range. Check the filter or clear it.', 'danger'); return;
      }
    } else if (norm.length > 50) {
      const go = confirm(`${norm.length} lineup rows found with no date filter — this looks like a full history export.\n\nUse the date range filter to narrow to a specific slate, or click OK to import all.`);
      if (!go) return;
    }

    renderPreview(norm, site);
  };
  reader.readAsText(file);
}

let pendingRows = [];

function renderPreview(rows, site) {
  pendingRows = rows;
  g('import-step1').style.display = 'none';
  g('import-step2').style.display = 'block';

  const gppCount  = rows.filter(r => r.cls === 'GPP').length;
  const cashCount = rows.filter(r => r.cls === 'Cash').length;
  const totalWin  = rows.reduce((a, r) => a + r.win, 0);
  const totalFee  = rows.reduce((a, r) => a + r.fee, 0);

  g('import-summary').innerHTML = `
    <h3>${site} — ${rows.length} lineup${rows.length !== 1 ? 's' : ''} ready to import</h3>
    <div class="summary-row"><span>GPP lineups</span><strong>${gppCount}</strong></div>
    <div class="summary-row"><span>Cash lineups</span><strong>${cashCount}</strong></div>
    <div class="summary-row"><span>Total entry fees</span><strong>$${totalFee.toFixed(2)}</strong></div>
    <div class="summary-row"><span>Total winnings</span><strong>$${totalWin.toFixed(2)}</strong></div>
    <div class="summary-row"><span>Net P/L</span><strong class="${totalWin - totalFee >= 0 ? 'pos' : 'neg'}">${totalWin - totalFee >= 0 ? '+' : ''}$${(totalWin - totalFee).toFixed(2)}</strong></div>`;

  // Preview table — first 15 rows
  const preview = rows.slice(0, 15);
  const moreRows = rows.length > 15 ? `<tr><td colspan="7" style="text-align:center;color:var(--gray-400);font-size:11px;padding:8px">… and ${rows.length - 15} more</td></tr>` : '';
  g('preview-table').innerHTML = `
    <div class="table-wrap" style="margin:1rem 0">
      <table>
        <thead><tr><th>Date</th><th>Contest</th><th>Class</th><th>Score</th><th>Rank</th><th>Fee</th><th>Winnings</th></tr></thead>
        <tbody>
          ${preview.map(r => `<tr>
            <td>${r.date || '—'}</td>
            <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis" title="${r.contest}">${r.contest}</td>
            <td><span class="badge ${r.cls === 'Cash' ? 'cash' : 'gpp'}">${r.cls}</span></td>
            <td>${r.pts.toFixed(1)}</td>
            <td>${r.rank || '—'}</td>
            <td>$${r.fee.toFixed(2)}</td>
            <td class="${r.win > 0 ? 'pos' : ''}">${r.win > 0 ? '$' + r.win.toFixed(2) : '—'}</td>
          </tr>`).join('')}
          ${moreRows}
        </tbody>
      </table>
    </div>`;
}

function confirmImport() {
  let added = 0, dupes = 0;
  pendingRows.forEach(r => {
    // Deduplicate: same date + contest + score + rank
    const isDupe = entries.some(e =>
      e.date === r.date && e.contest === r.contest &&
      e.pts === r.pts   && e.rank   === r.rank
    );
    if (isDupe) { dupes++; return; }
    entries.unshift({
      id:      Date.now() + Math.random(),
      date:    r.date,
      site:    pendingRows._site || detectSiteFromRow(r),
      contest: r.contest,
      cls:     r.cls,
      ctype:   r.ctype,
      fee:     r.fee,
      invested: r.fee,
      pts:     r.pts,
      rank:    r.rank,
      field:   r.entries,
      cashed:  r.cashed,
      win:     r.win,
      pl:      +(r.win - r.fee).toFixed(2),
    });
    added++;
  });
  persist();
  renderAll();
  const msg = dupes > 0
    ? `Imported ${added} lineup${added !== 1 ? 's' : ''}. ${dupes} duplicate${dupes !== 1 ? 's' : ''} skipped.`
    : `Imported ${added} lineup${added !== 1 ? 's' : ''}.`;
  showAlert('import-alert', msg);
  resetImport();
}

// Site isn't stored on the row — infer from the file being processed
// We'll tag pendingRows with _site in handleFile
function detectSiteFromRow(r) { return r._site || ''; }

// Patch handleFile to tag site on norm rows
const _origHandleFile = handleFile;

function handleFile(file) {
  if (!file || !file.name.endsWith('.csv')) {
    showAlert('import-alert', 'Please upload a .csv file.', 'danger'); return;
  }
  const reader = new FileReader();
  reader.onload = e => {
    const rows = parseCSV(e.target.result);
    if (!rows.length) { showAlert('import-alert', 'Could not parse CSV.', 'danger'); return; }
    const site = detectSite(Object.keys(rows[0]));
    if (!site) { showAlert('import-alert', 'Could not detect site — make sure this is a DK or FD export.', 'danger'); return; }

    let norm = site === 'FD' ? normalizeFD(rows) : normalizeDK(rows);
    if (!norm.length) { showAlert('import-alert', 'No MLB rows found in this file.', 'danger'); return; }

    // Tag site on each row
    norm.forEach(r => r._site = site);
    norm._site = site;

    const dateFrom = gv('import-date-from');
    const dateTo   = gv('import-date-to');
    if (dateFrom || dateTo) {
      norm = norm.filter(r => {
        if (!r.date) return false;
        if (dateFrom && r.date < dateFrom) return false;
        if (dateTo   && r.date > dateTo)   return false;
        return true;
      });
      // Re-tag after filter
      norm.forEach(r => r._site = site);
      if (!norm.length) {
        showAlert('import-alert', 'No rows found in that date range. Check the filter or clear it.', 'danger'); return;
      }
    } else if (norm.length > 50) {
      const go = confirm(`${norm.length} lineup rows found with no date filter — this looks like a full history export.\n\nUse the date range filter to narrow to a specific slate, or click OK to import all.`);
      if (!go) return;
    }

    renderPreview(norm, site);
  };
  reader.readAsText(file);
}

function resetImport() {
  pendingRows = [];
  g('import-step1').style.display = 'block';
  g('import-step2').style.display = 'none';
  g('csv-file').value = '';
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
function renderDashboard() {
  const all      = entries;
  const invested = all.reduce((a, e) => a + (e.invested || 0), 0);
  const winnings = all.reduce((a, e) => a + (e.win || 0), 0);
  const pl       = +(winnings - invested).toFixed(2);
  const roi      = invested > 0 ? pl / invested : 0;

  const cash     = all.filter(e => e.cls === 'Cash');
  const cashWins = cash.filter(e => e.cashed === 'Y').length;
  const cashRate = cash.length > 0 ? cashWins / cash.length : null;

  g('kpi-grid').innerHTML = [
    ['Total lineups',  all.length,                   '',                        ''],
    ['Total invested', '$' + invested.toFixed(2),    '',                        ''],
    ['Total winnings', '$' + winnings.toFixed(2),    '',                        ''],
    ['Net P/L',        (pl >= 0 ? '+' : '-') + '$' + Math.abs(pl).toFixed(2),
                       pl >= 0 ? 'pos' : 'neg',      ''],
    ['Overall ROI',    (roi * 100).toFixed(1) + '%', roi >= 0 ? 'pos' : 'neg', ''],
    ['Cash win rate',
      cashRate !== null ? (cashRate * 100).toFixed(0) + '%' : '—',
      cashRate !== null ? (cashRate >= 0.52 ? 'pos' : 'neg') : '',
      cashRate !== null ? 'target ≥52%' : 'no cash lineups yet'],
  ].map(([label, val, cls, sub]) =>
    `<div class="kpi">
      <div class="kpi-label">${label}</div>
      <div class="kpi-value ${cls}">${val}</div>
      ${sub ? `<div class="kpi-sub">${sub}</div>` : ''}
    </div>`).join('');

  // ── Breakdown tables ──────────────────────────────────────────────────────
  function bucket(keyFn) {
    const map = {};
    all.forEach(e => {
      const k = keyFn(e) || 'Unknown';
      if (!map[k]) map[k] = { n: 0, invested: 0, win: 0, cashes: 0 };
      map[k].n++;
      map[k].invested += e.invested || 0;
      map[k].win      += e.win      || 0;
      if (e.cashed === 'Y') map[k].cashes++;
    });
    return map;
  }

  function breakdownCard(title, map, order) {
    const keys = order ? order.filter(k => map[k]) : Object.keys(map).sort();
    if (!keys.length) return '';
    const rows = keys.map(k => {
      const d   = map[k];
      const pl  = +(d.win - d.invested).toFixed(2);
      const roi = d.invested > 0 ? (pl / d.invested * 100).toFixed(1) + '%' : '—';
      const wr  = d.n > 0 ? Math.round(d.cashes / d.n * 100) + '%' : '—';
      return `<tr>
        <td>${k}</td>
        <td style="text-align:right;color:var(--gray-500)">${d.n}</td>
        <td style="text-align:right;color:var(--gray-500)">$${d.invested.toFixed(2)}</td>
        <td style="text-align:right" class="${pl >= 0 ? 'pos' : 'neg'}">${pl >= 0 ? '+' : ''}$${Math.abs(pl).toFixed(2)}</td>
        <td style="text-align:right" class="${pl >= 0 ? 'pos' : 'neg'}">${roi}</td>
        <td style="text-align:right;color:var(--gray-500)">${wr}</td>
      </tr>`;
    }).join('');
    return `<div class="breakdown-card">
      <h3>${title}</h3>
      <table class="bd-table">
        <thead><tr><th></th><th>N</th><th>Invested</th><th>P/L</th><th>ROI</th><th>Win%</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }

  const clsMap  = bucket(e => e.cls);
  const siteMap = bucket(e => e.site);
  const typeMap = bucket(e => {
    // Group cash types, show GPP sub-types too
    return e.ctype || e.cls || 'Unknown';
  });

  // GPP vs Cash — show both overall metrics + cash-specific win rate target note
  const gppVsCash = breakdownCard('GPP vs Cash', clsMap, ['GPP', 'Cash']);
  const bySite    = breakdownCard('By site', siteMap, ['DK', 'FD']);
  const byType    = breakdownCard('By contest type', typeMap, ['GPP','Double Up','50/50','H2H','Multiplier','Cash — Other']);

  g('breakdown-grid').innerHTML = [gppVsCash, bySite, byType].filter(Boolean).join('') ||
    '<p style="font-size:13px;color:var(--gray-400);grid-column:1/-1;padding:1rem">Import results to see breakdowns.</p>';
}

// ── History ───────────────────────────────────────────────────────────────────
function renderHistory() {
  const sf = gv('hist-site'), cf = gv('hist-class'), rf = gv('hist-cashed');
  let data = [...entries];
  if (sf) data = data.filter(e => e.site   === sf);
  if (cf) data = data.filter(e => e.cls    === cf);
  if (rf) data = data.filter(e => e.cashed === rf);

  if (!data.length) {
    g('hist-table').innerHTML = '<div class="empty"><i class="ti ti-database-off"></i>No entries yet — import a results CSV to get started.</div>';
    return;
  }

  const rows = data.map(e => `<tr>
    <td>${e.date || '—'}</td>
    <td><span class="badge ${(e.site||'').toLowerCase()}">${e.site || '—'}</span></td>
    <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis" title="${e.contest}">${e.contest}</td>
    <td><span class="badge ${e.cls === 'Cash' ? 'cash' : 'gpp'}">${e.cls || '—'}</span></td>
    <td>$${(e.fee||0).toFixed(2)}</td>
    <td>${e.pts != null ? e.pts.toFixed(1) : '—'}</td>
    <td>${e.rank || '—'}</td>
    <td>${e.cashed || '—'}</td>
    <td class="${(e.pl||0) >= 0 ? 'pos' : 'neg'}">${(e.pl||0) >= 0 ? '+' : ''}$${Math.abs(e.pl||0).toFixed(2)}</td>
    <td><button class="btn danger" style="padding:4px 8px;font-size:11px" onclick="deleteEntry('${e.id}')"><i class="ti ti-trash"></i></button></td>
  </tr>`).join('');

  g('hist-table').innerHTML = `<table>
    <thead><tr>
      <th>Date</th><th>Site</th><th>Contest</th><th>Class</th>
      <th>Fee</th><th>Score</th><th>Rank</th><th>Cash</th><th>P/L</th><th></th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function deleteEntry(id) {
  if (!confirm('Remove this entry?')) return;
  entries = entries.filter(e => String(e.id) !== String(id));
  persist(); renderAll();
}

// ── Export CSV ────────────────────────────────────────────────────────────────
function exportCSV() {
  if (!entries.length) { alert('No entries to export.'); return; }
  const h = ['Date','Site','Contest','Class','Contest Type','Fee','Score','Rank','Field Size','Cashed','Winnings','P/L'];
  const rows = entries.map(e => [
    e.date, e.site, e.contest, e.cls, e.ctype, e.fee,
    e.pts, e.rank, e.field, e.cashed, e.win, e.pl,
  ].map(v => v == null ? '' : `"${String(v).replace(/"/g,'""')}"`));
  const csv = [h.join(','), ...rows.map(r => r.join(','))].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], {type:'text/csv'}));
  a.download = `mlb_dfs_${todayISO()}.csv`;
  a.click();
}

function renderAll() { renderDashboard(); renderHistory(); }
