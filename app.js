// ── Storage ──────────────────────────────────────────────────────────────────
const STORE_KEY = 'mlb_dfs_slates';
const CHECK_KEY = 'mlb_dfs_checks';

let slates = [];
let pendingMatches = [];

function loadSlates() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); } catch { return []; }
}
function persistSlates() {
  localStorage.setItem(STORE_KEY, JSON.stringify(slates));
}

// ── Flag state ────────────────────────────────────────────────────────────────
const flags = {};

function setFlag(group, value, btn) {
  flags[group] = value;
  document.querySelectorAll(`.flag-btn[data-group="${group}"]`).forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
}

function clearFlags() {
  Object.keys(flags).forEach(k => delete flags[k]);
  document.querySelectorAll('.flag-btn').forEach(b => b.classList.remove('selected'));
}

function getFlag(group) { return flags[group] || null; }

function onSiteChange() {
  const site = gv('f-site');
  const dk = document.getElementById('fg-sp-dk');
  const fd = document.getElementById('fg-sp-fd');
  if (!dk || !fd) return;
  if (site === 'FD') { dk.style.display = 'none'; fd.style.display = 'block'; }
  else               { dk.style.display = 'block'; fd.style.display = 'none'; }
}

// ── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  slates = loadSlates();
  document.getElementById('f-date').value = todayISO();
  const siteEl = document.getElementById('f-site');
  if (siteEl) siteEl.addEventListener('change', onSiteChange);
  setupDrop();
  renderAll();
  renderChecklist();
});

function todayISO() {
  return new Date().toISOString().split('T')[0];
}

// ── Tab navigation ────────────────────────────────────────────────────────────
function showTab(name, el) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  el.classList.add('active');
  if (name === 'dashboard') renderDashboard();
  if (name === 'history')   renderHistory();
  if (name === 'results')   renderPendingSelect();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function g(id)  { return document.getElementById(id); }
function gv(id) { const e = g(id); return e ? e.value.trim() : ''; }

function showAlert(id, msg, type = 'success') {
  const el = g(id);
  if (!el) return;
  el.innerHTML = `<div class="alert ${type}"><i class="ti ti-${type === 'success' ? 'check' : type === 'danger' ? 'alert-circle' : 'info-circle'}"></i>${msg}</div>`;
  setTimeout(() => { el.innerHTML = ''; }, 5000);
}

// ── Log slate ─────────────────────────────────────────────────────────────────
function saveSlate() {
  if (!gv('f-date') || !gv('f-site') || !gv('f-contest')) {
    showAlert('log-alert', 'Please fill in Date, Site, and Contest name.', 'info');
    return;
  }
  const fee     = parseFloat(gv('f-fee')) || 0;
  const lineups = parseInt(gv('f-lineups')) || 1;
  const site    = gv('f-site');
  const spFlag  = site === 'FD' ? getFlag('sp-fd') : getFlag('sp-dk');
  const slate = {
    id:          Date.now(),
    date:        gv('f-date'),
    site,
    slateType:   gv('f-slate'),
    contest:     gv('f-contest'),
    ctype:       gv('f-ctype'),
    fee,
    lineups,
    field:       parseInt(gv('f-field'))  || null,
    maxEntries:  parseInt(gv('f-maxent')) || null,
    invested:    +(fee * lineups).toFixed(2),
    spOwnership: spFlag,
    stackOwn:    getFlag('stack-own'),
    stackSize:   getFlag('stack-size'),
    bringback:   getFlag('bringback'),
    projSource:  getFlag('proj'),
    projEdge:    getFlag('proj-edge'),
    wx:          getFlag('wx'),
    vegas:       parseFloat(gv('f-vegas')) || null,
    edgeNote:    gv('f-edge'),
    score: null, fieldAvg: null, finish: null,
    cashed: null, winnings: null, pl: null, hasResults: false,
  };
  slates.unshift(slate);
  persistSlates();
  showAlert('log-alert', 'Slate saved. Add results after the slate via Import or Manual results.');
  clearForm();
  renderAll();
}

