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
      tag:     gv('import-tag') || '',
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
  const t = g('import-tag'); if (t) t.value = '';
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

  // Approach tags — GPP only, since tags describe stack-construction method
  function bucketOf(list, keyFn) {
    const map = {};
    list.forEach(e => {
      const k = keyFn(e) || 'Untagged';
      if (!map[k]) map[k] = { n: 0, invested: 0, win: 0, cashes: 0 };
      map[k].n++;
      map[k].invested += e.invested || 0;
      map[k].win      += e.win      || 0;
      if (e.cashed === 'Y') map[k].cashes++;
    });
    return map;
  }
  const tagMap = bucketOf(gpp, e => e.tag);
  // Untagged last, rest alphabetical
  const tagOrder = Object.keys(tagMap).filter(k => k !== 'Untagged').sort().concat(
    tagMap['Untagged'] ? ['Untagged'] : []);

  const clsMap  = bucket(e => e.cls);
  const siteMap = bucket(e => e.site);
  const typeMap = bucket(e => e.ctype || e.cls || 'Unknown');

  const byClass   = breakdownCard('GPP / Cash / WTA', clsMap, ['GPP', 'Cash', 'WTA']);
  const bySite    = breakdownCard('By site', siteMap, ['DK', 'FD']);
  const byType    = breakdownCard('By contest type', typeMap, ['GPP','Double Up','50/50','H2H','Satellite/WTA','Cash - Other']);
  const byTag     = tagOrder.length > 1 || (tagOrder.length === 1 && tagOrder[0] !== 'Untagged')
    ? breakdownCard('GPP by approach', tagMap, tagOrder) : '';

  g('breakdown-grid').innerHTML = [byClass, byTag, bySite, byType].filter(Boolean).join('') ||
    '<p style="font-size:13px;color:var(--gray-400);grid-column:1/-1;padding:1rem">Import results to see breakdowns.</p>';

  renderTrendChart(all);
}

// - History -
function renderHistory() {
  const sf = gv('hist-site'), cf = gv('hist-class'), rf = gv('hist-cashed');
  // Rebuild the approach filter from whatever tags exist
  const tagSel = g('hist-tag');
  const prevTag = tagSel ? tagSel.value : '';
  if (tagSel) {
    const tags = [...new Set(entries.map(e => e.tag).filter(Boolean))].sort();
    const hasUntagged = entries.some(e => !e.tag);
    tagSel.innerHTML = '<option value="">All approaches</option>' +
      tags.map(t => `<option value="${t}">${t}</option>`).join('') +
      (hasUntagged ? '<option value="__none">Untagged</option>' : '');
    tagSel.value = prevTag;
  }
  const tf = tagSel ? tagSel.value : '';

  let data = [...entries];
  if (sf) data = data.filter(e => e.site   === sf);
  if (cf) data = data.filter(e => e.cls    === cf);
  if (rf) data = data.filter(e => e.cashed === rf);
  if (tf === '__none') data = data.filter(e => !e.tag);
  else if (tf)         data = data.filter(e => e.tag === tf);
  // Newest first
  data.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  if (!data.length) {
    g('hist-table').innerHTML = '<div class="empty"><i class="ti ti-database-off"></i>No entries yet - import a results CSV to get started.</div>';
    return;
  }

  const rows = data.map(e => `<tr>
    <td>${e.date || '-'}</td>
    <td><span class="badge ${(e.site||'').toLowerCase()}">${e.site || '-'}</span></td>
    <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis" title="${e.contest}">${e.contest}</td>
    <td><span class="badge ${e.cls === 'Cash' ? 'cash' : e.cls === 'WTA' ? 'wta' : 'gpp'}">${e.cls || '-'}</span></td>
    <td><input class="tag-cell" list="approach-list" value="${(e.tag||'').replace(/"/g,'&quot;')}" placeholder="—"
         onchange="setEntryTag('${e.id}', this.value)"></td>
    <td>$${(e.fee||0).toFixed(2)}</td>
    <td>${e.pts != null ? e.pts.toFixed(1) : '-'}</td>
    <td>${e.rank || '-'}</td>
    <td>${e.cashed || '-'}</td>
    <td class="${(e.pl||0) >= 0 ? 'pos' : 'neg'}">${(e.pl||0) >= 0 ? '+' : ''}$${Math.abs(e.pl||0).toFixed(2)}</td>
    <td><button class="btn danger" style="padding:4px 8px;font-size:11px" onclick="deleteEntry('${e.id}')"><i class="ti ti-trash"></i></button></td>
  </tr>`).join('');

  g('hist-table').innerHTML = `<table>
    <thead><tr>
      <th>Date</th><th>Site</th><th>Contest</th><th>Class</th><th>Approach</th>
      <th>Fee</th><th>Score</th><th>Rank</th><th>Cash</th><th>P/L</th><th></th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function setEntryTag(id, val) {
  const e = entries.find(x => String(x.id) === String(id));
  if (!e) return;
  e.tag = (val || '').trim();
  persist();
  renderDashboard();
}

// Tag every entry on a given date that has no tag yet — for backfilling a slate
function tagUntaggedOnDate(date, tag) {
  let n = 0;
  entries.forEach(e => { if (e.date === date && !e.tag) { e.tag = tag; n++; } });
  if (n) { persist(); renderAll(); }
  return n;
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
let luMode = 'cash';

function setLuMode(mode, btn) {
  luMode = mode;
  document.querySelectorAll('.flag-btn[data-group="lu-mode"]').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  const hint = g('lu-mode-hint');
  const wtaSettings = g('lu-wta-settings');
  const buildBtn = g('lu-build-btn');
  const resultTitle = g('lu-result-title');
  if (mode === 'wta') {
    hint.textContent = 'WTA: optimizes for ceiling using SplashPlay proj + (Std Dev x upside weight). Builds 1-4 fully differentiated lineups — no player shared across lineups.';
    wtaSettings.style.display = 'block';
    buildBtn.innerHTML = '<i class="ti ti-wand"></i> Build WTA lineups';
    if (resultTitle) resultTitle.textContent = 'WTA lineups';
    if (!g('lu-wta-lineup-configs').innerHTML) renderWtaLineupConfigs();
  } else {
    hint.textContent = 'Cash: highest consensus floor lineup — both sources must agree within the disagreement threshold.';
    wtaSettings.style.display = 'none';
    buildBtn.innerHTML = '<i class="ti ti-wand"></i> Build optimal cash lineup';
    if (resultTitle) resultTitle.textContent = 'Optimal cash lineup';
  }
}

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
    // Derive opponent from Game Info (e.g. "MIL@STL 07/09/2026 07:45PM ET")
    const gameInfo = (r['game info'] || r['Game Info'] || '').trim();
    let opp = '';
    const mMatch = gameInfo.match(/^([A-Z0-9]+)@([A-Z0-9]+)/i);
    if (mMatch) {
      const away = mMatch[1].toUpperCase(), home = mMatch[2].toUpperCase();
      const tU = team.toUpperCase();
      opp = tU === away ? home : (tU === home ? away : '');
    }
    // Normalize: SP/RP both become SP for optimizer; keep multi-position as-is
    let pos = (rawPos === 'RP') ? 'SP' : rawPos;
    pos = pos.replace(/^CPT\/?/, '').replace(/^MVP\/?/, '') || pos;
    // DK's "Starting" column carries the confirmed batting order slot when lineups
    // have posted — a first-party source, more reliable than a projection file.
    const dkBatPos = parseInt(r['starting'] || r['Starting'] || 0) || 0;
    if (name && sal) {
      // Showdown exports list each player twice: once as CPT (salary already x1.5)
      // and once as UTIL/FLEX (true base salary). Always keep the FLEX/UTIL base
      // salary row -- the builder applies its own 1.5x/2x multiplier for captain cost.
      const isCptRow = rawRosterPos === 'CPT' || rawRosterPos === 'MVP';
      const existingIsCpt = out[name] && out[name]._isCpt;
      if (!out[name] || (existingIsCpt && !isCptRow)) {
        out[name] = { sal, pos, team, id, opp, dkBatPos, _isCpt: isCptRow };
      }
    }
  });
  return out;
}

// - Cross-source name matching -
// DK, SplashPlay and Stokastic do not spell names identically. Sources disagree on
// short forms (Nate / Nathaniel), accents, punctuation and generational suffixes,
// and an exact string join silently drops those players from the pool.
function normName(str) {
  return (str || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // strip accents
    .toLowerCase()
    .replace(/[.'`\u2019]/g, '')                        // periods, apostrophes
    .replace(/[-_]/g, ' ')
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, '')             // generational suffixes
    .replace(/\s+/g, ' ')
    .trim();
}

