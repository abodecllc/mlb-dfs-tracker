// - Storage -
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

// - Helpers -
function g(id)  { return document.getElementById(id); }
function gv(id) { const e = g(id); return e ? e.value.trim() : ''; }

function todayISO() { return new Date().toISOString().split('T')[0]; }
function yesterdayISO() {
  const d = new Date(); d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

function showAlert(id, msg, type = 'success', duration = 6000) {
  const el = g(id); if (!el) return;
  const icon = type === 'success' ? 'check' : type === 'danger' ? 'alert-circle' : 'info-circle';
  el.innerHTML = `<div class="alert ${type}"><i class="ti ti-${icon}"></i>${msg}</div>`;
  setTimeout(() => { el.innerHTML = ''; }, duration);
}

function showTab(name, el) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  g('tab-' + name).classList.add('active');
  el.classList.add('active');
  if (name === 'dashboard') renderDashboard();
  if (name === 'history')   renderHistory();
}

// - Contest classifier -
// Returns 'Cash' or 'GPP' based on contest name and optional FD opponent field
function classifyContest(name, opponent) {
  const n = (name || '').toLowerCase();

  // WTA / Satellite — check before Cash since these are a distinct format
  if (/\bsatellite\b/i.test(n) || /winner.?take.?all/i.test(n) || /\bwta\b/i.test(n)) return 'WTA';

  // FD: Opponent field is reliable - anything not "Tournament" is cash
  if (opponent && opponent.toLowerCase() !== 'tournament') return 'Cash';

  // DK: Only true cash contest is Double Up (top ~44-46% pay out)
  if (/double.?up/i.test(n)) return 'Cash';

  // FD cash names
  if (/50.?50/i.test(n) || /fifty.?fifty/i.test(n)) return 'Cash';
  if (/head.?to.?head/i.test(n) || /\bh2h\b/i.test(n) || /\bduel\b/i.test(n)) return 'Cash';
  if (/\bbean ball\b/i.test(n)) return 'Cash'; // FD Double Up

  return 'GPP';
}

// Finer-grained contest type label
function contestType(name, opponent) {
  const n = (name || '').toLowerCase();
  if (/\bsatellite\b/i.test(n) || /winner.?take.?all/i.test(n) || /\bwta\b/i.test(n)) return 'Satellite/WTA';
  if (/double.?up/i.test(n)) return 'Double Up';
  if (/\bbean ball\b/i.test(n)) return 'Double Up'; // FD
  if (/50.?50/i.test(n) || /fifty.?fifty/i.test(n)) return '50/50';
  if (/head.?to.?head/i.test(n) || /\bh2h\b/i.test(n) || /\bduel\b/i.test(n)) return 'H2H';
  if (opponent && opponent.toLowerCase() !== 'tournament') return 'Cash - Other';
  return 'GPP';
}

// - CSV parsing -
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
  if (!str) return null;
  // Format: "2025-05-05 19:15:00" or "2025-05-05T19:15:00"
  const iso = str.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  // Format: "6/1/2026 19:10"
  const us = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (us) return `${us[3]}-${us[1].padStart(2,'0')}-${us[2].padStart(2,'0')}`;
  return null;
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

// - Date filter helpers -
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

// - Import flow -
function setupDrop() {
  const dz = g('drop-zone'); if (!dz) return;
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag-over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
  dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('drag-over'); handleFile(e.dataTransfer.files[0]); });
}