function clearForm() {
  ['f-site','f-slate','f-contest','f-ctype','f-fee','f-lineups','f-field','f-maxent',
   'f-vegas','f-edge','f-maxent'].forEach(id => {
    const el = g(id); if (el) el.value = '';
  });
  g('f-date').value = todayISO();
  clearFlags();
  onSiteChange();
}

// ── CSV parsing ───────────────────────────────────────────────────────────────
function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = splitCSVRow(lines[0]).map(h => h.trim().replace(/^"|"$/g, '').toLowerCase());
  return lines.slice(1).filter(l => l.trim()).map(line => {
    const vals = splitCSVRow(line);
    const obj  = {};
    headers.forEach((h, i) => { obj[h] = (vals[i] || '').trim().replace(/^"|"$/g, ''); });
    return obj;
  });
}

function splitCSVRow(row) {
  const result = []; let cur = ''; let inQ = false;
  for (let i = 0; i < row.length; i++) {
    const c = row[i];
    if      (c === '"' && !inQ)                   { inQ = true; }
    else if (c === '"' && inQ && row[i+1] === '"') { cur += '"'; i++; }
    else if (c === '"' && inQ)                     { inQ = false; }
    else if (c === ',' && !inQ)                    { result.push(cur); cur = ''; }
    else                                            { cur += c; }
  }
  result.push(cur);
  return result;
}

function normalizeDK(rows) {
  return rows.map(r => ({
    contest: r['contest name'] || r['contest'] || r['tournament'] || '',
    pts:     parseFloat(r['points'] || r['fantasy points'] || r['pts'] || 0) || 0,
    rank:    parseInt(r['rank'] || r['finish'] || r['place'] || 0) || null,
    win:     parseFloat((r['winnings'] || r['prize'] || r['payout'] || '0').replace(/[$,]/g, '')) || 0,
    entries: parseInt(r['entries'] || r['total entries'] || r['field size'] || 0) || null,
  })).filter(r => r.contest);
}

function normalizeFD(rows) {
  return rows.map(r => ({
    contest: r['contest name'] || r['contest'] || r['tournament name'] || '',
    pts:     parseFloat(r['fantasy points'] || r['score'] || r['points'] || r['fpts'] || 0) || 0,
    rank:    parseInt(r['rank'] || r['place'] || r['finish'] || 0) || null,
    win:     parseFloat((r['winnings'] || r['prize amount'] || r['payout'] || '0').replace(/[$,]/g, '')) || 0,
    entries: parseInt(r['entries'] || r['total entries'] || r['field size'] || 0) || null,
  })).filter(r => r.contest);
}

function fuzzyMatch(a, b) {
  a = a.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
  b = b.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.9;
  const aW = new Set(a.split(' '));
  const bW = b.split(' ');
  const shared = bW.filter(w => w.length > 2 && aW.has(w)).length;
  return shared / Math.max(aW.size, bW.length);
}

function matchResults(csvRows, site) {
  const pending = slates.filter(s => !s.hasResults && s.site === site);
  return csvRows.map(csvRow => {
    let best = null, bestScore = 0;
    pending.forEach(slate => {
      const score = fuzzyMatch(csvRow.contest, slate.contest);
      if (score > bestScore) { bestScore = score; best = slate; }
    });
    return { csvRow, slate: bestScore >= 0.5 ? best : null, matchScore: bestScore };
  });
}

// ── Import flow ───────────────────────────────────────────────────────────────
function setupDrop() {
  const dz = g('drop-zone');
  if (!dz) return;
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag-over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
  dz.addEventListener('drop', e => {
    e.preventDefault(); dz.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  });
}