// Alias keys for one entry: normalized full name, and first-initial + last name
// (which is what bridges Nate/Nathaniel). Team-qualified variants come first so
// same-name players on different teams stay distinct.
function aliasKeys(name, team) {
  const n = normName(name);
  if (!n) return [];
  const parts = n.split(' ').filter(Boolean);
  const first = parts[0] || '';
  const last  = parts.length > 1 ? parts.slice(1).join(' ') : first;
  const init  = `${first.charAt(0)}|${last}`;
  const t     = (team || '').toLowerCase();
  const keys  = [n, init];
  if (t) keys.unshift(`${n}|${t}`, `${init}|${t}`);
  return keys;
}

// Register aliases without clobbering real entries, and blank out any bare
// (non-team-qualified) alias that two different players both claim.
function registerAliases(out, name, team, value) {
  const collisions = out.__collide || (out.__collide = {});
  aliasKeys(name, team).forEach(k => {
    if (k in out && out[k] !== value) {
      // Two distinct players want this key — unsafe, so retire it
      if (!k.includes('|' + (team || '').toLowerCase())) { collisions[k] = true; }
      return;
    }
    if (!(k in out)) out[k] = value;
  });
}

// Try progressively looser keys. Returns undefined rather than a wrong player.
function resolveName(map, name, team) {
  if (!map) return undefined;
  if (name in map) return map[name];
  const collide = map.__collide || {};
  for (const k of aliasKeys(name, team)) {
    if (collide[k]) continue;
    if (k in map) return map[k];
  }
  return undefined;
}