function renderPreview(rows, site) {
  pendingRows = rows;
  g('import-step1').style.display = 'none';
  g('import-step2').style.display = 'block';

  const gppCount  = rows.filter(r => r.cls === 'GPP').length;
  const cashCount = rows.filter(r => r.cls === 'Cash').length;
  const totalWin  = rows.reduce((a, r) => a + r.win, 0);
  const totalFee  = rows.reduce((a, r) => a + r.fee, 0);

  g('import-summary').innerHTML = `
    <h3>${site} - ${rows.length} lineup${rows.length !== 1 ? 's' : ''} ready to import</h3>
    <div class="summary-row"><span>GPP lineups</span><strong>${gppCount}</strong></div>
    <div class="summary-row"><span>Cash lineups</span><strong>${cashCount}</strong></div>
    <div class="summary-row"><span>Total entry fees</span><strong>$${totalFee.toFixed(2)}</strong></div>
    <div class="summary-row"><span>Total winnings</span><strong>$${totalWin.toFixed(2)}</strong></div>
    <div class="summary-row"><span>Net P/L</span><strong class="${totalWin - totalFee >= 0 ? 'pos' : 'neg'}">${totalWin - totalFee >= 0 ? '+' : ''}$${(totalWin - totalFee).toFixed(2)}</strong></div>`;

  // Preview table - first 15 rows
  const preview = rows.slice(0, 15);
  const moreRows = rows.length > 15 ? `<tr><td colspan="7" style="text-align:center;color:var(--gray-400);font-size:11px;padding:8px">- and ${rows.length - 15} more</td></tr>` : '';
  g('preview-table').innerHTML = `
    <div class="table-wrap" style="margin:1rem 0">
      <table>
        <thead><tr><th>Date</th><th>Contest</th><th>Class</th><th>Score</th><th>Rank</th><th>Fee</th><th>Winnings</th></tr></thead>
        <tbody>
          ${preview.map(r => `<tr>
            <td>${r.date || '-'}</td>
            <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis" title="${r.contest}">${r.contest}</td>
            <td><span class="badge ${r.cls === 'Cash' ? 'cash' : r.cls === 'WTA' ? 'wta' : 'gpp'}">${r.cls}</span></td>
            <td>${r.pts.toFixed(1)}</td>
            <td>${r.rank || '-'}</td>
            <td>$${r.fee.toFixed(2)}</td>
            <td class="${r.win > 0 ? 'pos' : ''}">${r.win > 0 ? '$' + r.win.toFixed(2) : '-'}</td>
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

// Site isn't stored on the row - infer from the file being processed
// We'll tag pendingRows with _site in handleFile
function detectSiteFromRow(r) { return r._site || ''; }

function handleFile(file) {
  if (!file || !file.name.endsWith('.csv')) {
    showAlert('import-alert', 'Please upload a .csv file.', 'danger'); return;
  }
  const reader = new FileReader();
  reader.onload = e => {
    const rows = parseCSV(e.target.result);
    if (!rows.length) { showAlert('import-alert', 'Could not parse CSV.', 'danger'); return; }
    const site = detectSite(Object.keys(rows[0]));
    if (!site) { showAlert('import-alert', 'Could not detect site - make sure this is a DK or FD export.', 'danger'); return; }

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
      const go = confirm(`${norm.length} lineup rows found with no date filter - this looks like a full history export.\n\nUse the date range filter to narrow to a specific slate, or click OK to import all.`);
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

// - Dashboard -
function renderDashboard() {
  const all      = entries;
  const invested = all.reduce((a, e) => a + (e.invested || 0), 0);
  const winnings = all.reduce((a, e) => a + (e.win || 0), 0);
  const pl       = +(winnings - invested).toFixed(2);
  const roi      = invested > 0 ? pl / invested : 0;

  const cash     = all.filter(e => e.cls === 'Cash');
  const cashWins = cash.filter(e => e.cashed === 'Y').length;
  const cashRate = cash.length > 0 ? cashWins / cash.length : null;

  const wta      = all.filter(e => e.cls === 'WTA');
  const wtaWins  = wta.filter(e => e.cashed === 'Y').length;
  const wtaInv   = wta.reduce((a, e) => a + (e.invested || 0), 0);
  const wtaWin   = wta.reduce((a, e) => a + (e.win || 0), 0);
  const wtaROI   = wtaInv > 0 ? ((wtaWin - wtaInv) / wtaInv * 100).toFixed(1) : null;

  const gpp      = all.filter(e => e.cls === 'GPP');
  const gppInv   = gpp.reduce((a, e) => a + (e.invested || 0), 0);
  const gppWin   = gpp.reduce((a, e) => a + (e.win || 0), 0);
  const gppROI   = gppInv > 0 ? ((gppWin - gppInv) / gppInv * 100).toFixed(1) : null;

  g('kpi-grid').innerHTML = [
    ['Total lineups',   all.length,                                           '',                        ''],
    ['Total invested',  '$' + invested.toFixed(2),                            '',                        ''],
    ['Total winnings',  '$' + winnings.toFixed(2),                            '',                        ''],
    ['Net P/L',         (pl >= 0 ? '+' : '-') + '$' + Math.abs(pl).toFixed(2), pl >= 0 ? 'pos' : 'neg', ''],
    ['Overall ROI',     (roi * 100).toFixed(1) + '%',                         roi >= 0 ? 'pos' : 'neg', ''],
    ['Cash win rate',
      cashRate !== null ? (cashRate * 100).toFixed(0) + '%' : '-',
      cashRate !== null ? (cashRate >= 0.52 ? 'pos' : 'neg') : '',
      cashRate !== null ? `${cash.length} entries · target 52%` : 'no cash lineups yet'],
    ['GPP ROI',
      gppROI !== null ? gppROI + '%' : '-',
      gppROI !== null ? (parseFloat(gppROI) >= 0 ? 'pos' : 'neg') : '',
      gppROI !== null ? `${gpp.length} entries` : 'no GPP lineups yet'],
    ['WTA / Satellite',
      wtaROI !== null ? wtaROI + '%' : '-',
      wtaROI !== null ? (parseFloat(wtaROI) >= 0 ? 'pos' : 'neg') : '',
      wtaROI !== null ? `${wta.length} entries · ${wtaWins} wins` : 'no WTA lineups yet'],
  ].map(([label, val, cls, sub]) =>
    `<div class="kpi">
      <div class="kpi-label">${label}</div>
      <div class="kpi-value ${cls}">${val}</div>
      ${sub ? `<div class="kpi-sub">${sub}</div>` : ''}
    </div>`).join('');

  // - Breakdown tables -
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
      const roi = d.invested > 0 ? (pl / d.invested * 100).toFixed(1) + '%' : '-';
      const wr  = d.n > 0 ? Math.round(d.cashes / d.n * 100) + '%' : '-';
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
  const typeMap = bucket(e => e.ctype || e.cls || 'Unknown');

  const byClass   = breakdownCard('GPP / Cash / WTA', clsMap, ['GPP', 'Cash', 'WTA']);
  const bySite    = breakdownCard('By site', siteMap, ['DK', 'FD']);
  const byType    = breakdownCard('By contest type', typeMap, ['GPP','Double Up','50/50','H2H','Satellite/WTA','Cash - Other']);

  g('breakdown-grid').innerHTML = [byClass, bySite, byType].filter(Boolean).join('') ||
    '<p style="font-size:13px;color:var(--gray-400);grid-column:1/-1;padding:1rem">Import results to see breakdowns.</p>';
}

// - History -
function renderHistory() {
  const sf = gv('hist-site'), cf = gv('hist-class'), rf = gv('hist-cashed');
  let data = [...entries];
  if (sf) data = data.filter(e => e.site   === sf);
  if (cf) data = data.filter(e => e.cls    === cf);
  if (rf) data = data.filter(e => e.cashed === rf);

  if (!data.length) {
    g('hist-table').innerHTML = '<div class="empty"><i class="ti ti-database-off"></i>No entries yet - import a results CSV to get started.</div>';
    return;
  }

  const rows = data.map(e => `<tr>
    <td>${e.date || '-'}</td>
    <td><span class="badge ${(e.site||'').toLowerCase()}">${e.site || '-'}</span></td>
    <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis" title="${e.contest}">${e.contest}</td>
    <td><span class="badge ${e.cls === 'Cash' ? 'cash' : e.cls === 'WTA' ? 'wta' : 'gpp'}">${e.cls || '-'}</span></td>
    <td>$${(e.fee||0).toFixed(2)}</td>
    <td>${e.pts != null ? e.pts.toFixed(1) : '-'}</td>
    <td>${e.rank || '-'}</td>
    <td>${e.cashed || '-'}</td>
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

// - Export CSV -
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

// -
// CASH LINEUP BUILDER
// -

const luData = { sal: null, splash: null, stok: null };
let luPool = [];
let luLineup = [];

function handleLuFile(type, file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const rows = parseCSV(e.target.result);
    if (!rows.length) { showAlert('lineup-alert', `Could not parse ${type} file.`, 'danger'); return; }
    luData[type] = rows;
    const slot = g(`slot-${type}`);
    const status = g(`status-${type}`);
    slot.classList.add('uploaded');
    status.textContent = `- ${rows.length} rows loaded`;
    // Show settings card once all three uploaded
    if (luData.sal && luData.splash && luData.stok) {
      g('lu-settings-card').style.display = 'block';
      showAlert('lineup-alert', 'All files loaded - configure settings and build.', 'success');
      // Auto-detect if pitcher self-conflict likely
      autoDetectExclusions();
    }
  };
  reader.readAsText(file);
}

function autoDetectExclusions() {
  // Wire up blur validation on lock fields once pool is built
  ['lu-lock-sp1','lu-lock-sp2','lu-lock-h1','lu-lock-h2'].forEach(id => {
    const el = g(id); if (!el) return;
    el.oninput = () => validateLockField(el, id.includes('sp') ? 'SP' : null);
  });
}

function validateLockField(input, pos) {
  const val = input.value.trim();
  if (!val) { input.classList.remove('field-error'); return true; }
  if (!luPool.length) return true; // pool not built yet, skip
  // For hitters with slot override, just check name exists in pool
  const found = luPool.find(p =>
    p.name.toLowerCase().includes(val.toLowerCase()) && (!pos || p.pos.split('/').some(s => s.trim() === pos))
  );
  if (!found) {
    input.classList.add('field-error');
    // Show suggestions in title tooltip
    const words = val.toLowerCase().split(/\s+/).filter(w => w.length > 1);
    const pool = pos ? luPool.filter(p => p.pos.includes(pos)) : luPool;
    const suggestions = pool
      .map(p => ({ name: p.name, m: words.filter(w => p.name.toLowerCase().includes(w)).length }))
      .filter(x => x.m > 0).sort((a,b) => b.m - a.m).slice(0,3).map(x => x.name);
    input.title = suggestions.length ? 'Did you mean: ' + suggestions.join(', ') + '?' : 'No match found';
    return false;
  }
  input.classList.remove('field-error');
  input.title = '- ' + found.name;
  return true;
}

function parseLuSalaries(rows) {
  const out = {};
  rows.forEach(r => {
    const name = (r['name'] || r['Name'] || '').trim();
    const sal  = parseInt((r['salary'] || r['Salary'] || '0').replace(/[$,]/g,'')) || 0;
    const rawRosterPos = (r['roster position'] || r['Roster Position'] || '').trim();
    const rawPos  = (r['position'] || r['Position'] || rawRosterPos || '').trim();
    const team = (r['teamabbrev'] || r['team abbrev'] || r['team'] || r['Team'] || '').trim();
    const id   = (r['id'] || r['ID'] || r['playerid'] || r['player id'] || '').trim();
    // Normalize: SP/RP both become SP for optimizer; keep multi-position as-is
    let pos = (rawPos === 'RP') ? 'SP' : rawPos;
    pos = pos.replace(/^CPT\/?/, '').replace(/^MVP\/?/, '') || pos;
    if (name && sal) {
      // Showdown exports list each player twice: once as CPT (salary already x1.5)
      // and once as UTIL/FLEX (true base salary). Always keep the FLEX/UTIL base
      // salary row -- the builder applies its own 1.5x/2x multiplier for captain cost.
      const isCptRow = rawRosterPos === 'CPT' || rawRosterPos === 'MVP';
      const existingIsCpt = out[name] && out[name]._isCpt;
      if (!out[name] || (existingIsCpt && !isCptRow)) {
        out[name] = { sal, pos, team, id, _isCpt: isCptRow };
      }
    }
  });
  return out;
}

function parseLuSplash(rows) {
  const out = {};
  rows.forEach(r => {
    // "Player Name and Id", "Player Name", "Projection"
    const name = (r['player name'] || r['Player Name'] || r['name'] || '').trim();
    const proj = parseFloat(r['projection'] || r['Projection'] || r['fpts'] || 0) || 0;
    if (name) out[name] = proj;
  });
  return out;
}

function parseLuStok(rows) {
  const out = {};
  rows.forEach(r => {
    const name = (r['player'] || r['Player'] || r['name'] || '').trim();
    const proj = parseFloat(
      r['fpts'] || r['Fpts'] ||
      r['projection'] || r['Projection'] || 0
    ) || 0;
    const team = (r['team'] || r['Team'] || '').trim();
    const pos  = (
      r['roster pos'] || r['Roster Pos'] ||
      r['position'] || r['Position'] || ''
    ).trim();
    if (name) {
      // Key by name+team so same-name players on different teams are kept separately.
      // Also store by name alone as fallback for non-showdown files where duplicates don't occur.
      const key = team ? `${name}|${team}` : name;
      out[key] = { proj, team, pos };
      // Name-only entry: prefer non-zero projection (handles showdown placeholder rows)
      if (!out[name] || (out[name].proj === 0 && proj > 0)) {
        out[name] = { proj, team, pos };
      }
    }
  });
  return out;
}

// Showdown-specific Stokastic export: includes Salary, Ownership %, CPT Ownership %
// (different column set than the main-slate Data Hub export)
function parseSdStok(rows) {
  const out = {};
  rows.forEach(r => {
    const name = (r['player'] || r['Player'] || '').trim();
    const proj = parseFloat(r['projection'] || r['Projection'] || 0) || 0;
    const team = (r['team'] || r['Team'] || '').trim();
    const sal  = parseInt((r['salary'] || r['Salary'] || '0').replace(/[$,]/g,'')) || 0;
    const own  = parseFloat(r['ownership %'] || r['Ownership %'] || 0) || 0;
    const cptOwn = parseFloat(r['cpt ownership %'] || r['CPT Ownership %'] || 0) || 0;
    if (name) {
      // Key by name+team to handle same-name players on different teams
      const key = team ? `${name}|${team}` : name;
      out[key] = { proj, team, sal, own, cptOwn };
      // Name-only fallback: prefer non-zero projection row
      if (!out[name] || (out[name].proj === 0 && proj > 0)) {
        out[name] = { proj, team, sal, own, cptOwn };
      }
    }
  });
  return out;
}

function buildLineup() {
  if (!luData.sal || !luData.splash || !luData.stok) {
    showAlert('lineup-alert', 'Please upload all three files first.', 'info'); return;
  }

  const CAP       = parseInt(gv('lu-cap')) || 50000;
  const MAX_DIFF  = parseFloat(g('lu-max-diff').value) || 2.5;
  const excludeRaw = gv('lu-exclude-teams').toUpperCase().split(',').map(s => s.trim()).filter(Boolean);

  // Parse all three sources first so we can validate locks
  const salMap    = parseLuSalaries(luData.sal);
  const splashMap = parseLuSplash(luData.splash);
  const stokMap   = parseLuStok(luData.stok);

  // Build consensus pool
  luPool = [];
  const allNames = new Set([...Object.keys(salMap), ...Object.keys(splashMap)]);

  allNames.forEach(name => {
    const salData  = salMap[name];
    if (!salData) return;
    const sp = splashMap[name] || 0;
    // Look up by name+team first (handles same-name players on different teams in showdown files)
    const teamKey = salData.team ? `${name}|${salData.team}` : name;
    const stEntry = stokMap[teamKey] || stokMap[name];
    const st = stEntry ? stEntry.proj : 0;
    const team = salData.team || (stEntry ? stEntry.team : '');
    const pos  = salData.pos  || (stEntry ? stEntry.pos  : '');
    if (sp === 0 || st === 0) return;
    if (salData.sal === 0) return;
    const diff      = Math.abs(sp - st);
    const consensus = (sp + st) / 2;
    luPool.push({ name, team, pos, sal: salData.sal, sp, st, diff, consensus });
  });

  // A player can fill any slot listed in their position string (e.g. "OF/1B" -> OF or 1B)
  function eligibleFor(p, slot) {
    return p.pos.split('/').map(s => s.trim()).includes(slot);
  }

  // - Validate lock fields before proceeding -
  const h1Slot = gv('lu-lock-h1-pos') || null;
  const h2Slot = gv('lu-lock-h2-pos') || null;
  const lockFields = [
    { id: 'lu-lock-sp1', label: 'Lock SP1', pos: 'SP' },
    { id: 'lu-lock-sp2', label: 'Lock SP2', pos: 'SP' },
    { id: 'lu-lock-h1',  label: 'Lock hitter 1', pos: h1Slot },
    { id: 'lu-lock-h2',  label: 'Lock hitter 2', pos: h2Slot },
  ];

  const findPlayer = (nameInput, pos) => {
    if (!nameInput) return null;
    const nl = nameInput.trim().toLowerCase();
    return luPool.find(p => p.name.toLowerCase().includes(nl) && (!pos || p.pos.includes(pos)));
  };

  // Fuzzy suggestion: find closest name match by shared words
  const suggestPlayer = (nameInput, pos) => {
    const words = nameInput.trim().toLowerCase().split(/\s+/).filter(w => w.length > 1);
    const candidates = pos ? luPool.filter(p => p.pos.includes(pos)) : luPool;
    const scored = candidates.map(p => {
      const pn = p.name.toLowerCase();
      const matches = words.filter(w => pn.includes(w)).length;
      return { name: p.name, matches };
    }).filter(x => x.matches > 0).sort((a,b) => b.matches - a.matches);
    return scored.slice(0,3).map(x => x.name);
  };

  let validationFailed = false;
  lockFields.forEach(f => {
    const input = g(f.id);
    const val = input ? input.value.trim() : '';
    if (!val) { input && input.classList.remove('field-error'); return; }
    const found = findPlayer(val, f.pos);
    if (!found) {
      input.classList.add('field-error');
      const suggestions = suggestPlayer(val, f.pos);
      const hint = suggestions.length
        ? ` Did you mean: ${suggestions.join(', ')}?`
        : ' No match found in today\'s slate.';
      showAlert('lineup-alert', `${f.label}: "${val}" not found.${hint}`, 'danger');
      validationFailed = true;
    } else {
      input.classList.remove('field-error');
    }
  });
  if (validationFailed) return;

  const locks = [
    gv('lu-lock-sp1'), gv('lu-lock-sp2'),
    gv('lu-lock-h1'),  gv('lu-lock-h2'),
  ].filter(Boolean).map(s => s.trim().toLowerCase());

  // Apply exclusions: user-specified teams
  const excludeTeams = new Set(excludeRaw);

  // Filter pool: no excluded teams, consensus diff within threshold
  const eligiblePool = luPool.filter(p => {
    if (excludeTeams.has(p.team.toUpperCase())) return false;
    return true;
  });

  // Separate consensus-only pool (diff <= MAX_DIFF) vs all eligible
  const consensusPool = eligiblePool.filter(p => p.diff <= MAX_DIFF);

  // For hitter locks, use user-specified slot if provided (overrides player's primary pos)
  const h1SlotOverride = gv('lu-lock-h1-pos');
  const h2SlotOverride = gv('lu-lock-h2-pos');

  const lockedSP1 = findPlayer(gv('lu-lock-sp1'), 'SP');
  const lockedSP2 = findPlayer(gv('lu-lock-sp2'), 'SP');
  const lockedH1  = findPlayer(gv('lu-lock-h1'));
  const lockedH2  = findPlayer(gv('lu-lock-h2'));

  if (lockedSP1) lockedSP1._slot = 'SP';
  if (lockedSP2) lockedSP2._slot = 'SP';

  const locked = [lockedSP1, lockedSP2, lockedH1, lockedH2].filter(Boolean);
  const lockedNames = new Set(locked.map(p => p.name));
  const lockedSal = locked.reduce((a, p) => a + p.sal, 0);
  const remaining = CAP - lockedSal;

  // Determine slots remaining to fill, assigning locked hitters to the first
  // REQUIRED slot they're eligible for (using override if given) that still has room.
  const REQUIRED_ALL = { SP: 2, C: 1, '1B': 1, '2B': 1, '3B': 1, SS: 1, OF: 3 };
  const slotsNeeded = { ...REQUIRED_ALL };

  // SP locks first
  [lockedSP1, lockedSP2].forEach(p => { if (p) slotsNeeded.SP--; });

  // Hitter locks: use override if provided, else first eligible slot with room
  [[lockedH1, h1SlotOverride], [lockedH2, h2SlotOverride]].forEach(([p, override]) => {
    if (!p) return;
    let slot = override;
    if (!slot) {
      slot = Object.keys(REQUIRED_ALL).find(s =>
        s !== 'SP' && eligibleFor(p, s) && slotsNeeded[s] > 0
      );
    }
    p._slot = slot || p.pos.split('/')[0].trim();
    if (slotsNeeded[p._slot] !== undefined && slotsNeeded[p._slot] > 0) slotsNeeded[p._slot]--;
  });

  // - Salary-aware optimizer -
  // For each needed slot, build a candidate list (consensus pool first, fallback to eligible)
  // Then use a branch-and-bound style search: try combinations keeping track of
  // remaining salary headroom per unfilled slot to avoid dead ends.
  const warnings = [];

  // Minimum salary needed per remaining slot (use cheapest available at each pos)
  function minCostPerPos(pos, usedNames) {
    const pool = [...consensusPool, ...eligiblePool].filter(p =>
      eligibleFor(p, pos) && !usedNames.has(p.name)
    );
    if (!pool.length) return 0;
    return Math.min(...pool.map(p => p.sal));
  }

  // Candidates for each needed slot, consensus first then fallback
  function getCandidates(pos, usedNames, budgetRemaining) {
    const consensus = consensusPool.filter(p =>
      eligibleFor(p, pos) && !usedNames.has(p.name) && p.sal <= budgetRemaining
    ).sort((a,b) => b.consensus - a.consensus);
    if (consensus.length) return consensus;
    return eligiblePool.filter(p =>
      eligibleFor(p, pos) && !usedNames.has(p.name) && p.sal <= budgetRemaining
    ).sort((a,b) => b.consensus - a.consensus);
  }

  // Slots to fill in order (fill expensive/constrained positions first)
  const slotsToFill = [];
  Object.entries(slotsNeeded).forEach(([pos, count]) => {
    for (let i = 0; i < count; i++) slotsToFill.push(pos);
  });
  // Sort: fill most constrained positions first (fewest options)
  slotsToFill.sort((a, b) => {
    const aOpts = getCandidates(a, lockedNames, remaining).length;
    const bOpts = getCandidates(b, lockedNames, remaining).length;
    return aOpts - bOpts;
  });

  // - Optimizer: beam search when locks constrain the budget, fast greedy otherwise -
  // Locking expensive players (e.g. 2 top-salary SPs) squeezes the remaining budget
  // and a naive greedy fill front-loads early slots, starving later ones into
  // minimum-salary picks. Beam search avoids that by exploring top-N candidates
  // per slot. It's only needed when slots are already constrained by locks --
  // with no locks (10 open slots) the search space is too large to brute-force
  // in-browser, but greedy-with-headroom is already close to optimal there since
  // the optimizer has full freedom to balance SP vs hitter spend itself.

  const BEAM_WIDTH = 6;
  const NODE_CAP = 200000;
  const USE_BEAM_SEARCH = slotsToFill.length <= 8; // locks present -> budget likely constrained

  function minCostForSlots(pool, slotsArr, usedNames) {
    // Must account for the fact each slot needs a DIFFERENT player.
    // Greedily assign cheapest available player per slot in order,
    // tracking which players have been "claimed" for earlier slots.
    const tempUsed = new Set(usedNames);
    let total = 0;
    for (const pos of slotsArr) {
      const opts = pool.filter(p => eligibleFor(p, pos) && !tempUsed.has(p.name))
                       .sort((a,b) => a.sal - b.sal);
      if (!opts.length) return Infinity;
      total += opts[0].sal;
      tempUsed.add(opts[0].name);
    }
    return total;
  }

  function beamSearch(slotsArr, startPool, budget) {
    const candidatesPerSlot = slotsArr.map(pos =>
      startPool.filter(p => eligibleFor(p, pos))
               .sort((a, b) => b.consensus - a.consensus)
               .slice(0, BEAM_WIDTH)
    );

    let best = { total: -1, combo: null };
    let nodes = 0;
    let capped = false;

    function dfs(slotIdx, used, budgetLeft, chosen) {
      if (capped) return;
      nodes++;
      if (nodes > NODE_CAP) { capped = true; return; }
      if (slotIdx === slotsArr.length) {
        const total = chosen.reduce((s, p) => s + p.consensus, 0);
        if (total > best.total) { best.total = total; best.combo = [...chosen]; }
        return;
      }
      const restSlots = slotsArr.slice(slotIdx + 1);
      const minRest = minCostForSlots(startPool, restSlots, used);
      if (minRest === Infinity) return;

      for (const p of candidatesPerSlot[slotIdx]) {
        if (capped) return;
        if (used.has(p.name)) continue;
        if (p.sal > budgetLeft - minRest) continue;
        used.add(p.name);
        chosen.push(Object.assign(Object.create(Object.getPrototypeOf(p)), p, { _slot: slotsArr[slotIdx] }));
        dfs(slotIdx + 1, used, budgetLeft - p.sal, chosen);
        chosen.pop();
        used.delete(p.name);
      }
    }

    dfs(0, new Set(lockedNames), budget, []);

    // If beam search was cut short or found nothing, fall back to greedy
    if (!best.combo || capped) {
      if (capped) warnings.push('Beam search exceeded node limit — using fast greedy optimizer instead. Result is near-optimal.');
      return null; // signal caller to use greedy
    }
    return best.combo;
  }

  function greedyWithHeadroom(slotsArr, startPool, budget) {
    const used = new Set(lockedNames);
    const chosen = [];
    let left = budget;
    for (let idx = 0; idx < slotsArr.length; idx++) {
      const pos = slotsArr[idx];
      const rest = slotsArr.slice(idx + 1);
      const minRest = minCostForSlots(startPool, rest, used);
      const budgetForThis = left - minRest;
      const cands = startPool
        .filter(p => eligibleFor(p, pos) && !used.has(p.name) && p.sal <= budgetForThis)
        .sort((a, b) => b.consensus - a.consensus);
      if (!cands.length) return null;
      const pick = cands[0];
      chosen.push(Object.assign(Object.create(Object.getPrototypeOf(pick)), pick, { _slot: pos }));
      used.add(pick.name);
      left -= pick.sal;
    }
    return chosen;
  }

  function solve(slotsArr, startPool, budget) {
    if (USE_BEAM_SEARCH) {
      const beamResult = beamSearch(slotsArr, startPool, budget);
      if (beamResult) return beamResult;
    }
    return greedyWithHeadroom(slotsArr, startPool, budget);
  }

  // Sort slots: most constrained (fewest candidates) first - helps search prune faster
  const sortedSlots = [...slotsToFill].sort((a, b) => {
    const aOpts = getCandidates(a, lockedNames, remaining).length;
    const bOpts = getCandidates(b, lockedNames, remaining).length;
    return aOpts - bOpts;
  });

  // Try consensus pool first, then eligible, then full pool
  const poolsToTry = [consensusPool, eligiblePool, luPool.filter(p => !excludeTeams.has(p.team.toUpperCase()))];
  let bestCombo = null;
  let bestTotal = -1;

  for (const tryPool of poolsToTry) {
    if (bestCombo) break;
    const result = solve(sortedSlots, tryPool, remaining);
    if (result) {
      const total = result.reduce((a,p) => a + p.consensus, 0);
      if (total > bestTotal) { bestTotal = total; bestCombo = result; }
    }
    if (!bestCombo && tryPool === consensusPool) {
      warnings.push('No consensus lineup found within budget - relaxing disagreement threshold.');
    }
  }

  if (!bestCombo) {
    showAlert('lineup-alert', 'Could not build a valid lineup - check salary cap, excluded teams, or locked players.', 'danger');
    return;
  }

  // Flag any players outside consensus threshold
  bestCombo.forEach(p => {
    if (p.diff > MAX_DIFF) warnings.push(`${p.name} is outside consensus threshold (diff: ${p.diff.toFixed(1)} pts) - no better option was available.`);
  });

  luLineup = [...locked, ...bestCombo];

  // Safety net: count slots and warn if wrong
  const REQUIRED = { SP: 2, C: 1, '1B': 1, '2B': 1, '3B': 1, SS: 1, OF: 3 };
  const actualSlots = { SP: 0, C: 0, '1B': 0, '2B': 0, '3B': 0, SS: 0, OF: 0 };
  luLineup.forEach(p => {
    const slot = p._slot || p.pos.split('/')[0].trim();
    if (actualSlots[slot] !== undefined) actualSlots[slot]++;
  });
  Object.entries(REQUIRED).forEach(([pos, req]) => {
    if (actualSlots[pos] !== req)
      warnings.push(`Slot count issue: ${pos} needs ${req}, got ${actualSlots[pos]}. Set the Slot dropdown for your locked hitters to fix this.`);
  });


  // Sort display order - use _slot if set to avoid multi-pos sort confusion
  const posOrder = { SP: 0, C: 1, '1B': 2, '2B': 3, '3B': 4, SS: 5, OF: 6 };
  luLineup.sort((a, b) => {
    const sa = a._slot || a.pos.split('/')[0].trim();
    const sb = b._slot || b.pos.split('/')[0].trim();
    return (posOrder[sa] ?? 9) - (posOrder[sb] ?? 9);
  });

  renderLineupResult(warnings, CAP, MAX_DIFF);
  g('lu-result').style.display = 'block';
  renderPool();
}

function renderLineupResult(warnings, CAP, MAX_DIFF) {
  const totalSal  = luLineup.reduce((a, p) => a + p.sal, 0);
  const totalSP   = luLineup.reduce((a, p) => a + p.sp, 0);
  const totalST   = luLineup.reduce((a, p) => a + p.st, 0);
  const totalCons = luLineup.reduce((a, p) => a + p.consensus, 0);
  const under = CAP - totalSal;

  const posLabel = p => p._slot || p.pos.split('/')[0].trim();

  const rows = luLineup.map(p => {
    const diffFlag = p.diff > MAX_DIFF
      ? `<span style="color:var(--red);font-size:10px"> - diff ${p.diff.toFixed(1)}</span>` : '';
    return `<tr>
      <td><strong>${posLabel(p)}</strong></td>
      <td>${p.name}${diffFlag}</td>
      <td>${p.team}</td>
      <td style="text-align:right">$${p.sal.toLocaleString()}</td>
      <td style="text-align:right">${p.sp.toFixed(2)}</td>
      <td style="text-align:right">${p.st.toFixed(2)}</td>
      <td style="text-align:right"><strong>${p.consensus.toFixed(2)}</strong></td>
      <td style="text-align:right;color:var(--gray-500)">${p.diff.toFixed(2)}</td>
    </tr>`;
  }).join('');

  const capColor = under >= 0 ? 'var(--green)' : 'var(--red)';
  const capLabel = under >= 0 ? `$${under.toLocaleString()} under cap` : `$${Math.abs(under).toLocaleString()} OVER CAP`;

  g('lu-lineup-table').innerHTML = `
    <table class="bd-table" style="font-size:13px">
      <thead><tr>
        <th style="text-align:left">Pos</th>
        <th style="text-align:left">Player</th>
        <th style="text-align:left">Team</th>
        <th>Salary</th>
        <th>SplashPlay</th>
        <th>Stokastic</th>
        <th>Consensus</th>
        <th>Diff</th>
      </tr></thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr style="font-weight:600;border-top:2px solid var(--gray-200)">
          <td colspan="3">TOTAL</td>
          <td style="text-align:right">$${totalSal.toLocaleString()}</td>
          <td style="text-align:right">${totalSP.toFixed(2)}</td>
          <td style="text-align:right">${totalST.toFixed(2)}</td>
          <td style="text-align:right">${totalCons.toFixed(2)}</td>
          <td></td>
        </tr>
        <tr>
          <td colspan="8" style="text-align:right;font-size:12px;color:${capColor};font-weight:600">${capLabel}</td>
        </tr>
      </tfoot>
    </table>`;

  const warnHTML = warnings.length
    ? warnings.map(w => `<div class="alert info" style="margin-bottom:6px"><i class="ti ti-alert-circle"></i>${w}</div>`).join('')
    : '<div style="font-size:12px;color:var(--gray-500)">No warnings - all players within consensus threshold.</div>';
  g('lu-warnings').innerHTML = warnHTML;

  // Show export button
  const existingBtn = g('lu-export-btn');
  if (existingBtn) existingBtn.remove();
  const btn = document.createElement('button');
  btn.id = 'lu-export-btn';
  btn.className = 'btn primary';
  btn.style.marginTop = '1rem';
  btn.innerHTML = '<i class="ti ti-download"></i> Export for DK upload';
  btn.onclick = exportLineupDK;
  g('lu-lineup-table').after(btn);
}

function renderPool() {
  if (!luPool.length) return;
  const posFilter  = gv('lu-pool-pos');
  const sortBy     = gv('lu-pool-sort') || 'consensus';
  const MAX_DIFF   = parseFloat(g('lu-max-diff').value) || 2.5;
  const excludeRaw = gv('lu-exclude-teams').toUpperCase().split(',').map(s => s.trim()).filter(Boolean);
  const excludeTeams = new Set(excludeRaw);

  let data = [...luPool].filter(p => !excludeTeams.has(p.team.toUpperCase()));
  if (posFilter) data = data.filter(p => p.pos && p.pos.includes(posFilter));
  data.sort((a, b) => {
    if (sortBy === 'diff')    return a.diff - b.diff;
    if (sortBy === 'salary')  return b.sal - a.sal;
    return b.consensus - a.consensus;
  });

  const inLineup = new Set(luLineup.map(p => p.name));

  const rows = data.slice(0, 60).map(p => {
    const highlight = inLineup.has(p.name) ? 'background:var(--green-light)' : '';
    const flagStyle = p.diff > MAX_DIFF ? 'color:var(--red)' : 'color:var(--green)';
    return `<tr style="${highlight}">
      <td>${p.pos}</td>
      <td>${p.name}${inLineup.has(p.name) ? ' <span style="font-size:10px;color:var(--green);font-weight:600">- IN</span>' : ''}</td>
      <td>${p.team}</td>
      <td style="text-align:right">$${p.sal.toLocaleString()}</td>
      <td style="text-align:right">${p.sp.toFixed(2)}</td>
      <td style="text-align:right">${p.st.toFixed(2)}</td>
      <td style="text-align:right"><strong>${p.consensus.toFixed(2)}</strong></td>
      <td style="text-align:right;${flagStyle}">${p.diff.toFixed(2)}</td>
    </tr>`;
  }).join('');

  g('lu-pool-table').innerHTML = `<table>
    <thead><tr>
      <th>Pos</th><th>Player</th><th>Team</th><th>Salary</th>
      <th>SplashPlay</th><th>Stokastic</th><th>Consensus</th><th>Diff</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function exportLineupDK() {
  if (!luLineup.length) return;
  const salMap = parseLuSalaries(luData.sal);

  // DK slot order: P, P, C, 1B, 2B, 3B, SS, OF, OF, OF
  const slotOrder = ['SP','SP','C','1B','2B','3B','SS','OF','OF','OF'];
  const sorted = [...luLineup];
  const posOrder = { SP:0, C:1, '1B':2, '2B':3, '3B':4, SS:5, OF:6 };
  sorted.sort((a,b) => {
    const pa = a._slot || a.pos.split('/')[0].trim();
    const pb = b._slot || b.pos.split('/')[0].trim();
    return (posOrder[pa]??9) - (posOrder[pb]??9);
  });

  const header = 'P,P,C,1B,2B,3B,SS,OF,OF,OF';
  const cells = sorted.map(p => {
    const salEntry = salMap[p.name];
    const id = salEntry ? salEntry.id : '';
    return id ? `${p.name} (${id})` : p.name;
  });
  const csv = header + '\n' + cells.join(',') + ',';

  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], {type:'text/csv'}));
  a.download = `DK_cash_lineup_${todayISO()}.csv`;
  a.click();

  showAlert('lineup-alert',
    'Downloaded. If DK rejects this on upload, download DK\'s own template from the contest\'s "Upload Lineups" screen first and copy these names into its existing columns -- DK\'s bulk upload expects your Entry ID/Contest ID already present in the file.',
    'info', 12000);
}

function resetLineupBuilder() {
  luData.sal = luData.splash = luData.stok = null;
  luPool = []; luLineup = [];
  ['sal','splash','stok'].forEach(t => {
    const slot = g(`slot-${t}`); if(slot) slot.classList.remove('uploaded');
    const status = g(`status-${t}`); if(status) status.textContent = 'Not uploaded';
    const file = g(`file-${t}`); if(file) file.value = '';
  });
  g('lu-settings-card').style.display = 'none';
  g('lu-result').style.display = 'none';
  ['lu-lock-sp1','lu-lock-sp2','lu-lock-h1','lu-lock-h2','lu-exclude-teams'].forEach(id => {
    const el = g(id); if(el) el.value = '';
  });
}

// ============================================================================
// SHOWDOWN CASH LINEUP BUILDER
// ============================================================================

const sdData = { sal: null, splash: null, stok: null };
let sdPool = [];
let sdLastFailReason = '';
let sdMode = 'cash';

function setSdMode(mode, btn) {
  sdMode = mode;
  document.querySelectorAll('.flag-btn[data-group="sd-mode"]').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');

  const hint = g('sd-mode-hint');
  const wtaSettings = g('sd-wta-settings');
  const stokTag = g('sd-stok-tag');
  const stokHint = g('sd-stok-hint');
  const buildBtn = g('sd-build-btn');
  const resultTitle = g('sd-result-title');
  const captainBoard = g('sd-captain-board');

  if (mode === 'wta') {
    hint.textContent = 'WTA: Captain pick weighs ownership leverage, not just raw points -- needs Stokastic ownership data.';
    wtaSettings.style.display = 'block';
    stokTag.style.display = 'inline-block';
    stokHint.textContent = 'Data Hub export, Showdown slate -- must include Ownership % and CPT Ownership % columns';
    buildBtn.innerHTML = '<i class="ti ti-wand"></i> Build optimal WTA showdown';
    resultTitle.textContent = 'Optimal WTA showdown lineup';
  } else {
    hint.textContent = 'Cash: highest-consensus Captain, no ownership consideration -- pure floor.';
    wtaSettings.style.display = 'none';
    stokTag.style.display = 'none';
    stokHint.textContent = 'Data Hub export, Showdown slate';
    buildBtn.innerHTML = '<i class="ti ti-wand"></i> Build optimal cash showdown';
    resultTitle.textContent = 'Optimal cash showdown lineup';
  }
  captainBoard.style.display = 'none';
}

let sdLineup = [];

let sdSplashSkipped = false;

function handleSdFile(type, file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const rows = parseCSV(e.target.result);
    if (!rows.length) { showAlert('sd-alert', `Could not parse ${type} file.`, 'danger'); return; }
    sdData[type] = rows;
    if (type === 'splash') sdSplashSkipped = false;
    const slot = g(`sd-slot-${type}`);
    const status = g(`sd-status-${type}`);
    slot.classList.add('uploaded');
    status.textContent = `OK ${rows.length} rows loaded`;
    checkSdReady();
  };
  reader.readAsText(file);
}

function skipSplashplay() {
  sdSplashSkipped = true;
  sdData.splash = null;
  const slot = g('sd-slot-splash');
  const status = g('sd-status-splash');
  slot.classList.add('uploaded');
  slot.classList.add('skipped');
  status.textContent = 'Skipped — Stokastic only';
  showAlert('sd-alert', 'SplashPlay skipped. Lineup will be built from Stokastic projections alone.', 'info');
  checkSdReady();
}

function checkSdReady() {
  const splashReady = sdData.splash || sdSplashSkipped;
  if (sdData.sal && splashReady && sdData.stok) {
    g('sd-settings-card').style.display = 'block';
    if (!sdSplashSkipped) showAlert('sd-alert', 'All files loaded -- configure settings and build.', 'success');
  }
}

function buildShowdown() {
  const splashReady = sdData.splash || sdSplashSkipped;
  if (!sdData.sal || !splashReady || !sdData.stok) {
    showAlert('sd-alert', 'Please upload Salaries + Stokastic, and either upload SplashPlay or click Skip.', 'info'); return;
  }

  const SITE     = gv('sd-site') || 'DK';
  const CAP      = parseInt(gv('sd-cap')) || 50000;
  const MAX_DIFF = parseFloat(g('sd-max-diff').value) || 2.5;
  const ROSTER_SIZE = SITE === 'FD' ? 5 : 6;
  const CPT_MULT_SAL  = SITE === 'FD' ? 1 : 1.5; // FD MVP salary same as FLEX, DK CPT costs 1.5x
  const CPT_MULT_PTS  = SITE === 'FD' ? 2 : 1.5;
  const stokOnly = sdSplashSkipped || !sdData.splash;

  // Parse sources (reuse main cash builder parsers)
  const salMap    = parseLuSalaries(sdData.sal);
  const splashMap = stokOnly ? {} : parseLuSplash(sdData.splash);
  const stokMap   = parseLuStok(sdData.stok);
  const sdStokMap = sdMode === 'wta' ? parseSdStok(sdData.stok) : {};

  sdPool = [];
  const allNames = stokOnly
    ? new Set(Object.keys(salMap))
    : new Set([...Object.keys(salMap), ...Object.keys(splashMap)]);

  allNames.forEach(name => {
    const salData = salMap[name];
    if (!salData) return;
    // Look up by name+team first to get the correct player when same name appears on both teams
    const teamKey = salData.team ? `${name}|${salData.team}` : name;
    const stEntry = stokMap[teamKey] || stokMap[name];
    const st = stEntry ? stEntry.proj : 0;
    let team = salData.team || (stEntry ? stEntry.team : '');
    team = team.toUpperCase();
    if (salData.sal === 0) return;

    const ownKey = salData.team ? `${name}|${salData.team}` : name;
    const ownEntry = sdStokMap[ownKey] || sdStokMap[name];
    const own = ownEntry ? ownEntry.own : null;
    const cptOwn = ownEntry ? ownEntry.cptOwn : null;

    if (stokOnly) {
      // Stokastic-only: no second source, so "consensus" = Stokastic projection, diff = 0
      if (st === 0) return;
      sdPool.push({ name, team, sal: salData.sal, sp: st, st, diff: 0, consensus: st, own, cptOwn });
    } else {
      const sp = splashMap[name] || 0;
      if (sp === 0 || st === 0) return;
      const diff = Math.abs(sp - st);
      const consensus = (sp + st) / 2;
      sdPool.push({ name, team, sal: salData.sal, sp, st, diff, consensus, own, cptOwn });
    }
  });

  if (sdMode === 'wta' && sdPool.every(p => p.cptOwn === null)) {
    showAlert('sd-alert', 'WTA mode needs ownership data. Make sure your Stokastic file includes "Ownership %" and "CPT Ownership %" columns (the showdown Data Hub export, not the main-slate one).', 'danger');
    return;
  }

  if (!sdPool.length) {
    showAlert('sd-alert', 'No matching players found across the uploaded files.', 'danger'); return;
  }

  const teams = [...new Set(sdPool.map(p => p.team).filter(Boolean))];
  if (teams.length !== 2) {
    const sample = sdPool.slice(0, 5).map(p => `${p.name} (team:"${p.team}")`).join(', ');
    showAlert('sd-alert', `Expected exactly 2 teams, found ${teams.length}: [${teams.join(', ')}]. Sample players: ${sample}. Check that your salary file has a Team/TeamAbbrev column.`, 'danger');
    return;
  }

  // Validate Captain lock
  const cptInput = gv('sd-lock-cpt');
  const flexInput = gv('sd-lock-flex');
  const findSdPlayer = (nameInput) => {
    if (!nameInput) return null;
    const nl = nameInput.trim().toLowerCase();
    return sdPool.find(p => p.name.toLowerCase().includes(nl));
  };

  if (cptInput) {
    const found = findSdPlayer(cptInput);
    if (!found) {
      const words = cptInput.toLowerCase().split(/\s+/).filter(w => w.length > 1);
      const suggestions = sdPool
        .map(p => ({ name: p.name, m: words.filter(w => p.name.toLowerCase().includes(w)).length }))
        .filter(x => x.m > 0).sort((a,b) => b.m - a.m).slice(0,3).map(x => x.name);
      showAlert('sd-alert', `Captain "${cptInput}" not found.${suggestions.length ? ' Did you mean: ' + suggestions.join(', ') + '?' : ''}`, 'danger');
      return;
    }
  }
  if (flexInput) {
    const found = findSdPlayer(flexInput);
    if (!found) {
      showAlert('sd-alert', `FLEX lock "${flexInput}" not found.`, 'danger');
      return;
    }
  }

  const lockedCpt  = findSdPlayer(cptInput);
  const lockedFlex = findSdPlayer(flexInput);

  // Build eligible pool: apply consensus filter
  const consensusPool = sdPool.filter(p => p.diff <= MAX_DIFF);
  const eligiblePool  = sdPool;

  // Rank captain candidates based on mode/strategy
  function rankCaptainCandidates(pool) {
    if (sdMode !== 'wta') {
      return [...pool].sort((a,b) => b.consensus - a.consensus);
    }
    const strategy = gv('sd-wta-strategy') || 'value';
    const maxCptOwn = parseFloat(gv('sd-max-cpt-own')) || 100;
    const withOwn = pool.filter(p => p.cptOwn !== null && p.cptOwn !== undefined);
    const eligible = withOwn.length ? withOwn.filter(p => p.cptOwn <= maxCptOwn) : pool;
    const candidates = eligible.length ? eligible : pool;

    if (strategy === 'chalk') {
      return [...candidates].sort((a,b) => b.consensus - a.consensus);
    }
    if (strategy === 'contrarian') {
      return [...candidates].sort((a,b) => (a.cptOwn ?? 100) - (b.cptOwn ?? 100));
    }
    // 'value': consensus*1.5 (captain pts) per 1% of CPT ownership, floor at 0.5 to avoid div-by-zero blowups
    return [...candidates].sort((a,b) => {
      const aVal = (a.consensus * 1.5) / Math.max(a.cptOwn ?? 1, 0.5);
      const bVal = (b.consensus * 1.5) / Math.max(b.cptOwn ?? 1, 0.5);
      return bVal - aVal;
    });
  }

  function tryBuildBestCaptain(pool) {
    if (lockedCpt) return tryBuildWithCaptain(pool, lockedCpt);
    // No captain locked: try top N captains by rank until one produces a feasible lineup
    const sorted = rankCaptainCandidates(pool);
    for (const cptCandidate of sorted.slice(0, 8)) {
      const result = tryBuildWithCaptain(pool, cptCandidate);
      if (result) return result;
    }
    sdLastFailReason = `Tried top 8 captain candidates, none produced a lineup within the $${CAP.toLocaleString()} cap with the team-min-1 constraint. The salary cap may be set too low for this slate, or the player pool too thin (pool size: ${pool.length}).`;
    return null;
  }

  // Given a partial lineup (used names, teams represented, slots remaining, budget),
  // compute the true cheapest legal cost to fill the rest while satisfying team-min-1.
  function cheapestCompletionCost(pool, used, teamsUsed, slotsLeft) {
    const avail = pool.filter(p => !used.has(p.name));
    const missingTeam = teams.find(t => !teamsUsed.has(t));
    if (!missingTeam) {
      // No constraint left, just cheapest N
      const sorted = [...avail].sort((a,b) => a.sal - b.sal);
      if (sorted.length < slotsLeft) return Infinity;
      return sorted.slice(0, slotsLeft).reduce((s,p) => s + p.sal, 0);
    }
    // Must include at least one from missingTeam among the remaining picks
    const missingTeamPlayers = avail.filter(p => p.team === missingTeam).sort((a,b) => a.sal - b.sal);
    if (!missingTeamPlayers.length) return Infinity; // impossible, no one left from that team
    const cheapestFromMissing = missingTeamPlayers[0];
    const rest = avail.filter(p => p.name !== cheapestFromMissing.name).sort((a,b) => a.sal - b.sal);
    if (rest.length < slotsLeft - 1) return Infinity;
    const restCost = rest.slice(0, slotsLeft - 1).reduce((s,p) => s + p.sal, 0);
    return cheapestFromMissing.sal + restCost;
  }

  function tryBuildWithCaptain(pool, forcedCaptain) {
    const used = new Set();
    const captain = forcedCaptain;
    let budgetLeft = CAP;

    used.add(captain.name);
    const cptCost = SITE === 'FD' ? captain.sal : Math.round(captain.sal * 1.5);
    budgetLeft -= cptCost;
    if (budgetLeft < 0) return null;

    const flexChosen = [];
    if (lockedFlex && lockedFlex.name !== captain.name) {
      flexChosen.push(lockedFlex);
      used.add(lockedFlex.name);
      budgetLeft -= lockedFlex.sal;
      if (budgetLeft < 0) return null;
    }

    const flexNeeded = ROSTER_SIZE - 1 - flexChosen.length;
    const candidates = pool.filter(p => !used.has(p.name)).sort((a,b) => b.consensus - a.consensus);

    // Upfront feasibility check: can we even complete this roster within budget?
    const teamsUsedInit = new Set([captain.team, ...flexChosen.map(p=>p.team)]);
    const minTotalCost = cheapestCompletionCost(pool, used, teamsUsedInit, flexNeeded);
    if (minTotalCost > budgetLeft) return null; // truly infeasible, no point trying

    for (let i = 0; i < flexNeeded; i++) {
      const teamsUsed = new Set([captain.team, ...flexChosen.map(p=>p.team)]);
      const missingTeam = teams.find(t => !teamsUsed.has(t));
      const slotsLeftAfterThis = flexNeeded - i - 1;

      let pick = null;
      // Try candidates in consensus order; accept the first one where the REMAINING
      // slots are still completable within whatever budget is left after this pick.
      for (const candidate of candidates) {
        if (used.has(candidate.name)) continue;
        if (candidate.sal > budgetLeft) continue;
        const newUsed = new Set([...used, candidate.name]);
        const newTeamsUsed = new Set([...teamsUsed, candidate.team]);
        const budgetAfterPick = budgetLeft - candidate.sal;
        const restMinCost = cheapestCompletionCost(pool, newUsed, newTeamsUsed, slotsLeftAfterThis);
        if (restMinCost <= budgetAfterPick) { pick = candidate; break; }
      }
      if (!pick) return null;

      flexChosen.push(pick);
      used.add(pick.name);
      budgetLeft -= pick.sal;
    }

    return [{ ...captain, _slot: SITE === 'FD' ? 'MVP' : 'CPT', _cost: cptCost, _pts: captain.consensus * CPT_MULT_PTS }]
      .concat(flexChosen.map(p => ({ ...p, _slot: 'FLEX', _cost: p.sal, _pts: p.consensus })));
  }

  let result = tryBuildBestCaptain(consensusPool);
  const warnings = [];
  if (stokOnly) {
    warnings.push('Built from Stokastic projections only (SplashPlay skipped or not available for this slate) — no cross-source consensus check applied.');
  }
  if (!result) {
    warnings.push('No valid consensus lineup found within budget -- relaxing disagreement threshold.');
    result = tryBuildBestCaptain(eligiblePool);
  }
  if (!result) {
    showAlert('sd-alert', `Could not build a valid showdown lineup. ${sdLastFailReason || 'Salary cap may be too tight for this slate -- check the Cap setting.'}`, 'danger');
    return;
  }

  if (!stokOnly) {
    result.forEach(p => {
      if (p.diff > MAX_DIFF) warnings.push(`${p.name} is outside consensus threshold (diff: ${p.diff.toFixed(1)} pts).`);
    });
  }

  sdLineup = result;
  renderShowdownResult(warnings, CAP, SITE);
  g('sd-result').style.display = 'block';
  renderSdPool();
  if (sdMode === 'wta') renderCaptainBoard();
}

function renderCaptainBoard() {
  const board = g('sd-captain-board');
  const withOwn = sdPool.filter(p => p.cptOwn !== null && p.cptOwn !== undefined);
  if (!withOwn.length) { board.style.display = 'none'; return; }

  const sorted = [...withOwn].sort((a,b) => {
    const aVal = (a.consensus * 1.5) / Math.max(a.cptOwn, 0.5);
    const bVal = (b.consensus * 1.5) / Math.max(b.cptOwn, 0.5);
    return bVal - aVal;
  });

  const usedCptName = sdLineup.find(p => p._slot === 'CPT' || p._slot === 'MVP')?.name;

  const rows = sorted.slice(0, 15).map(p => {
    const cptPts = p.consensus * 1.5;
    const valPerOwn = cptPts / Math.max(p.cptOwn, 0.5);
    const isUsed = p.name === usedCptName;
    return `<tr style="${isUsed ? 'background:var(--green-light)' : ''}">
      <td>${p.name}${isUsed ? ' <span style="font-size:10px;color:var(--green);font-weight:600">SELECTED</span>' : ''}</td>
      <td>${p.team}</td>
      <td style="text-align:right">${p.consensus.toFixed(2)}</td>
      <td style="text-align:right">${cptPts.toFixed(2)}</td>
      <td style="text-align:right">${p.cptOwn.toFixed(1)}%</td>
      <td style="text-align:right"><strong>${valPerOwn.toFixed(2)}</strong></td>
    </tr>`;
  }).join('');

  g('sd-captain-board-table').innerHTML = `<table>
    <thead><tr>
      <th>Player</th><th>Team</th><th>Consensus</th><th>CPT Pts</th><th>CPT Own%</th><th>Value/Own</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
  board.style.display = 'block';
}

function renderShowdownResult(warnings, CAP, SITE) {
  const totalSal = sdLineup.reduce((a,p) => a + p._cost, 0);
  const totalSP  = sdLineup.reduce((a,p) => a + p.sp * (p._slot === 'CPT' || p._slot === 'MVP' ? (SITE === 'FD' ? 2 : 1.5) : 1), 0);
  const totalST  = sdLineup.reduce((a,p) => a + p.st * (p._slot === 'CPT' || p._slot === 'MVP' ? (SITE === 'FD' ? 2 : 1.5) : 1), 0);
  const totalPts = sdLineup.reduce((a,p) => a + p._pts, 0);
  const under = CAP - totalSal;

  const rows = sdLineup.map(p => {
    const diffFlag = p.diff > parseFloat(g('sd-max-diff').value || 2.5)
      ? `<span style="color:var(--red);font-size:10px"> (warn) diff ${p.diff.toFixed(1)}</span>` : '';
    return `<tr>
      <td><strong>${p._slot}</strong></td>
      <td>${p.name}${diffFlag}</td>
      <td>${p.team}</td>
      <td style="text-align:right">$${p._cost.toLocaleString()}</td>
      <td style="text-align:right">${p.sp.toFixed(2)}</td>
      <td style="text-align:right">${p.st.toFixed(2)}</td>
      <td style="text-align:right"><strong>${p._pts.toFixed(2)}</strong></td>
    </tr>`;
  }).join('');

  const capColor = under >= 0 ? 'var(--green)' : 'var(--red)';
  const capLabel = under >= 0 ? `$${under.toLocaleString()} under cap` : `$${Math.abs(under).toLocaleString()} OVER CAP`;

  g('sd-lineup-table').innerHTML = `
    <table class="bd-table" style="font-size:13px">
      <thead><tr>
        <th style="text-align:left">Slot</th><th style="text-align:left">Player</th><th style="text-align:left">Team</th>
        <th>Cost</th><th>SplashPlay</th><th>Stokastic</th><th>Pts (weighted)</th>
      </tr></thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr style="font-weight:600;border-top:2px solid var(--gray-200)">
          <td colspan="3">TOTAL</td>
          <td style="text-align:right">$${totalSal.toLocaleString()}</td>
          <td colspan="2"></td>
          <td style="text-align:right">${totalPts.toFixed(2)}</td>
        </tr>
        <tr><td colspan="7" style="text-align:right;font-size:12px;color:${capColor};font-weight:600">${capLabel}</td></tr>
      </tfoot>
    </table>`;

  const existingBtn = g('sd-export-btn');
  if (existingBtn) existingBtn.remove();
  const btn = document.createElement('button');
  btn.id = 'sd-export-btn';
  btn.className = 'btn primary';
  btn.style.marginTop = '1rem';
  btn.innerHTML = '<i class="ti ti-download"></i> Export for ' + SITE + ' upload';
  btn.onclick = exportShowdown;
  g('sd-lineup-table').after(btn);

  g('sd-warnings').innerHTML = warnings.length
    ? warnings.map(w => `<div class="alert info" style="margin-bottom:6px"><i class="ti ti-alert-circle"></i>${w}</div>`).join('')
    : '<div style="font-size:12px;color:var(--gray-500)">No warnings -- all players within consensus threshold.</div>';
}

function renderSdPool() {
  if (!sdPool.length) return;
  const teamFilter = gv('sd-pool-team');
  const sortBy = gv('sd-pool-sort') || 'consensus';

  // Populate team filter once
  const teamSel = g('sd-pool-team');
  if (teamSel.options.length <= 1) {
    const teams = [...new Set(sdPool.map(p => p.team))].sort();
    teams.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t; opt.textContent = t;
      teamSel.appendChild(opt);
    });
  }

  let data = [...sdPool];
  if (teamFilter) data = data.filter(p => p.team === teamFilter);
  data.sort((a,b) => {
    if (sortBy === 'diff') return a.diff - b.diff;
    if (sortBy === 'salary') return b.sal - a.sal;
    return b.consensus - a.consensus;
  });

  const inLineup = new Set(sdLineup.map(p => p.name));
  const rows = data.map(p => {
    const highlight = inLineup.has(p.name) ? 'background:var(--green-light)' : '';
    const flagStyle = p.diff > (parseFloat(g('sd-max-diff').value)||2.5) ? 'color:var(--red)' : 'color:var(--green)';
    return `<tr style="${highlight}">
      <td>${p.team}</td>
      <td>${p.name}${inLineup.has(p.name) ? ' <span style="font-size:10px;color:var(--green);font-weight:600">IN</span>' : ''}</td>
      <td style="text-align:right">$${p.sal.toLocaleString()}</td>
      <td style="text-align:right">${p.sp.toFixed(2)}</td>
      <td style="text-align:right">${p.st.toFixed(2)}</td>
      <td style="text-align:right"><strong>${p.consensus.toFixed(2)}</strong></td>
      <td style="text-align:right;${flagStyle}">${p.diff.toFixed(2)}</td>
    </tr>`;
  }).join('');

  g('sd-pool-table').innerHTML = `<table>
    <thead><tr><th>Team</th><th>Player</th><th>Salary</th><th>SplashPlay</th><th>Stokastic</th><th>Consensus</th><th>Diff</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function exportShowdown() {
  if (!sdLineup.length) return;
  const SITE = gv('sd-site') || 'DK';
  const salMap = parseLuSalaries(sdData.sal);

  let header, cells;
  if (SITE === 'DK') {
    header = 'CPT,UTIL,UTIL,UTIL,UTIL,UTIL';
    cells = sdLineup.map(p => {
      const salEntry = salMap[p.name];
      const id = salEntry ? salEntry.id : '';
      return id ? `${p.name} (${id})` : p.name;
    });
  } else {
    header = 'MVP,FLEX,FLEX,FLEX,FLEX';
    cells = sdLineup.map(p => {
      const salEntry = salMap[p.name];
      const id = salEntry ? salEntry.id : '';
      return id ? `${p.name} (${id})` : p.name;
    });
  }

  const csv = header + '\n' + cells.join(',') + ',';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], {type:'text/csv'}));
  a.download = `${SITE}_showdown_cash_${todayISO()}.csv`;
  a.click();

  showAlert('sd-alert',
    `Downloaded. ${SITE} bulk upload requires DK's own template (with your Entry ID/Contest ID already filled in) -- ` +
    `download that template from the contest's "Upload Lineups" screen first, then copy these player names into its existing player columns. ` +
    `Don't upload this file as-is; DK will reject a header-only CSV without your Entry/Contest IDs.`,
    'info', 12000);
}

function resetShowdownBuilder() {
  sdData.sal = sdData.splash = sdData.stok = null;
  sdSplashSkipped = false;
  sdPool = []; sdLineup = [];
  ['sal','splash','stok'].forEach(t => {
    const slot = g(`sd-slot-${t}`); if (slot) { slot.classList.remove('uploaded'); slot.classList.remove('skipped'); }
    const status = g(`sd-status-${t}`); if (status) status.textContent = 'Not uploaded';
    const file = g(`sd-file-${t}`); if (file) file.value = '';
  });
  g('sd-settings-card').style.display = 'none';
  g('sd-result').style.display = 'none';
  g('sd-captain-board').style.display = 'none';
  ['sd-lock-cpt','sd-lock-flex'].forEach(id => { const el = g(id); if (el) el.value = ''; });
  const teamSel = g('sd-pool-team');
  if (teamSel) teamSel.innerHTML = '<option value="">All teams</option>';
}