function handleFile(file) {
  if (!file || !file.name.endsWith('.csv')) {
    showAlert('import-alert', 'Please upload a .csv file.', 'danger'); return;
  }
  const reader = new FileReader();
  reader.onload = e => {
    const text = e.target.result;
    const rows = parseCSV(text);
    if (!rows.length) { showAlert('import-alert', 'Could not parse CSV — check the file format.', 'danger'); return; }
    const site = gv('import-site') || 'DK';
    const norm = site === 'FD' ? normalizeFD(rows) : normalizeDK(rows);
    if (!norm.length) { showAlert('import-alert', 'No valid contest rows found in CSV.', 'danger'); return; }
    pendingMatches = matchResults(norm, site);
    renderMatchStep(site);
  };
  reader.readAsText(file);
}

function renderMatchStep(site) {
  g('import-step1').style.display = 'none';
  g('import-step2').style.display = 'block';
  const matched   = pendingMatches.filter(m => m.slate).length;
  const unmatched = pendingMatches.length - matched;
  const pending   = slates.filter(s => !s.hasResults && s.site === site);

  g('import-summary').innerHTML = `
    <h3>Import preview — ${site}</h3>
    <div class="summary-row"><span>Rows in CSV</span><strong>${pendingMatches.length}</strong></div>
    <div class="summary-row"><span>Auto-matched to logged slates</span><strong class="pos">${matched}</strong></div>
    <div class="summary-row"><span>Unmatched (needs manual match or skip)</span><strong class="${unmatched ? 'neg' : ''}">${unmatched}</strong></div>`;

  const pendingOpts = pending.map(s =>
    `<option value="${s.id}">${s.date} · ${s.contest.substring(0, 40)}</option>`).join('');

  g('match-list').innerHTML = pendingMatches.map((m, i) => {
    const csv  = m.csvRow;
    const info = `${csv.pts.toFixed(1)} pts · Rank ${csv.rank || '?'} · $${csv.win.toFixed(2)}`;
    if (m.slate) {
      return `<div class="match-row">
        <div>
          <div class="match-label">From CSV</div>
          <div class="match-name" title="${csv.contest}">${csv.contest}</div>
          <div class="match-meta">${info}</div>
        </div>
        <div class="match-arrow"><i class="ti ti-arrow-right"></i></div>
        <div>
          <div class="match-label">Matched slate</div>
          <div class="match-name" title="${m.slate.contest}">${m.slate.contest}</div>
          <div class="match-meta">${m.slate.date} · ${Math.round(m.matchScore * 100)}% confidence</div>
        </div>
        <div class="match-ok"><i class="ti ti-circle-check"></i></div>
      </div>`;
    }
    return `<div class="match-row unmatched">
      <div>
        <div class="match-label">From CSV — no match found</div>
        <div class="match-name" title="${csv.contest}">${csv.contest}</div>
        <div class="match-meta">${info}</div>
      </div>
      <div class="match-arrow"><i class="ti ti-arrow-right"></i></div>
      <div class="manual-match">
        <div class="match-label">Match manually or skip</div>
        <select onchange="setManualMatch(${i}, this.value)">
          <option value="">— skip this row —</option>
          ${pendingOpts}
        </select>
      </div>
    </div>`;
  }).join('');
}

function setManualMatch(i, slateId) {
  if (!slateId) { pendingMatches[i].slate = null; return; }
  const s = slates.find(x => x.id === parseInt(slateId));
  if (s) { pendingMatches[i].slate = s; pendingMatches[i].matchScore = 1; }
}

function confirmImport() {
  let applied = 0;
  pendingMatches.forEach(m => {
    if (!m.slate) return;
    const csv = m.csvRow;
    m.slate.score    = csv.pts    || null;
    m.slate.finish   = csv.rank   || null;
    m.slate.winnings = csv.win;
    m.slate.cashed   = csv.win > 0 ? 'Y' : 'N';
    m.slate.pl       = +(csv.win - m.slate.invested).toFixed(2);
    m.slate.hasResults = true;
    if (csv.entries) m.slate.field = csv.entries;
    applied++;
  });
  persistSlates();
  renderAll();
  showAlert('import-alert', `Done — ${applied} slate${applied !== 1 ? 's' : ''} updated with results.`);
  resetImport();
}