function parseLuSplash(rows) {
  const out = {};
  rows.forEach(r => {
    // "Player Name and Id", "Player Name", "Projection"
    const name = (r['player name'] || r['Player Name'] || r['name'] || '').trim();
    const proj = parseFloat(r['projection'] || r['Projection'] || r['fpts'] || 0) || 0;
    const team = (r['team'] || r['Team'] || '').trim();
    if (name) { out[name] = proj; registerAliases(out, name, team, proj); }
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
    const stdDev = parseFloat(r['std dev'] || r['Std Dev'] || 0) || 0;
    const own    = parseFloat(r['ownership %'] || r['Ownership %'] || 0) || 0;
    const batPos = parseInt(r['bat pos.'] || r['Bat Pos.'] || r['bat pos'] || 0) || 0;
    const confirmed = ((r['confirmed'] || r['Confirmed'] || '') + '').trim().toUpperCase();
    if (name) {
      const key = team ? `${name}|${team}` : name;
      const rec = { proj, team, pos, stdDev, own, batPos, confirmed };
      out[key] = rec;
      if (!out[name] || (out[name].proj === 0 && proj > 0)) out[name] = rec;
      registerAliases(out, name, team, rec);
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

  // WTA mode routes to the multi-lineup generator
  if (luMode === 'wta') { buildWtaLineups(); return; }

  const CAP       = parseInt(gv('lu-cap')) || 50000;
  const MAX_DIFF  = parseFloat(g('lu-max-diff').value) || 2.5;
  const excludeRaw = gv('lu-exclude-teams').toUpperCase().split(',').map(s => s.trim()).filter(Boolean);
  const excludePlayersRaw = gv('lu-exclude-players').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);

  // Parse all three sources first so we can validate locks
  const salMap    = parseLuSalaries(luData.sal);
  const splashMap = parseLuSplash(luData.splash);
  const stokMap   = parseLuStok(luData.stok);

  // WTA settings
  const isWTA       = luMode === 'wta';
  const wtaUpside   = isWTA ? (parseFloat(g('lu-wta-upside').value) || 0.5) : 0;
  const wtaMaxOwn   = isWTA ? (parseFloat(g('lu-wta-max-own').value) || 40) : 100;
  const wtaMaxDiff  = isWTA ? (parseFloat(g('lu-wta-diff').value)    || 5)  : MAX_DIFF;
  // (WTA stack settings now live in the multi-lineup generator; this path is cash-only)
  const wtaStackSize = 0, wtaStackTeam = '', wtaStackStart = 1;
  const wtaScoreMethod = isWTA ? (gv('lu-wta-score-method') || 'value') : 'ceiling';
  const wtaMinSal = isWTA ? (parseInt(gv('lu-wta-min-sal')) || 47000) : 0;

  // Build pool
  luPool = [];
  const allNames = new Set([...Object.keys(salMap), ...Object.keys(splashMap)]);

  const unmatched = [];
  allNames.forEach(name => {
    const salData  = salMap[name];
    if (!salData) return;
    const sp = resolveName(splashMap, name, salData.team) || 0;
    const stEntry = resolveName(stokMap, name, salData.team);
    const st      = stEntry ? stEntry.proj   : 0;
    const stdDev  = stEntry ? stEntry.stdDev : 0;
    const own     = stEntry ? stEntry.own    : 0;
    // DK's confirmed batting order wins when present; Stokastic fills the gap
    const batPos  = salData.dkBatPos || (stEntry ? stEntry.batPos : 0);
    if ((sp === 0 || st === 0) && salData.sal >= 3000) {
      unmatched.push({ name, team: salData.team, sal: salData.sal,
                       missing: sp === 0 && st === 0 ? 'both files' : (sp === 0 ? 'SplashPlay' : 'Stokastic') });
    }
    const team    = salData.team || (stEntry ? stEntry.team : '');
    const pos     = salData.pos  || (stEntry ? stEntry.pos  : '');
    if (sp === 0 || st === 0) return;
    if (salData.sal === 0) return;
    const diff      = Math.abs(sp - st);
    const consensus = (sp + st) / 2;
    // WTA ceiling: bet on SplashPlay (less followed = more contrarian upside) + Stokastic Std Dev for volatility
    // Cash ceiling: consensus (average of both sources) for floor stability
    const ceiling   = sp + wtaUpside * stdDev;
    // Value score: SplashPlay projection per $1k salary (penalizes expensive players)
    const value     = salData.sal > 0 ? sp / (salData.sal / 1000) : 0;
    luPool.push({ name, team, pos, sal: salData.sal, sp, st, diff, consensus, ceiling, value, stdDev, own, batPos });
  });

  // Surface salaried players that failed to join, so a missing projection is
  // visible rather than a silent omission from the pool.
  if (unmatched.length) {
    const top = unmatched.sort((a, b) => b.sal - a.sal).slice(0, 12);
    const list = top.map(u => `${u.name} (${u.team}, $${u.sal}) — no ${u.missing}`).join('<br>');
    const more = unmatched.length > top.length ? `<br><em>…and ${unmatched.length - top.length} more</em>` : '';
    showAlert('lineup-alert',
      `${unmatched.length} salaried players ($3k+) are missing projections and were left out of the pool:<br>${list}${more}`,
      'info', 14000);
  }

  // A player can fill any slot listed in their position string (e.g. "OF/1B" -> OF or 1B)
  function eligibleFor(p, slot) {
    return p.pos.split('/').map(s => s.trim()).includes(slot);
  }

  // - WTA stack pre-selection -
  // Pick stack players before running optimizer so they're treated as soft-locks
  let wtaStackPlayers = [];
  if (isWTA && wtaStackSize >= 4) {
    // Determine stack team: user-specified or auto-pick highest total ceiling by team
    let stackTeam = wtaStackTeam;
    const hitterPool = luPool.filter(p => !eligibleFor(p, 'SP') && p.pos !== 'SP');
    if (!stackTeam) {
      const teamCeiling = {};
      hitterPool.forEach(p => {
        if (!teamCeiling[p.team]) teamCeiling[p.team] = 0;
        teamCeiling[p.team] += p.ceiling;
      });
      stackTeam = Object.entries(teamCeiling).sort((a,b) => b[1]-a[1])[0]?.[0] || '';
    }
    if (stackTeam) {
      // Get hitter slots only (no SP in stack)
      const HITTER_SLOTS = ['C','1B','2B','3B','SS','OF','OF','OF'];
      let stackCandidates = hitterPool.filter(p =>
        p.team === stackTeam &&
        p.diff <= (wtaMaxDiff || 5) &&
        (p.own === 0 || p.own <= (wtaMaxOwn || 40))
      );
      // Build the set of batting order spots for the stack using wraparound
      // e.g. start=4, size=5 -> spots {4,5,6,7,8} but 9-man order so wrap: {4,5,6,7,8}
      // e.g. start=8, size=5 -> {8,9,1,2,3}
      const stackSpots = new Set();
      for (let i = 0; i < wtaStackSize; i++) {
        const spot = ((wtaStackStart - 1 + i) % 9) + 1;
        stackSpots.add(spot);
      }
      const withBatPos = stackCandidates.filter(p => p.batPos >= 1 && stackSpots.has(p.batPos));
      // Only apply if we have enough; otherwise fall back to all available
      if (withBatPos.length >= 2) stackCandidates = withBatPos;
      // Sort by ceiling descending, pick top N for stack size
      stackCandidates.sort((a,b) => b.ceiling - a.ceiling);
      wtaStackPlayers = stackCandidates.slice(0, wtaStackSize);
    }
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

  // Apply exclusions: user-specified teams and players
  const excludeTeams = new Set(excludeRaw);

  // Cash: batting order floor.
  // Plate appearances are the primary driver of hitter floor, and the optimizer
  // is mean-maximizing — it cannot see that a $2k 9-hole bat and a $4k 3-hole bat
  // with the same projection have very different downside. Filter on the actual
  // mechanism (order position) rather than using salary as a proxy, so a genuinely
  // cheap player hitting leadoff stays eligible.
  const maxBatPos = isWTA ? 9 : (parseInt(gv('lu-max-batpos')) || 6);
  const isSP = p => p.pos.split('/').map(x => x.trim()).includes('SP');
  let batPosUnknown = 0, batPosCut = 0;

  // Filter pool: no excluded teams, no excluded players
  const eligiblePool = luPool.filter(p => {
    if (excludeTeams.has(p.team.toUpperCase())) return false;
    if (excludePlayersRaw.some(ex => p.name.toLowerCase().includes(ex))) return false;
    if (isWTA && p.own > 0 && p.own > wtaMaxOwn) return false; // WTA: exclude high-owned chalk
    if (!isWTA && !isSP(p) && maxBatPos < 9) {
      // Unknown order (0) is kept — DK locks salaries before lineups post, so an
      // unconfirmed cheap bat may well hit leadoff. Counted and surfaced instead.
      if (!p.batPos) { batPosUnknown++; }
      else if (p.batPos > maxBatPos) { batPosCut++; return false; }
    }
    return true;
  });

  if (!isWTA && maxBatPos < 9 && batPosUnknown) {
    showAlert('lineup-alert',
      `Batting order filter: ${batPosCut} hitters cut for batting below ${maxBatPos}. ${batPosUnknown} hitters have no confirmed order yet and were kept — re-run once lineups post if any land in your build.`,
      'info', 10000);
  }

  // In WTA mode use relaxed diff threshold; sort by ceiling not consensus
  const activeMaxDiff = isWTA ? wtaMaxDiff : MAX_DIFF;
  const consensusPool = eligiblePool.filter(p => p.diff <= activeMaxDiff);

  // Scoring function: value or ceiling for WTA, consensus for cash
  const score = p => isWTA
    ? (wtaScoreMethod === 'value' ? p.value : p.ceiling)
    : p.consensus;

  // For hitter locks, use user-specified slot if provided (overrides player's primary pos)
  const h1SlotOverride = gv('lu-lock-h1-pos');
  const h2SlotOverride = gv('lu-lock-h2-pos');

  const lockedSP1 = findPlayer(gv('lu-lock-sp1'), 'SP');
  const lockedSP2 = findPlayer(gv('lu-lock-sp2'), 'SP');
  const lockedH1  = findPlayer(gv('lu-lock-h1'));
  const lockedH2  = findPlayer(gv('lu-lock-h2'));

  if (lockedSP1) lockedSP1._slot = 'SP';
  if (lockedSP2) lockedSP2._slot = 'SP';

  // Merge UI locks + WTA stack players, deduplicating by name
  const lockedFromUI = [lockedSP1, lockedSP2, lockedH1, lockedH2].filter(Boolean);
  const lockedNames_ui = new Set(lockedFromUI.map(p => p.name));
  const stackAdditions = wtaStackPlayers.filter(p => !lockedNames_ui.has(p.name));
  const locked = [...lockedFromUI, ...stackAdditions];
  const lockedNames = new Set(locked.map(p => p.name));
  // DK rule: max 5 hitters from one team (SP slots exempt). Seed counts from locks.
  const lockedTeamHitters = {};
  locked.forEach(p => {
    const slot = p._slot || p.pos.split('/')[0].trim();
    if (slot !== 'SP') lockedTeamHitters[p.team] = (lockedTeamHitters[p.team] || 0) + 1;
  });
  const countTeamHitters = (chosenArr) => {
    const c = Object.assign({}, lockedTeamHitters);
    chosenArr.forEach(p => { if (p._slot !== 'SP') c[p.team] = (c[p.team] || 0) + 1; });
    return c;
  };
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

  // WTA stack players: assign to first eligible open slot
  stackAdditions.forEach(p => {
    const slot = Object.keys(REQUIRED_ALL).find(s =>
      s !== 'SP' && eligibleFor(p, s) && slotsNeeded[s] > 0
    );
    p._slot = slot || p.pos.split('/')[0].trim();
    if (slotsNeeded[p._slot] !== undefined && slotsNeeded[p._slot] > 0) slotsNeeded[p._slot]--;
  });

  // - Salary-aware optimizer -
  const warnings = [];

  // Note which team was stacked (if WTA stack mode)
  if (isWTA && wtaStackSize >= 4 && wtaStackPlayers.length > 0) {
    const stackTeamUsed = wtaStackPlayers[0].team;
    warnings.push(`WTA stack: ${wtaStackPlayers.length}-man ${stackTeamUsed} stack locked in (${wtaStackPlayers.map(p=>p.name).join(', ')}).${wtaStackPlayers.length < wtaStackSize ? ` Only ${wtaStackPlayers.length} of ${wtaStackSize} requested ${stackTeamUsed} hitters could be assigned valid roster slots (positional overlap or ownership/threshold filters).` : ''}`);
  }

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
    ).sort((a,b) => score(b) - score(a));
    if (consensus.length) return consensus;
    return eligiblePool.filter(p =>
      eligibleFor(p, pos) && !usedNames.has(p.name) && p.sal <= budgetRemaining
    ).sort((a,b) => score(b) - score(a));
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
               .sort((a, b) => score(b) - score(a))
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
        const total = chosen.reduce((s, p) => s + score(p), 0);
        if (total > best.total) { best.total = total; best.combo = [...chosen]; }
        return;
      }
      const restSlots = slotsArr.slice(slotIdx + 1);
      const minRest = minCostForSlots(startPool, restSlots, used);
      if (minRest === Infinity) return;

      const slotPos = slotsArr[slotIdx];
      const teamCounts = countTeamHitters(chosen);
      for (const p of candidatesPerSlot[slotIdx]) {
        if (capped) return;
        if (used.has(p.name)) continue;
        if (p.sal > budgetLeft - minRest) continue;
        if (slotPos !== 'SP' && (teamCounts[p.team] || 0) >= 5) continue;
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
      const teamCounts = countTeamHitters(chosen);
      const cands = startPool
        .filter(p => eligibleFor(p, pos) && !used.has(p.name) && p.sal <= budgetForThis &&
                     (pos === 'SP' || (teamCounts[p.team] || 0) < 5))
        .sort((a, b) => score(b) - score(a));
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
      const total = result.reduce((a,p) => a + score(p), 0);
      if (total > bestTotal) { bestTotal = total; bestCombo = result; }
    }
    if (!bestCombo && tryPool === consensusPool) {
      warnings.push(isWTA
        ? 'No WTA lineup found within threshold - relaxing ownership/disagreement filters.'
        : 'No consensus lineup found within budget - relaxing disagreement threshold.');
    }
  }

  if (!bestCombo) {
    showAlert('lineup-alert', 'Could not build a valid lineup - check salary cap, excluded teams, or locked players.', 'danger');
    return;
  }

  // Flag players outside threshold
  bestCombo.forEach(p => {
    if (isWTA && p.own > wtaMaxOwn && p.own > 0)
      warnings.push(`${p.name} is above max ownership threshold (${p.own.toFixed(0)}% > ${wtaMaxOwn}%) - no better option available.`);
    if (!isWTA && p.diff > MAX_DIFF)
      warnings.push(`${p.name} is outside consensus threshold (diff: ${p.diff.toFixed(1)} pts) - no better option was available.`);
  });

  luLineup = [...locked, ...bestCombo];

  // WTA minimum salary enforcement: upgrade non-locked slots while
  // there are better-scoring players available within budget.
  // Minimum salary acts as a floor, not a target.
  if (isWTA && wtaMinSal > 0) {
    const lockedSet = new Set(locked.map(p => p.name));
    const MAX_UPGRADE_PASSES = 20; // hard safety cap
    let passes = 0;
    let improved = true;

    while (improved && passes < MAX_UPGRADE_PASSES) {
      improved = false;
      passes++;
      const totalSal = luLineup.reduce((a,p) => a + p.sal, 0);
      const belowMin = totalSal < wtaMinSal;
      const nonLocked = luLineup.filter(p => !lockedSet.has(p.name)).sort((a,b) => a.sal - b.sal);

      for (const toReplace of nonLocked) {
        const slot = toReplace._slot || toReplace.pos.split('/')[0].trim();
        const usedNames = new Set(luLineup.map(p => p.name));
        usedNames.delete(toReplace.name);
        const budgetLeft = CAP - totalSal + toReplace.sal;

        const upgrade = luPool
          .filter(p =>
            eligibleFor(p, slot) &&
            !usedNames.has(p.name) &&
            p.sal <= budgetLeft &&
            p.sal > toReplace.sal && // must cost more (avoids pointless swaps)
            p.diff <= (isWTA ? wtaMaxDiff : MAX_DIFF) &&
            (p.own === 0 || p.own <= (isWTA ? wtaMaxOwn : 100)) &&
            (!belowMin ? score(p) > score(toReplace) + 0.01 : true) // above min: require meaningful score gain
          )
          .sort((a,b) => belowMin ? b.sal - a.sal : score(b) - score(a))[0];

        if (upgrade) {
          const idx = luLineup.findIndex(p => p.name === toReplace.name);
          upgrade._slot = slot;
          luLineup[idx] = upgrade;
          improved = true;
          break;
        }
      }
    }

    const finalSal = luLineup.reduce((a,p) => a + p.sal, 0);
    if (finalSal < wtaMinSal) {
      warnings.push(`Lineup total $${finalSal.toLocaleString()} is below minimum $${wtaMinSal.toLocaleString()} — no upgrades found within ownership/threshold filters.`);
    }
  }

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

  renderLineupResult(warnings, CAP, activeMaxDiff, wtaScoreMethod);
  g('lu-result').style.display = 'block';
  renderPool();
}