function resetImport() {
  pendingMatches = [];
  g('import-step1').style.display = 'block';
  g('import-step2').style.display = 'none';
  g('csv-file').value = '';
}

// ── Manual results ────────────────────────────────────────────────────────────
function renderPendingSelect() {
  const sel     = g('pendingSelect');
  const pending = slates.filter(s => !s.hasResults);
  sel.innerHTML = '<option value="">— choose slate —</option>' +
    pending.map(s => `<option value="${s.id}">${s.date} · ${s.site} · ${s.contest}</option>`).join('');
  g('res-form').style.display = 'none';
}

function loadPending() {
  const id = parseInt(gv('pendingSelect'));
  if (!id) return;
  const s = slates.find(x => x.id === id);
  if (!s) return;
  g('res-summary').innerHTML =
    `<strong>${s.contest}</strong> &nbsp;·&nbsp; ${s.site} ${s.slateType || ''} &nbsp;·&nbsp; ${s.date} &nbsp;·&nbsp; Invested: <strong>$${s.invested.toFixed(2)}</strong>`;
  ['r-score','r-avg','r-finish','r-cash','r-win'].forEach(id => { const e = g(id); if (e) e.value = ''; });
  g('res-form').style.display = 'block';
}

function saveResults() {
  const id = parseInt(gv('pendingSelect'));
  const s  = slates.find(x => x.id === id);
  if (!s) return;
  const win = parseFloat(gv('r-win')) || 0;
  s.score      = parseFloat(gv('r-score'))  || null;
  s.fieldAvg   = parseFloat(gv('r-avg'))    || null;
  s.finish     = parseInt(gv('r-finish'))   || null;
  s.cashed     = gv('r-cash')               || null;
  s.winnings   = win;
  s.pl         = +(win - s.invested).toFixed(2);
  s.hasResults = true;
  persistSlates();
  showAlert('res-alert', 'Results saved!');
  renderPendingSelect();
  g('res-form').style.display = 'none';
  renderAll();
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
function renderDashboard() {
  const complete  = slates.filter(s => s.hasResults);
  const invested  = slates.reduce((a, s) => a + s.invested, 0);
  const winnings  = complete.reduce((a, s) => a + (s.winnings || 0), 0);
  const pl        = +(winnings - invested).toFixed(2);
  const roi       = invested > 0 ? pl / invested : 0;
  const cashSlates = complete.filter(s => s.ctype && s.ctype.startsWith('Cash'));
  const cashWins  = cashSlates.filter(s => s.cashed === 'Y').length;
  const cashRate  = cashSlates.length > 0 ? cashWins / cashSlates.length : null;

  g('kpi-grid').innerHTML = [
    ['Total slates',   slates.length,              '',     ''],
    ['Total invested', '$' + invested.toFixed(2),  '',     ''],
    ['Total winnings', '$' + winnings.toFixed(2),  '',     ''],
    ['Net P/L',        (pl >= 0 ? '+' : '') + '$' + Math.abs(pl).toFixed(2), pl >= 0 ? 'pos' : 'neg', ''],
    ['Overall ROI',    (roi * 100).toFixed(1) + '%', roi >= 0 ? 'pos' : 'neg', ''],
    ['Cash win rate',  cashRate !== null ? (cashRate * 100).toFixed(0) + '%' : '—',
                       cashRate !== null ? (cashRate >= 0.52 ? 'pos' : 'neg') : '',
                       cashRate !== null ? 'target ≥52%' : 'no cash slates yet'],
  ].map(([label, value, cls, sub]) =>
    `<div class="kpi">
      <div class="kpi-label">${label}</div>
      <div class="kpi-value ${cls}">${value}</div>
      ${sub ? `<div class="kpi-sub">${sub}</div>` : ''}
    </div>`).join('');

  // By contest type
  const byType = {};
  slates.forEach(s => {
    const t = s.ctype || 'Unknown';
    if (!byType[t]) byType[t] = { entries: 0, invested: 0, pl: 0 };
    byType[t].entries++;
    byType[t].invested += s.invested;
    if (s.hasResults) byType[t].pl += s.pl || 0;
  });

  // By site
  const bySite = {};
  slates.forEach(s => {
    const k = s.site || 'Unknown';
    if (!bySite[k]) bySite[k] = { entries: 0, invested: 0, pl: 0 };
    bySite[k].entries++;
    bySite[k].invested += s.invested;
    if (s.hasResults) bySite[k].pl += s.pl || 0;
  });

  const typeRows = Object.entries(byType).map(([t, d]) =>
    `<div class="row-item">
      <span>${t}</span>
      <span class="row-meta">
        <span style="color:var(--gray-500)">${d.entries} entries</span>
        <span class="${d.pl >= 0 ? 'pos' : 'neg'}">${d.pl >= 0 ? '+' : ''}$${d.pl.toFixed(2)}</span>
      </span>
    </div>`).join('') || '<p style="font-size:13px;color:var(--gray-400)">No data yet</p>';

  const siteRows = Object.entries(bySite).filter(([, d]) => d.entries > 0).map(([k, d]) =>
    `<div class="row-item">
      <span class="badge ${k.toLowerCase()}">${k}</span>
      <span class="row-meta">
        <span style="color:var(--gray-500)">${d.entries} entries</span>
        <span class="${d.pl >= 0 ? 'pos' : 'neg'}">${d.pl >= 0 ? '+' : ''}$${d.pl.toFixed(2)}</span>
      </span>
    </div>`).join('') || '<p style="font-size:13px;color:var(--gray-400)">No data yet</p>';

  g('breakdown-grid').innerHTML = `
    <div class="breakdown-card"><h3>By contest type</h3>${typeRows}</div>
    <div class="breakdown-card">
      <h3>By site</h3>${siteRows}
      ${cashRate !== null
        ? `<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--gray-100);font-size:12px;color:var(--gray-500)">
             Cash win rate: <strong class="${cashRate >= 0.52 ? 'pos' : 'neg'}">${(cashRate * 100).toFixed(0)}%</strong>
             <span style="color:var(--gray-400)"> (target ≥52%)</span>
           </div>`
        : ''}
    </div>`;
}

// ── History ───────────────────────────────────────────────────────────────────
function renderHistory() {
  const sf   = gv('hist-site');
  const tf   = gv('hist-type');
  let   data = [...slates];
  if (sf) data = data.filter(s => s.site  === sf);
  if (tf) data = data.filter(s => s.ctype === tf);

  if (!data.length) {
    g('hist-table').innerHTML =
      '<div class="empty"><i class="ti ti-database-off"></i>No slates logged yet</div>';
    return;
  }

  const rows = data.map(s => `<tr>
    <td>${s.date}</td>
    <td><span class="badge ${(s.site || '').toLowerCase()}">${s.site || '—'}</span></td>
    <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis" title="${s.contest}">${s.contest}</td>
    <td><span class="badge ${s.ctype && s.ctype.startsWith('Cash') ? 'cash' : 'gpp'}">${s.ctype || '—'}</span></td>
    <td>$${s.invested.toFixed(2)}</td>
    <td>${s.spOwnership || '—'}</td>
    <td>${[s.stackOwn, s.stackSize].filter(Boolean).join(' ') || '—'}</td>
    <td>${s.hasResults ? (s.score != null ? s.score.toFixed(1) : '—') : '<span style="color:var(--gray-400);font-size:11px">pending</span>'}</td>
    <td>${s.hasResults ? (s.cashed || '—') : '—'}</td>
    <td>${s.hasResults
      ? `<span class="${(s.pl || 0) >= 0 ? 'pos' : 'neg'}">${(s.pl || 0) >= 0 ? '+' : ''}$${Math.abs(s.pl || 0).toFixed(2)}</span>`
      : '—'}</td>
    <td>
      <button class="btn danger" style="padding:4px 8px;font-size:11px" onclick="deleteSlate(${s.id})" title="Delete">
        <i class="ti ti-trash"></i>
      </button>
    </td>
  </tr>`).join('');

  g('hist-table').innerHTML = `<table>
    <thead><tr>
      <th>Date</th><th>Site</th><th>Contest</th><th>Type</th><th>Invested</th>
      <th>SP own</th><th>Stack</th><th>Score</th><th>Cash</th><th>P/L</th><th></th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function deleteSlate(id) {
  if (!confirm('Delete this slate entry?')) return;
  slates = slates.filter(s => s.id !== id);
  persistSlates();
  renderAll();
  renderPendingSelect();
}

// ── Export CSV ────────────────────────────────────────────────────────────────
function exportCSV() {
  const headers = ['Date','Site','Slate Type','Contest','Contest Type','Fee','Lineups','Invested',
    'SP Ownership','Stack Own','Stack Size','Bring-Back','Proj Source','Proj Edge','Weather',
    'Vegas Total','Edge Note','Score','Field Avg','Finish','Cashed','Winnings','P/L'];
  const rows = slates.map(s => [
    s.date,s.site,s.slateType,s.contest,s.ctype,s.fee,s.lineups,s.invested,
    s.spOwnership,s.stackOwn,s.stackSize,s.bringback,s.projSource,s.projEdge,s.wx,
    s.vegas,s.edgeNote,s.score,s.fieldAvg,s.finish,s.cashed,s.winnings,s.pl,
  ].map(v => v == null ? '' : `"${String(v).replace(/"/g, '""')}"`));
  const csv  = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `mlb_dfs_tracker_${todayISO()}.csv`;
  a.click();
}