function renderLineupResult(warnings, CAP, MAX_DIFF, wtaScoreMethod = 'value') {
  const totalSal  = luLineup.reduce((a, p) => a + p.sal, 0);
  const totalSP   = luLineup.reduce((a, p) => a + p.sp, 0);
  const totalST   = luLineup.reduce((a, p) => a + p.st, 0);
  const totalCons = luLineup.reduce((a, p) => a + p.consensus, 0);
  const totalCeil = luLineup.reduce((a, p) => a + (p.ceiling || p.consensus), 0);
  const under = CAP - totalSal;
  const isWTA = luMode === 'wta';

  const posLabel = p => p._slot || p.pos.split('/')[0].trim();

  const rows = luLineup.map(p => {
    const diffFlag = (!isWTA && p.diff > MAX_DIFF)
      ? `<span style="color:var(--red);font-size:10px"> - diff ${p.diff.toFixed(1)}</span>` : '';
    const ownFlag = (isWTA && p.own > 0)
      ? `<span style="color:var(--gray-500);font-size:10px"> ${p.own.toFixed(0)}%own</span>` : '';
    if (isWTA) {
      const scoreVal = wtaScoreMethod === 'value' ? p.value.toFixed(2) : (p.ceiling||p.consensus).toFixed(2);
      const scoreLabel = wtaScoreMethod === 'value' ? 'Value/1k' : 'Ceiling';
      return `<tr>
        <td><strong>${posLabel(p)}</strong></td>
        <td>${p.name}${ownFlag}</td>
        <td>${p.team}</td>
        <td style="text-align:right">${p.batPos > 0 ? '#' + p.batPos : '-'}</td>
        <td style="text-align:right">$${p.sal.toLocaleString()}</td>
        <td style="text-align:right">${p.sp.toFixed(2)}</td>
        <td style="text-align:right">${(p.stdDev||0).toFixed(2)}</td>
        <td style="text-align:right"><strong>${scoreVal}</strong></td>
      </tr>`;
    }
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

  const scoreColLabel = (isWTA && wtaScoreMethod === 'value') ? 'Value/1k' : isWTA ? 'Ceiling' : 'Consensus';
  const thead = isWTA
    ? `<tr><th style="text-align:left">Pos</th><th style="text-align:left">Player</th><th style="text-align:left">Team</th><th>Bat#</th><th>Salary</th><th>SplashPlay</th><th>Std Dev</th><th>${scoreColLabel}</th></tr>`
    : `<tr><th style="text-align:left">Pos</th><th style="text-align:left">Player</th><th style="text-align:left">Team</th><th>Salary</th><th>SplashPlay</th><th>Stokastic</th><th>Consensus</th><th>Diff</th></tr>`;

  const tfoot = isWTA
    ? `<tr style="font-weight:600;border-top:2px solid var(--gray-200)"><td colspan="4">TOTAL</td><td style="text-align:right">$${totalSal.toLocaleString()}</td><td style="text-align:right">${totalCons.toFixed(2)}</td><td></td><td style="text-align:right">${totalCeil.toFixed(2)}</td></tr>`
    : `<tr style="font-weight:600;border-top:2px solid var(--gray-200)"><td colspan="3">TOTAL</td><td style="text-align:right">$${totalSal.toLocaleString()}</td><td style="text-align:right">${totalSP.toFixed(2)}</td><td style="text-align:right">${totalST.toFixed(2)}</td><td style="text-align:right">${totalCons.toFixed(2)}</td><td></td></tr>`;

  g('lu-lineup-table').innerHTML = `
    <table class="bd-table" style="font-size:13px">
      <thead>${thead}</thead>
      <tbody>${rows}</tbody>
      <tfoot>
        ${tfoot}
        <tr><td colspan="${isWTA ? 8 : 8}" style="text-align:right;font-size:12px;color:${capColor};font-weight:600">${capLabel}</td></tr>
      </tfoot>
    </table>`;

  const noWarnMsg = isWTA
    ? 'No warnings - lineup built within WTA ceiling settings.'
    : 'No warnings - all players within consensus threshold.';
  const warnHTML = warnings.length
    ? warnings.map(w => `<div class="alert info" style="margin-bottom:6px"><i class="ti ti-alert-circle"></i>${w}</div>`).join('')
    : `<div style="font-size:12px;color:var(--gray-500)">${noWarnMsg}</div>`;
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

  // Render SplashPlay edge table (cash mode only, when both sources available)
  if (!isWTA) renderEdgeTable('lu-edge-card', 'lu-edge-table', luPool);
  else { const ec = g('lu-edge-card'); if (ec) ec.style.display = 'none'; }
}

function renderEdgeTable(cardId, tableId, pool) {
  const card = g(cardId);
  const table = g(tableId);
  if (!card || !table) return;

  // Players where SplashPlay > Stokastic by at least 1 point — sorted by gap descending
  const edgePlays = pool
    .filter(p => p.sp > 0 && p.st > 0 && (p.sp - p.st) >= 1.0)
    .sort((a,b) => (b.sp - b.st) - (a.sp - a.st))
    .slice(0, 15);

  if (!edgePlays.length) { card.style.display = 'none'; return; }

  const rows = edgePlays.map(p => {
    const gap = p.sp - p.st;
    return `<tr>
      <td>${p.pos}</td>
      <td><strong>${p.name}</strong></td>
      <td>${p.team}</td>
      <td style="text-align:right">$${p.sal.toLocaleString()}</td>
      <td style="text-align:right">${p.sp.toFixed(2)}</td>
      <td style="text-align:right">${p.st.toFixed(2)}</td>
      <td style="text-align:right;color:var(--green);font-weight:600">+${gap.toFixed(2)}</td>
    </tr>`;
  }).join('');

  table.innerHTML = `<table>
    <thead><tr><th>Pos</th><th>Player</th><th>Team</th><th>Salary</th><th>SplashPlay</th><th>Stokastic</th><th>SP Edge</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
  card.style.display = 'block';
}

function renderPool() {
  if (!luPool.length) return;
  const posFilter  = gv('lu-pool-pos');
  const sortBy     = gv('lu-pool-sort') || 'consensus';
  const MAX_DIFF   = parseFloat(g('lu-max-diff').value) || 2.5;
  const excludeRaw = gv('lu-exclude-teams').toUpperCase().split(',').map(s => s.trim()).filter(Boolean);
  const excludeTeams = new Set(excludeRaw);
  const exPlayers = gv('lu-exclude-players').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);

  let data = [...luPool].filter(p =>
    !excludeTeams.has(p.team.toUpperCase()) &&
    !exPlayers.some(ex => p.name.toLowerCase().includes(ex))
  );
  if (posFilter) data = data.filter(p => p.pos && p.pos.includes(posFilter));
  data.sort((a, b) => {
    if (sortBy === 'diff')    return a.diff - b.diff;
    if (sortBy === 'salary')  return b.sal - a.sal;
    return b.consensus - a.consensus;
  });

  const inLineup = new Set([
    ...luLineup.map(p => p.name),
    ...(typeof wtaLineups !== 'undefined' ? wtaLineups.flatMap(l => l.players.map(p => p.name)) : [])
  ]);

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
  ['lu-lock-sp1','lu-lock-sp2','lu-lock-h1','lu-lock-h2','lu-exclude-teams','lu-exclude-players'].forEach(id => {
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
  const CPT_MULT_SAL  = SITE === 'FD' ? 1 : 1.5;
  const CPT_MULT_PTS  = SITE === 'FD' ? 2 : 1.5;
  const stokOnly = sdSplashSkipped || !sdData.splash;
  const sdExcludePlayersRaw = gv('sd-exclude-players').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);

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
  const flexInputs = flexInput ? flexInput.split(',').map(s => s.trim()).filter(Boolean) : [];

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
  const notFoundFlex = flexInputs.find(fi => !findSdPlayer(fi));
  if (notFoundFlex) {
    showAlert('sd-alert', `FLEX lock "${notFoundFlex}" not found in this slate.`, 'danger');
    return;
  }

  const lockedCpt  = findSdPlayer(cptInput);
  const lockedFlexPlayers = flexInputs.map(fi => findSdPlayer(fi)).filter(Boolean)
    .filter(p => !lockedCpt || p.name !== lockedCpt.name); // don't double-lock CPT

  // Build eligible pool: apply consensus filter
  // Apply player exclusions (partial name match)
  const sdAvailablePool = sdExcludePlayersRaw.length
    ? sdPool.filter(p => !sdExcludePlayersRaw.some(ex => p.name.toLowerCase().includes(ex)))
    : sdPool;

  const consensusPool = sdAvailablePool.filter(p => p.diff <= MAX_DIFF);
  const eligiblePool  = sdAvailablePool;

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
    for (const lf of lockedFlexPlayers) {
      if (lf.name !== captain.name && !used.has(lf.name)) {
        flexChosen.push(lf);
        used.add(lf.name);
        budgetLeft -= lf.sal;
        if (budgetLeft < 0) return null;
      }
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
  renderShowdownResult(warnings, CAP, SITE, stokOnly);
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

function renderShowdownResult(warnings, CAP, SITE, stokOnly = false) {
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

  // Render SplashPlay edge table when both sources available
  if (!stokOnly && sdPool.some(p => p.sp > 0 && p.st > 0)) {
    renderEdgeTable('sd-edge-card', 'sd-edge-table', sdPool);
  } else {
    const ec = g('sd-edge-card'); if (ec) ec.style.display = 'none';
  }
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
  ['sd-lock-cpt','sd-lock-flex','sd-exclude-players'].forEach(id => { const el = g(id); if (el) el.value = ''; });
  const teamSel = g('sd-pool-team');
  if (teamSel) teamSel.innerHTML = '<option value="">All teams</option>';
}

// ============================================================================
// MULTI-LINEUP WTA GENERATOR
// ============================================================================
let wtaLineups = []; // array of { players: [...], config: {...} }

function renderWtaLineupConfigs() {
  const n = parseInt(gv('lu-wta-num-lineups')) || 1;
  const container = g('lu-wta-lineup-configs');
  if (!container) return;
  let html = '';
  for (let i = 1; i <= n; i++) {
    html += `
      <div class="wta-lu-config">
        <div class="wta-lu-config-label">Lineup ${i}</div>
        <div class="form-grid three">
          <div class="field">
            <label>Stack team (abbrev)</label>
            <input type="text" id="lu-wta-team-${i}" placeholder="blank = auto" maxlength="5" style="text-transform:uppercase">
          </div>
          <div class="field">
            <label>Stack size</label>
            <select id="lu-wta-size-${i}">
              <option value="0">No stack</option>
              <option value="4">4-man</option>
              <option value="5" selected>5-man</option>
            </select>
          </div>
          <div class="field">
            <label>Start bat order #</label>
            <input type="number" id="lu-wta-start-${i}" value="1" min="1" max="9" step="1">
          </div>
        </div>
      </div>`;
  }
  container.innerHTML = html;
}

function buildWtaLineups() {
  const CAP        = parseInt(gv('lu-cap')) || 50000;
  const wtaUpside  = parseFloat(g('lu-wta-upside').value) || 0.5;
  const wtaMaxOwn  = parseFloat(g('lu-wta-max-own').value) || 40;
  const wtaMaxDiff = parseFloat(g('lu-wta-diff').value) || 5;
  const wtaScoreMethod = gv('lu-wta-score-method') || 'ceiling';
  const wtaMinSal  = parseInt(gv('lu-wta-min-sal')) || 49000;
  const numLineups = parseInt(gv('lu-wta-num-lineups')) || 1;
  const excludeTeams = new Set(gv('lu-exclude-teams').toUpperCase().split(',').map(s => s.trim()).filter(Boolean));
  const excludePlayersRaw = gv('lu-exclude-players').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);

  // Per-lineup configs
  const configs = [];
  for (let i = 1; i <= numLineups; i++) {
    configs.push({
      team:  (gv(`lu-wta-team-${i}`) || '').toUpperCase().trim(),
      size:  parseInt(gv(`lu-wta-size-${i}`)) || 0,
      start: parseInt(gv(`lu-wta-start-${i}`)) || 1,
    });
  }

  // Build pool (same logic as cash path)
  const salMap    = parseLuSalaries(luData.sal);
  const splashMap = parseLuSplash(luData.splash);
  const stokMap   = parseLuStok(luData.stok);

  luPool = [];
  const allNames = new Set([...Object.keys(salMap), ...Object.keys(splashMap)]);
  allNames.forEach(name => {
    const salData = salMap[name];
    if (!salData) return;
    const sp = splashMap[name] || 0;
    const teamKey = salData.team ? `${name}|${salData.team}` : name;
    const stEntry = stokMap[teamKey] || stokMap[name];
    const st     = stEntry ? stEntry.proj   : 0;
    const stdDev = stEntry ? stEntry.stdDev : 0;
    const own    = stEntry ? stEntry.own    : 0;
    const batPos = stEntry ? stEntry.batPos : 0;
    const team   = (salData.team || (stEntry ? stEntry.team : '')).toUpperCase();
    const pos    = salData.pos || (stEntry ? stEntry.pos : '');
    if (sp === 0 || st === 0 || salData.sal === 0) return;
    if (excludeTeams.has(team)) return;
    if (excludePlayersRaw.some(ex => name.toLowerCase().includes(ex))) return;
    // Pitchers must be Confirmed (C) or Probable (P) when the Stokastic file carries the flag
    const confirmed = stEntry ? (stEntry.confirmed || '') : '';
    if (pos.includes('SP') && confirmed && confirmed !== 'C' && confirmed !== 'P') return;
    const diff = Math.abs(sp - st);
    const ceiling = sp + wtaUpside * stdDev;
    const value = sp / (salData.sal / 1000);
    luPool.push({ name, team, pos, sal: salData.sal, sp, st, diff, ceiling, value, stdDev, own, batPos,
                  confirmed, opp: salData.opp || '', consensus: (sp + st) / 2 });
  });

  if (!luPool.length) {
    showAlert('lineup-alert', 'No players in pool — check that all three files are for the same slate.', 'danger');
    return;
  }

  // Sanity check: if very few salary-file players matched projections, files are likely mismatched slates
  const salCount = Object.keys(salMap).length;
  if (luPool.length < Math.min(60, salCount * 0.1)) {
    showAlert('lineup-alert', `Warning: only ${luPool.length} of ${salCount} salary-file players matched both projection sources. Your files may be from different slates — verify all three exports are for the same games.`, 'info', 12000);
  }

  const eligibleFor = (p, slot) => p.pos.split('/').map(s => s.trim()).includes(slot);
  const isPitcher = p => p.pos.split('/').map(s => s.trim()).includes('SP');

  // Proportional projection-disagreement test.
  // An absolute point threshold is wrong across position groups: 5 pts on a
  // 22-pt ace is a small disagreement, 5 pts on an 8-pt hitter is enormous.
  // Scale the allowance to the size of the projection instead.
  // Pitchers get a wider allowance than hitters — SP projections carry genuinely
  // larger spreads between sources (innings, K rate, and hook timing all vary),
  // so the same percentage would still cut the top arms.
  const DIFF_PCT_SP  = 0.40;
  const DIFF_PCT_BAT = 0.25;
  const diffOK = p => {
    const base = Math.max(p.sp, p.st);
    if (base <= 0) return false;
    const pct = isPitcher(p) ? DIFF_PCT_SP : DIFF_PCT_BAT;
    return p.diff <= Math.max(wtaMaxDiff, base * pct);
  };

  // Ownership cap never applies to pitchers. Fading a top arm for ownership is
  // the single most damaging thing this builder can do — winners roster chalk
  // pitchers and differentiate with bats.
  const ownOK = p => isPitcher(p) || p.own === 0 || p.own <= wtaMaxOwn;

  const passesFilters = p => diffOK(p) && ownOK(p);

  // Ceiling scoring understates aces: elite pitchers have LOW std dev, which is
  // what makes them elite. Give pitchers a reduced volatility weight so a
  // volatile mid-tier arm doesn't outrank a dominant one on ceiling alone.
  const score = p => {
    if (wtaScoreMethod === 'value') return p.value;
    if (isPitcher(p)) return p.sp + (wtaUpside * 0.4) * p.stdDev;
    return p.ceiling;
  };

  // Parse lock fields — locked players go into Lineup 1
  const findInPool = (nameInput, posFilter) => {
    if (!nameInput) return null;
    const nl = nameInput.trim().toLowerCase();
    return luPool.find(p => p.name.toLowerCase().includes(nl) && (!posFilter || p.pos.includes(posFilter)));
  };
  const lockDefs = [
    { input: gv('lu-lock-sp1'), pos: 'SP', label: 'Lock SP1' },
    { input: gv('lu-lock-sp2'), pos: 'SP', label: 'Lock SP2' },
    { input: gv('lu-lock-h1'),  pos: gv('lu-lock-h1-pos') || null, label: 'Lock hitter 1' },
    { input: gv('lu-lock-h2'),  pos: gv('lu-lock-h2-pos') || null, label: 'Lock hitter 2' },
  ];
  const lockedPlayers = [];
  for (const ld of lockDefs) {
    if (!ld.input) continue;
    const found = findInPool(ld.input, ld.pos === 'SP' ? 'SP' : null);
    if (!found) {
      showAlert('lineup-alert', `${ld.label} "${ld.input}" not found in the WTA pool. Note: pool requires both sources to project the player and ownership below the max filter.`, 'danger');
      return;
    }
    if (!lockedPlayers.some(p => p.name === found.name)) {
      lockedPlayers.push(Object.assign({}, found, { _lockPos: ld.pos }));
    }
  }

  const warnings = [];

  // - Forced players with exposure targets -
  // These are the only players permitted to repeat across lineups. Everyone else
  // stays under the hard no-duplicate rule.
  const forced = [];
  // Split on newlines only — a comma is allowed *within* a line as the
  // name/percent separator ("Tarik Skubal, 25").
  const forcedRaw = (gv('lu-wta-force') || '')
    .split(/\r?\n/).map(x => x.trim().replace(/,\s*$/, '')).filter(Boolean);
  forcedRaw.forEach((line, j) => {
    // "Blake Snell 50" / "Blake Snell 50%" / "Blake Snell"
    const m = line.match(/^(.*?)[\s,]+(\d{1,3})\s*%?$/);
    const nameIn = (m ? m[1] : line).trim();
    const pct    = m ? parseInt(m[2]) : 50;
    const found  = findInPool(nameIn, null);
    if (!found) {
      warnings.push(`Force "${nameIn}" not found in the player pool — check spelling, or the salary/projection files may not cover that player.`);
      return;
    }
    if (forced.some(f => f.p.name === found.name)) return;
    const targetCount = Math.min(numLineups, Math.max(1, Math.round((pct / 100) * numLineups)));
    // Stagger start positions so multiple forced players don't all pile into
    // lineup 1 and leave the rest of the book without any of them.
    const lineups = new Set();
    for (let k = 0; k < targetCount; k++) lineups.add(((j + k) % numLineups) + 1);
    forced.push({ p: found, pct, targetCount, lineups });
  });
  const forcedNames = new Set(forced.map(f => f.p.name));

  const globalUsed = new Set(); // no player in more than one lineup
  wtaLineups = [];

  // - Filter audit: fail loudly when the filters drop a top-of-board player -
  // Silent exclusion is how the builder ended up fading the slate's best arm
  // without ever saying so. Surface it instead.
  (function auditFilters() {
    const dropped = luPool.filter(p => !passesFilters(p));
    if (!dropped.length) return;

    // Top 2 pitchers and top 5 hitters by score, before any filtering
    const pitchers = luPool.filter(isPitcher).sort((a,b) => score(b) - score(a)).slice(0, 2);
    const hitters  = luPool.filter(p => !isPitcher(p)).sort((a,b) => score(b) - score(a)).slice(0, 5);
    const notable  = [...pitchers, ...hitters].filter(p => !passesFilters(p));

    notable.forEach(p => {
      const why = [];
      if (!diffOK(p)) why.push(`projections disagree by ${p.diff.toFixed(1)} pts (SplashPlay ${p.sp.toFixed(1)} / Stokastic ${p.st.toFixed(1)})`);
      if (!ownOK(p))  why.push(`${p.own.toFixed(0)}% owned, above the ${wtaMaxOwn}% cap`);
      warnings.push(`Filtered out ${p.name} (${p.team}), a top-board ${isPitcher(p) ? 'pitcher' : 'hitter'} — ${why.join(' and ')}. Lock the player or loosen the filter if you want them.`);
    });
  })();

  for (let li = 0; li < configs.length; li++) {
    const cfg = configs[li];
    const forcedHere = forced
      .filter(f => f.lineups.has(li + 1))
      .map(f => Object.assign({}, f.p, {
        _lockPos: isPitcher(f.p) ? 'SP' : null,
        _forced: true,
      }));
    // A player named in both the lock fields and the force list is only added once
    const seedLocks = (li === 0 ? lockedPlayers : [])
      .filter(l => !forcedHere.some(f => f.name === l.name))
      .concat(forcedHere);

    const result = buildOneWta(cfg, li + 1, seedLocks);
    if (!result) {
      warnings.push(`Lineup ${li + 1}: could not build a valid lineup with remaining player pool. Try fewer lineups or looser filters.`);
      continue;
    }
    // Forced players stay available — they are the only permitted repeats
    result.players.forEach(p => { if (!forcedNames.has(p.name)) globalUsed.add(p.name); });
    wtaLineups.push(result);
  }

  function buildOneWta(cfg, num, locks = []) {
    // Pool for this lineup: eligible + not used in prior lineups.
    // Locked players bypass the ownership/diff filters.
    const lockNames = new Set(locks.map(p => p.name));
    const forcedHereNames = new Set(locks.filter(p => p._forced).map(p => p.name));
    const pool = luPool.filter(p => {
      // Forced players appear only in the lineups assigned to them, and bypass
      // the ownership and disagreement filters — the point is to override.
      if (forcedNames.has(p.name)) return forcedHereNames.has(p.name);
      if (globalUsed.has(p.name)) return false;
      return lockNames.has(p.name) || passesFilters(p);
    });

    // - Assign locks to slots first -
    const preAssigned = [];
    const lockSlotsAvail = { 'SP':2,'C':1,'1B':1,'2B':1,'3B':1,'SS':1,'OF':3 };
    for (const lk of locks) {
      let slot = null;
      if (lk._lockPos === 'SP') slot = lockSlotsAvail['SP'] > 0 ? 'SP' : null;
      else if (lk._lockPos && lockSlotsAvail[lk._lockPos] > 0 && eligibleFor(lk, lk._lockPos)) slot = lk._lockPos;
      else slot = Object.keys(lockSlotsAvail).find(s => s !== 'SP' && lockSlotsAvail[s] > 0 && eligibleFor(lk, s));
      if (slot) {
        preAssigned.push(Object.assign({}, lk, { _slot: slot }));
        lockSlotsAvail[slot]--;
      } else {
        warnings.push(`Lineup ${num}: lock ${lk.name} could not be assigned a slot.`);
      }
    }

    // - Stack selection -
    let stackPlayers = [];
    if (cfg.size >= 4) {
      let stackTeam = cfg.team;
      const hitters = pool.filter(p => !eligibleFor(p, 'SP'));
      if (!stackTeam) {
        // Never auto-pick a stack facing a pitcher we have already committed to
        const spOpps = new Set(preAssigned.filter(p => p._slot === 'SP' && p.opp).map(p => p.opp.toUpperCase()));
        const tc = {};
        hitters.forEach(p => {
          if (spOpps.has(p.team)) return;
          tc[p.team] = (tc[p.team] || 0) + p.ceiling;
        });
        stackTeam = Object.entries(tc).sort((a,b) => b[1]-a[1])[0]?.[0] || '';
      }
      if (stackTeam) {
        const spots = new Set();
        for (let i = 0; i < cfg.size; i++) spots.add(((cfg.start - 1 + i) % 9) + 1);
        const preNames = new Set(preAssigned.map(p => p.name));
        let cands = hitters.filter(p => p.team === stackTeam && !preNames.has(p.name));
        const withBat = cands.filter(p => p.batPos >= 1 && spots.has(p.batPos));
        if (withBat.length >= 2) cands = withBat;
        cands.sort((a,b) => score(b) - score(a));

        // Assign stack players to slots greedily, respecting slots left after locks
        const slotsAvail = { 'C':1,'1B':1,'2B':1,'3B':1,'SS':1,'OF':3 };
        preAssigned.forEach(p => { if (p._slot !== 'SP' && slotsAvail[p._slot] > 0) slotsAvail[p._slot]--; });
        for (const p of cands) {
          if (stackPlayers.length >= cfg.size) break;
          const slot = Object.keys(slotsAvail).find(s => slotsAvail[s] > 0 && eligibleFor(p, s));
          if (slot) {
            const cp = Object.assign({}, p, { _slot: slot });
            stackPlayers.push(cp);
            slotsAvail[slot]--;
          }
        }
        if (stackPlayers.length < cfg.size) {
          warnings.push(`Lineup ${num}: only ${stackPlayers.length} of ${cfg.size} ${stackTeam} stack hitters fit (positional overlap or filters).`);
        }
        cfg._resolvedTeam = stackTeam;
      }
    }

    // - Fill remaining slots -
    const SLOTS = { 'SP':2,'C':1,'1B':1,'2B':1,'3B':1,'SS':1,'OF':3 };
    preAssigned.forEach(p => { if (SLOTS[p._slot] > 0) SLOTS[p._slot]--; });
    stackPlayers.forEach(p => { if (SLOTS[p._slot] > 0) SLOTS[p._slot]--; });
    const slotsToFill = [];
    Object.entries(SLOTS).forEach(([pos, cnt]) => { for (let i = 0; i < cnt; i++) slotsToFill.push(pos); });
    // Most-constrained first
    slotsToFill.sort((a,b) =>
      pool.filter(p => eligibleFor(p,a)).length - pool.filter(p => eligibleFor(p,b)).length
    );

    const starters = [...preAssigned, ...stackPlayers];
    const usedNames = new Set(starters.map(p => p.name));
    let budget = CAP - starters.reduce((a,p) => a + p.sal, 0);
    const chosen = [...starters];

    const minCost = (slots, used) => {
      const tmp = new Set(used);
      let tot = 0;
      for (const s of slots) {
        const opts = pool.filter(p => eligibleFor(p,s) && !tmp.has(p.name)).sort((a,b) => a.sal - b.sal);
        if (!opts.length) return Infinity;
        tot += opts[0].sal; tmp.add(opts[0].name);
      }
      return tot;
    };

    // Track hitters per team (DK max: 5 hitters from one team; pitchers exempt)
    const teamHitterCount = {};
    chosen.forEach(p => {
      if (p._slot !== 'SP') teamHitterCount[p.team] = (teamHitterCount[p.team] || 0) + 1;
    });

    for (let i = 0; i < slotsToFill.length; i++) {
      const pos = slotsToFill[i];
      const rest = slotsToFill.slice(i + 1);
      const restMin = minCost(rest, usedNames);
      if (restMin === Infinity) return null;
      const budgetForThis = budget - restMin;
      // Teams we hold hitters from — an SP facing them is anticorrelated
      const hitterTeams = new Set(chosen.filter(x => x._slot !== 'SP').map(x => x.team));
      const stackTeamNow = cfg._resolvedTeam || '';
      const cands = pool
        .filter(p => {
          if (!eligibleFor(p, pos) || usedNames.has(p.name) || p.sal > budgetForThis) return false;
          if (pos !== 'SP' && (teamHitterCount[p.team] || 0) >= 5) return false;
          if (pos === 'SP' && p.opp) {
            // Hard block: SP facing the defined stack team
            if (stackTeamNow && p.opp === stackTeamNow) return false;
            // Also avoid SPs facing any team we already have bats from
            if (hitterTeams.has(p.opp)) return false;
          }
          return true;
        })
        .sort((a,b) => score(b) - score(a));
      // If the opponent guard left nothing, relax to stack-team-only blocking
      if (!cands.length && pos === 'SP') {
        const relaxed = pool
          .filter(p => eligibleFor(p, pos) && !usedNames.has(p.name) && p.sal <= budgetForThis &&
                       !(stackTeamNow && p.opp === stackTeamNow))
          .sort((a,b) => score(b) - score(a));
        if (relaxed.length) {
          warnings.push(`Lineup ${num}: SP pool was tight — allowed an arm facing a non-stack bat.`);
          cands.push(...relaxed);
        }
      }
      if (!cands.length) return null;
      const pick = Object.assign({}, cands[0], { _slot: pos });
      chosen.push(pick);
      usedNames.add(pick.name);
      if (pos !== 'SP') teamHitterCount[pick.team] = (teamHitterCount[pick.team] || 0) + 1;
      budget -= pick.sal;
    }

    // - Min salary upgrade pass (capped) — never swaps locks or stack -
    const stackNames = new Set([...stackPlayers.map(p => p.name), ...preAssigned.map(p => p.name)]);
    let passes = 0, improved = true;
    while (improved && passes < 20) {
      improved = false; passes++;
      const totalSal = chosen.reduce((a,p) => a + p.sal, 0);
      const belowMin = totalSal < wtaMinSal;
      const swappable = chosen.filter(p => !stackNames.has(p.name)).sort((a,b) => a.sal - b.sal);
      for (const rep of swappable) {
        const used2 = new Set(chosen.map(p => p.name)); used2.delete(rep.name);
        const budgetLeft = CAP - totalSal + rep.sal;
        const hittersByTeam = {};
        chosen.forEach(p => {
          if (p._slot !== 'SP' && p.name !== rep.name) hittersByTeam[p.team] = (hittersByTeam[p.team] || 0) + 1;
        });
        const heldHitterTeams = new Set(chosen.filter(x => x._slot !== 'SP' && x.name !== rep.name).map(x => x.team));
        const stackTeamNow2 = cfg._resolvedTeam || '';
        const upg = pool
          .filter(p => eligibleFor(p, rep._slot) && !used2.has(p.name) &&
                       p.sal <= budgetLeft && p.sal > rep.sal &&
                       (rep._slot === 'SP' || (hittersByTeam[p.team] || 0) < 5) &&
                       !(rep._slot === 'SP' && p.opp &&
                         ((stackTeamNow2 && p.opp === stackTeamNow2) || heldHitterTeams.has(p.opp))) &&
                       !(rep._slot !== 'SP' && chosen.some(x => x._slot === 'SP' && x.opp === p.team)) &&
                       (!belowMin ? score(p) > score(rep) + 0.01 : true))
          .sort((a,b) => belowMin ? b.sal - a.sal : score(b) - score(a))[0];
        if (upg) {
          const idx = chosen.findIndex(p => p.name === rep.name);
          chosen[idx] = Object.assign({}, upg, { _slot: rep._slot });
          improved = true;
          break;
        }
      }
    }

    return { players: chosen, config: cfg };
  }

  if (!wtaLineups.length) {
    showAlert('lineup-alert', 'Could not build any lineups. ' + (warnings[0] || ''), 'danger');
    return;
  }

  renderWtaLineupsResult(warnings, CAP, wtaScoreMethod, wtaMinSal);
  g('lu-result').style.display = 'block';
  renderPool();
  const ec = g('lu-edge-card'); if (ec) ec.style.display = 'none';
}

function renderWtaLineupsResult(warnings, CAP, scoreMethod, minSal) {
  g('lu-result-title').textContent = `WTA lineups (${wtaLineups.length})`;
  const slotOrder = { 'SP':0,'C':1,'1B':2,'2B':3,'3B':4,'SS':5,'OF':6 };

  const cols = wtaLineups.map((lu, i) => {
    const sorted = [...lu.players].sort((a,b) =>
      (slotOrder[a._slot] ?? 9) - (slotOrder[b._slot] ?? 9));
    const totalSal = sorted.reduce((a,p) => a + p.sal, 0);
    const totalSp  = sorted.reduce((a,p) => a + p.sp, 0);
    const salColor = totalSal >= minSal ? 'var(--green)' : 'var(--red)';
    const stackLabel = lu.config._resolvedTeam
      ? `${lu.config.size}-man ${lu.config._resolvedTeam} (bat ${lu.config.start}+)` : 'No stack';

    const rows = sorted.map(p => {
      const isStack = lu.config._resolvedTeam && p.team === lu.config._resolvedTeam && !p.pos.includes('SP');
      return `<tr${isStack ? ' style="background:var(--gold-light,#fff8e1)"' : ''}>
        <td style="font-weight:600">${p._slot}</td>
        <td>${p.name}<span style="color:var(--gray-400);font-size:10px"> ${p.team}${p.batPos > 0 ? ' #' + p.batPos : ''}</span></td>
        <td style="text-align:right">$${(p.sal/1000).toFixed(1)}k</td>
        <td style="text-align:right">${p.sp.toFixed(1)}</td>
      </tr>`;
    }).join('');

    return `<div class="wta-lu-col">
      <div class="wta-lu-col-header">Lineup ${i + 1}<span>${stackLabel}</span></div>
      <table class="bd-table" style="font-size:12px">
        <thead><tr><th>Slot</th><th style="text-align:left">Player</th><th>Sal</th><th>SP</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr style="font-weight:600;border-top:2px solid var(--gray-200)">
          <td colspan="2">TOTAL</td>
          <td style="text-align:right;color:${salColor}">$${(totalSal/1000).toFixed(1)}k</td>
          <td style="text-align:right">${totalSp.toFixed(1)}</td>
        </tr></tfoot>
      </table>
    </div>`;
  }).join('');

  g('lu-lineup-table').innerHTML = `<div class="wta-lu-grid">${cols}</div>`;

  // - Exposure readout: every player appearing in more than one lineup -
  const expCount = {};
  wtaLineups.forEach(lu => lu.players.forEach(p => {
    expCount[p.name] = (expCount[p.name] || 0) + 1;
  }));
  const repeats = Object.entries(expCount)
    .filter(([, n]) => n > 1)
    .sort((a, b) => b[1] - a[1]);
  if (repeats.length) {
    const n = wtaLineups.length;
    const rows = repeats.map(([name, c]) =>
      `<tr><td>${name}</td><td style="text-align:right">${c} of ${n}</td><td style="text-align:right">${(c / n * 100).toFixed(0)}%</td></tr>`
    ).join('');
    g('lu-lineup-table').innerHTML += `
      <div class="card" style="margin-top:1rem">
        <div class="divider" style="margin-top:0">Exposure — players in more than one lineup</div>
        <table class="bd-table" style="font-size:13px">
          <thead><tr><th style="text-align:left">Player</th><th style="text-align:right">Lineups</th><th style="text-align:right">Exposure</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  const warnHTML = warnings.length
    ? warnings.map(w => `<div class="alert info" style="margin-bottom:6px"><i class="ti ti-alert-circle"></i>${w}</div>`).join('')
    : '<div style="font-size:12px;color:var(--gray-500)">All lineups built cleanly. No duplicated players across lineups.</div>';
  g('lu-warnings').innerHTML = warnHTML;

  const existingBtn = g('lu-export-btn');
  if (existingBtn) existingBtn.remove();
  const btn = document.createElement('button');
  btn.id = 'lu-export-btn';
  btn.className = 'btn primary';
  btn.style.marginTop = '1rem';
  btn.innerHTML = `<i class="ti ti-download"></i> Export ${wtaLineups.length} lineup${wtaLineups.length > 1 ? 's' : ''} (single CSV)`;
  btn.onclick = exportWtaLineups;
  g('lu-lineup-table').after(btn);
}

function exportWtaLineups() {
  if (!wtaLineups.length) return;
  const salMap = parseLuSalaries(luData.sal);
  const header = 'P,P,C,1B,2B,3B,SS,OF,OF,OF';
  const slotSeq = ['SP','SP','C','1B','2B','3B','SS','OF','OF','OF'];

  const lines = wtaLineups.map(lu => {
    // Order players to match slot sequence
    const bySlot = {};
    lu.players.forEach(p => {
      if (!bySlot[p._slot]) bySlot[p._slot] = [];
      bySlot[p._slot].push(p);
    });
    const ordered = [];
    const consumed = new Set();
    slotSeq.forEach(s => {
      const cand = (bySlot[s] || []).find(p => !consumed.has(p.name));
      if (cand) { ordered.push(cand); consumed.add(cand.name); }
    });
    return ordered.map(p => {
      const se = salMap[p.name];
      return se && se.id ? `${p.name} (${se.id})` : p.name;
    }).join(',');
  });

  const csv = header + '\n' + lines.join('\n') + '\n';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], {type:'text/csv'}));
  a.download = `DK_wta_lineups_${todayISO()}.csv`;
  a.click();

  showAlert('lineup-alert',
    'Downloaded. If DK rejects this on upload, download DK\'s own template from the contest\'s "Upload Lineups" screen and copy these rows into its columns.',
    'info', 12000);
}


// ============================================================================
// ROI TREND CHART (weekly, SVG, no dependencies)
// ============================================================================
function renderTrendChart(all) {
  const card = g('trend-card');
  if (!card) return;
  const dated = all.filter(e => e.date);
  if (dated.length < 5) { card.style.display = 'none'; return; }

  // Group by ISO week start (Monday) per class
  const weekKey = (dateStr) => {
    const d = new Date(dateStr + 'T12:00:00');
    if (isNaN(d)) return null;
    const day = (d.getDay() + 6) % 7; // Mon=0
    d.setDate(d.getDate() - day);
    return d.toISOString().split('T')[0];
  };

  const classes = ['Cash', 'GPP', 'WTA'];
  const buckets = {}; // week -> cls -> {inv, win}
  dated.forEach(e => {
    const wk = weekKey(e.date);
    if (!wk) return;
    if (!buckets[wk]) buckets[wk] = {};
    const cls = classes.includes(e.cls) ? e.cls : 'GPP';
    if (!buckets[wk][cls]) buckets[wk][cls] = { inv: 0, win: 0 };
    buckets[wk][cls].inv += e.invested || e.fee || 0;
    buckets[wk][cls].win += e.win || ((e.pl || 0) + (e.fee || 0));
  });

  const weeks = Object.keys(buckets).sort();
  if (weeks.length < 2) { card.style.display = 'none'; return; }

  const series = {};
  const CLIP = 150; // clip display at +/-150% so outlier weeks don't flatten the chart
  classes.forEach(cls => {
    series[cls] = weeks.map(wk => {
      const b = buckets[wk][cls];
      if (!b || b.inv === 0) return null;
      const roi = (b.win - b.inv) / b.inv * 100;
      return { roi, clipped: Math.max(-CLIP, Math.min(CLIP, roi)), inv: b.inv };
    });
  });

  // SVG layout
  const W = 700, H = 260, PAD = { l: 46, r: 12, t: 12, b: 30 };
  const plotW = W - PAD.l - PAD.r, plotH = H - PAD.t - PAD.b;
  // Y domain from clipped values
  let yMin = 0, yMax = 0;
  classes.forEach(cls => series[cls].forEach(pt => {
    if (!pt) return;
    yMin = Math.min(yMin, pt.clipped); yMax = Math.max(yMax, pt.clipped);
  }));
  yMin = Math.floor(yMin / 25) * 25 - 5; yMax = Math.ceil(yMax / 25) * 25 + 5;
  if (yMax - yMin < 30) { yMax += 15; yMin -= 15; }

  const x = i => PAD.l + (weeks.length === 1 ? plotW / 2 : i / (weeks.length - 1) * plotW);
  const y = v => PAD.t + (yMax - v) / (yMax - yMin) * plotH;

  const colors = { Cash: '#2563eb', GPP: '#16a34a', WTA: '#d97706' };

  let svg = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;font-family:inherit">`;
  // Gridlines + labels
  for (let v = Math.ceil(yMin / 25) * 25; v <= yMax; v += 25) {
    svg += `<line x1="${PAD.l}" y1="${y(v)}" x2="${W - PAD.r}" y2="${y(v)}" stroke="${v === 0 ? '#9ca3af' : '#e5e7eb'}" stroke-width="${v === 0 ? 1.5 : 1}"/>`;
    svg += `<text x="${PAD.l - 6}" y="${y(v) + 4}" text-anchor="end" font-size="10" fill="#6b7280">${v}%</text>`;
  }
  // X labels (every other week if crowded)
  const step = weeks.length > 10 ? 2 : 1;
  weeks.forEach((wk, i) => {
    if (i % step !== 0) return;
    const label = wk.slice(5); // MM-DD
    svg += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="#6b7280">${label}</text>`;
  });
  // Lines + points
  classes.forEach(cls => {
    const pts = series[cls];
    let path = '', started = false;
    pts.forEach((pt, i) => {
      if (!pt) { started = false; return; }
      path += (started ? ' L' : ' M') + x(i).toFixed(1) + ' ' + y(pt.clipped).toFixed(1);
      started = true;
    });
    if (path) svg += `<path d="${path}" fill="none" stroke="${colors[cls]}" stroke-width="2"/>`;
    pts.forEach((pt, i) => {
      if (!pt) return;
      const clippedMark = Math.abs(pt.roi) > CLIP ? ' (clipped)' : '';
      svg += `<circle cx="${x(i)}" cy="${y(pt.clipped)}" r="3.5" fill="${colors[cls]}">` +
        `<title>${cls} · wk of ${weeks[i]}: ${pt.roi.toFixed(1)}% ROI on $${pt.inv.toFixed(0)}${clippedMark}</title></circle>`;
    });
  });
  svg += '</svg>';

  g('trend-chart').innerHTML = svg;
  g('trend-legend').innerHTML = classes.map(cls =>
    `<span style="display:flex;align-items:center;gap:5px"><span style="width:10px;height:10px;border-radius:2px;background:${colors[cls]};display:inline-block"></span>${cls}</span>`
  ).join('') + '<span style="color:var(--gray-400)">Hover points for exact values. Extreme weeks clipped at ±150%.</span>';
  card.style.display = 'block';
}