// ── Checklist ─────────────────────────────────────────────────────────────────
const CHECKLIST = [
  'Pull SplashPlay pitcher + batter projections for slate',
  'Open Stokastic — check projected ownership + top stacks tool',
  'Compare SP projection between SplashPlay and Stokastic — flag divergences >1.5 pts',
  'Check Vegas totals and over/under for all games on slate',
  'Check wind speed and direction for outdoor parks (flag >8 mph out)',
  'Identify primary stack: top-4 implied total team with Stokastic stack edge score',
  'Identify secondary stack: mid-tier implied total, low proj ownership (<12%)',
  'Pick bring-back hitter from opposing team vs your SP',
  'Check late lineup news and scratches within 30 min of lock',
  'Confirm contest type — cash lineup ≠ GPP lineup, never enter same lineup in both',
  'Note projected ownership of SP and primary stack before lock',
  'Log everything in the app immediately after lineup lock',
];

function renderChecklist() {
  let checked = {};
  try { checked = JSON.parse(localStorage.getItem(CHECK_KEY) || '{}'); } catch {}
  g('checklist').innerHTML = CHECKLIST.map((item, i) =>
    `<li class="${checked[i] ? 'done' : ''}" onclick="toggleCheck(${i})">
      <div class="check-box">${checked[i] ? '<i class="ti ti-check"></i>' : ''}</div>
      <span class="step-num">${String(i + 1).padStart(2, '0')}</span>
      <span>${item}</span>
    </li>`).join('');
}

function toggleCheck(i) {
  let checked = {};
  try { checked = JSON.parse(localStorage.getItem(CHECK_KEY) || '{}'); } catch {}
  checked[i] = !checked[i];
  localStorage.setItem(CHECK_KEY, JSON.stringify(checked));
  renderChecklist();
}

function resetChecklist() {
  localStorage.removeItem(CHECK_KEY);
  renderChecklist();
}

function renderAll() { renderDashboard(); renderHistory(); }
