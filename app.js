// ── Storage ───────────────────────────────────────────────────────────────────
const STORE_KEY = 'mlb_dfs_slates';
const CHECK_KEY = 'mlb_dfs_checks';

let slates = [];
let pendingMatches = [];
let lastSaved = null; // for carry-forward

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
function getFlag(g) { return flags[g] || null; }

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  slates = loadSlates();
  g('f-date').value = todayISO();
  setupDrop();
  renderAll();
  renderChecklist();
});

function todayISO() { return new Date().toISOString().split('T')[0]; }

// ── Site toggle (pitcher flags) ───────────────────────────────────────────────
function onSiteChange() {
  const site = gv('f-site');
  const dk = g('fg-sp-dk'), fd = g('fg-sp-fd');
  if (!dk || !fd) return;
  // clear any sp flag since options changed
  delete flags['sp'];
  document.querySelectorAll('.flag-btn[data-group="sp"]').forEach(b => b.classList.remove('selected'));
  if (site === 'FD') { dk.style.display = 'none'; fd.style.display = 'block'; }
  else               { dk.style.display = 'block'; fd.style.display = 'none'; }
}

// ── Carry-forward ─────────────────────────────────────────────────────────────
function showCarryBar(s) {
  const bar = g('carry-bar');
  g('carry-label').textContent = `Last saved: ${s.contest} · ${s.site} · ${s.date}`;
  bar.style.display = 'flex';
}
function applyCarry() {
  if (!lastSaved) return;
  const s = lastSaved;
  g('f-date').value    = s.date    || todayISO();
  g('f-site').value    = s.site    || '';
  g('f-slate').value   = s.slateType || '';
  g('f-contest').value = s.contest || '';
  g('f-ctype').value   = s.ctype   || '';
  g('f-fee').value     = s.fee     || '';
  g('f-maxent').value  = s.maxEntries || '';
  onSiteChange();
  g('carry-bar').style.display = 'none';
}
function dismissCarry() { g('carry-bar').style.display = 'none'; }

// ── Tab navigation ────────────────────────────────────────────────────────────
function showTab(name, el) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  g('tab-' + name).classList.add('active');
  el.classList.add('active');
  if (name === 'dashboard') renderDashboard();
  if (name === 'history')   renderHistory();
  if (name === 'results')   renderPendingSelect();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function g(id)  { return document.getElementById(id); }
function gv(id) { const e = g(id); return e ? e.value.trim() : ''; }

function showAlert(id, msg, type = 'success') {
  const el = g(id); if (!el) return;
  const icon = type === 'success' ? 'check' : type === 'danger' ? 'alert-circle' : 'info-circle';
  el.innerHTML = `<div class="alert ${type}"><i class="ti ti-${icon}"></i>${msg}</div>`;
  setTimeout(() => { el.innerHTML = ''; }, 5000);
}

function roiStr(invested, pl) {
  if (!invested) return '—';
  return ((pl / invested) * 100).toFixed(1) + '%';
}

// ── Save lineup ───────────────────────────────────────────────────────────────
function saveLineup() {
  if (!gv('f-date') || !gv('f-site') || !gv('f-contest')) {
    showAlert('log-alert', 'Date, Site, and Contest name are required.', 'info');
    return;
  }
  const fee  = parseFloat(gv('f-fee')) || 0;
  const site = gv('f-site');
  const lineup = {
    id:          Date.now(),
    date:        gv('f-date'),
    site,
    slateType:   gv('f-slate'),
    contest:     gv('f-contest'),
    ctype:       gv('f-ctype'),
    fee,
    invested:    fee,           // 1 lineup = 1 entry fee
    maxEntries:  parseInt(gv('f-maxent')) || null,
    sp:          getFlag('sp'),
    stackOwn:    getFlag('stackOwn'),
    stackSize:   getFlag('stackSize'),
    bringback:   getFlag('bringback'),
    proj:        getFlag('proj'),
    note:        gv('f-note'),
    // results (filled later)
    score: null, finish: null, field: null,
    cashed: null, winnings: null, pl: null, hasResults: false,
  };
  slates.unshift(lineup);
  persistSlates();
  lastSaved = lineup;
  showAlert('log-alert', 'Lineup saved. Log the next one or add results after the slate.');
  clearForm();
  showCarryBar(lineup);
  renderAll();
}

function clearForm() {
  ['f-slate','f-contest','f-ctype','f-fee','f-maxent','f-note'].forEach(id => {
    const el = g(id); if (el) el.value = '';
  });
  // keep date & site, clear construction flags only
  delete flags['sp']; delete flags['stackOwn']; delete flags['stackSize'];
  delete flags['bringback']; delete flags['proj'];
  document.querySelectorAll('.flag-btn').forEach(b => b.classList.remove('selected'));
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

// Strip DK multi-entry suffix: "MLB $2.5K Solo Shot (3/5)" → "MLB $2.5K Solo Shot"
function stripDKSuffix(name) {
  return name.replace(/\s*\(\d+\/\d+\)\s*$/, '').trim();
}

// Parse DK date: "6/1/2026 19:10" → "2026-06-01"
function parseDKDate(str) {
  const m = str.match(/^(\d+)\/(\d+)\/(\d+)/);
  if (!m) return null;
  const [, mo, d, y] = m;
  return `${y}-${mo.padStart(2,'0')}-${d.padStart(2,'0')}`;
}

// Parse FD date: "6/1/2026" → "2026-06-01"
function parseFDDate(str) {
  const m = str.match(/^(\d+)\/(\d+)\/(\d+)/);
  if (!m) return null;
  const [, mo, d, y] = m;
  return `${y}-${mo.padStart(2,'0')}-${d.padStart(2,'0')}`;
}

function detectSite(headers) {
  const h = headers.join(',');
  if (h.includes('entry_key') || h.includes('contest_key') || h.includes('winnings_non_ticket')) return 'DK';
  if (h.includes('entry id') || h.includes('salary cap') || h.includes('salarycap'))             return 'FD';
  return null;
}

function normalizeDK(rows) {
  return rows
    .filter(r => (r['sport'] || '').toUpperCase() === 'MLB')
    .map(r => {
      const rawContest = r['entry'] || '';
      const contest    = stripDKSuffix(rawContest);
      const pts        = parseFloat(r['points']) || 0;
      const rank       = parseInt(r['place']) || null;
      const winCash    = parseMoney(r['winnings_non_ticket']);
      const winTicket  = parseMoney(r['winnings_ticket']);
      const win        = +(winCash + winTicket).toFixed(2);
      const placesPaid = parseInt(r['places_paid']) || 0;
      const entries    = parseInt(r['contest_entries']) || null;
      const fee        = parseMoney(r['entry_fee']);
      const date       = parseDKDate(r['contest_date_est'] || '');
      const cashed     = placesPaid > 0 && rank !== null ? (rank <= placesPaid ? 'Y' : 'N') : (win > 0 ? 'Y' : 'N');
      return { contest, pts, rank, win, entries, fee, date, cashed, raw: rawContest };
    })
    .filter(r => r.contest);
}

function normalizeFD(rows) {
  return rows
    .filter(r => (r['sport'] || '').toLowerCase() === 'mlb')
    .map(r => {
      const contest = (r['title'] || '').trim();
      const pts     = parseFloat(r['score']) || 0;
      const rank    = parseInt(r['position']) || null;
      const win     = parseMoney(r['winnings ($)']);
      const entries = parseInt(r['entries']) || null;
      const fee     = parseMoney(r['entry ($)']);
      const date    = parseFDDate(r['date'] || '');
      const cashed  = win > 0 ? 'Y' : 'N';
      return { contest, pts, rank, win, entries, fee, date, cashed };
    })
    .filter(r => r.contest);
}

// ── Fuzzy match ───────────────────────────────────────────────────────────────
function normalize(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
}

function fuzzyScore(a, b) {
  a = normalize(a); b = normalize(b);
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.9;
  const aW = new Set(a.split(' ').filter(w => w.length > 2));
  const bW = b.split(' ').filter(w => w.length > 2);
  const shared = bW.filter(w => aW.has(w)).length;
  return shared / Math.max(aW.size, bW.length, 1);
}

// Match each CSV row to a pending logged lineup.
// Match criteria: contest name fuzzy + same date (if date available) + same fee (if available)
function matchResults(csvRows, site) {
  const pending = slates.filter(s => !s.hasResults && s.site === site);
  return csvRows.map(csvRow => {
    let best = null, bestScore = 0;
    pending.forEach(lineup => {
      let score = fuzzyScore(csvRow.contest, lineup.contest);
      // Boost for same date
      if (csvRow.date && lineup.date && csvRow.date === lineup.date) score += 0.15;
      // Boost for same fee
      if (csvRow.fee && lineup.fee && Math.abs(csvRow.fee - lineup.fee) < 0.01) score += 0.1;
      if (score > bestScore) { bestScore = score; best = lineup; }
    });
    return { csvRow, lineup: bestScore >= 0.5 ? best : null, matchScore: bestScore, manualId: null };
  });
}

// ── Import flow ───────────────────────────────────────────────────────────────
function setupDrop() {
  const dz = g('drop-zone'); if (!dz) return;
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag-over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
  dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('drag-over'); handleFile(e.dataTransfer.files[0]); });
}

function handleFile(file) {
  if (!file || !file.name.endsWith('.csv')) { showAlert('import-alert', 'Please upload a .csv file.', 'danger'); return; }
  const reader = new FileReader();
  reader.onload = e => {
    const rows = parseCSV(e.target.result);
    if (!rows.length) { showAlert('import-alert', 'Could not parse CSV.', 'danger'); return; }
    const headers = Object.keys(rows[0]);
    const site = detectSite(headers);
    if (!site) { showAlert('import-alert', 'Could not detect site — make sure this is a DK or FD export.', 'danger'); return; }
    const norm = site === 'FD' ? normalizeFD(rows) : normalizeDK(rows);
    if (!norm.length) { showAlert('import-alert', `No MLB rows found. Check this is a ${site} MLB export.`, 'danger'); return; }
    pendingMatches = matchResults(norm, site);
    renderMatchStep(site);
  };
  reader.readAsText(file);
}

function renderMatchStep(site) {
  g('import-step1').style.display = 'none';
  g('import-step2').style.display = 'block';
  const matched   = pendingMatches.filter(m => m.lineup).length;
  const unmatched = pendingMatches.length - matched;
  const pending   = slates.filter(s => !s.hasResults && s.site === site);

  g('import-summary').innerHTML = `
    <h3>Import preview — ${site} (${pendingMatches.length} lineup rows)</h3>
    <div class="summary-row"><span>Auto-matched</span><strong class="pos">${matched}</strong></div>
    <div class="summary-row"><span>Unmatched (manual assign or skip)</span><strong class="${unmatched ? 'neg' : ''}">${unmatched}</strong></div>
    <div class="summary-row"><span>Pending logged lineups for ${site}</span><strong>${pending.length}</strong></div>`;

  const pendingOpts = pending.map(s =>
    `<option value="${s.id}">${s.date} · ${s.contest.substring(0,36)} · $${s.fee}</option>`).join('');

  g('match-list').innerHTML = pendingMatches.map((m, i) => {
    const c = m.csvRow;
    const info = `${c.pts.toFixed(1)} pts · Rank ${c.rank || '?'} · $${c.win.toFixed(2)} · ${c.date || '?'}`;
    if (m.lineup) {
      return `<div class="match-row">
        <div><div class="match-label">CSV row</div>
          <div class="match-name" title="${c.contest}">${c.contest}</div>
          <div class="match-meta">${info}</div></div>
        <div class="match-arrow"><i class="ti ti-arrow-right"></i></div>
        <div><div class="match-label">Matched lineup</div>
          <div class="match-name" title="${m.lineup.contest}">${m.lineup.contest}</div>
          <div class="match-meta">${m.lineup.date} · ${Math.round(m.matchScore * 100)}% confidence</div></div>
        <div class="match-ok"><i class="ti ti-circle-check"></i></div>
      </div>`;
    }
    return `<div class="match-row unmatched">
      <div><div class="match-label">CSV row — no match found</div>
        <div class="match-name" title="${c.contest}">${c.contest}</div>
        <div class="match-meta">${info}</div></div>
      <div class="match-arrow"><i class="ti ti-arrow-right"></i></div>
      <div class="manual-match" style="grid-column:span 2">
        <div class="match-label">Assign manually or skip</div>
        <select onchange="setManualMatch(${i},this.value)">
          <option value="">— skip —</option>${pendingOpts}
        </select>
      </div>
    </div>`;
  }).join('');
}

function setManualMatch(i, id) {
  if (!id) { pendingMatches[i].lineup = null; return; }
  const s = slates.find(x => x.id === parseInt(id));
  if (s) { pendingMatches[i].lineup = s; pendingMatches[i].matchScore = 1; }
}

function confirmImport() {
  let applied = 0;
  pendingMatches.forEach(m => {
    const target = m.lineup;
    if (!target) return;
    const c = m.csvRow;
    target.score      = c.pts  || null;
    target.finish     = c.rank || null;
    target.winnings   = c.win;
    target.cashed     = c.cashed;
    target.pl         = +(c.win - target.invested).toFixed(2);
    target.hasResults = true;
    if (c.entries) target.field = c.entries;
    applied++;
  });
  persistSlates();
  renderAll();
  showAlert('import-alert', `Done — ${applied} lineup${applied !== 1 ? 's' : ''} updated.`);
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
  const sel = g('pendingSelect');
  const pending = slates.filter(s => !s.hasResults);
  sel.innerHTML = '<option value="">— choose lineup —</option>' +
    pending.map(s => `<option value="${s.id}">${s.date} · ${s.site} · ${s.contest} · $${s.fee}</option>`).join('');
  g('res-form').style.display = 'none';
}

function loadPending() {
  const id = parseInt(gv('pendingSelect')); if (!id) return;
  const s = slates.find(x => x.id === id); if (!s) return;
  g('res-summary').innerHTML =
    `<strong>${s.contest}</strong> &nbsp;·&nbsp; ${s.site} &nbsp;·&nbsp; ${s.date} &nbsp;·&nbsp; Fee: <strong>$${s.fee}</strong>`;
  ['r-score','r-finish','r-win','r-cash','r-field'].forEach(id => { const e = g(id); if (e) e.value = ''; });
  g('res-form').style.display = 'block';
}

function saveResults() {
  const id = parseInt(gv('pendingSelect'));
  const s = slates.find(x => x.id === id); if (!s) return;
  const win = parseFloat(gv('r-win')) || 0;
  s.score      = parseFloat(gv('r-score'))  || null;
  s.finish     = parseInt(gv('r-finish'))   || null;
  s.field      = parseInt(gv('r-field'))    || s.field || null;
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
  const complete = slates.filter(s => s.hasResults);
  const invested = slates.reduce((a, s) => a + (s.invested || 0), 0);
  const winnings = complete.reduce((a, s) => a + (s.winnings || 0), 0);
  const pl       = +(winnings - invested).toFixed(2);
  const roi      = invested > 0 ? pl / invested : 0;
  const cashS    = complete.filter(s => s.ctype && s.ctype.startsWith('Cash'));
  const cashWins = cashS.filter(s => s.cashed === 'Y').length;
  const cashRate = cashS.length > 0 ? cashWins / cashS.length : null;

  g('kpi-grid').innerHTML = [
    ['Lineups logged', slates.length, '', ''],
    ['Total invested', '$' + invested.toFixed(2), '', ''],
    ['Total winnings', '$' + winnings.toFixed(2), '', ''],
    ['Net P/L', (pl >= 0 ? '+' : '') + '$' + Math.abs(pl).toFixed(2), pl >= 0 ? 'pos' : 'neg', ''],
    ['Overall ROI', (roi * 100).toFixed(1) + '%', roi >= 0 ? 'pos' : 'neg', ''],
    ['Cash win rate', cashRate !== null ? (cashRate * 100).toFixed(0) + '%' : '—',
      cashRate !== null ? (cashRate >= 0.52 ? 'pos' : 'neg') : '',
      cashRate !== null ? 'target ≥52%' : 'no cash lineups yet'],
  ].map(([label, value, cls, sub]) =>
    `<div class="kpi"><div class="kpi-label">${label}</div>
     <div class="kpi-value ${cls}">${value}</div>
     ${sub ? `<div class="kpi-sub">${sub}</div>` : ''}</div>`).join('');

  // ── Construction & source breakdown tables ────────────────────────────────
  const breakdowns = [
    {
      title: 'Pitcher ownership',
      key: 'sp',
      order: ['low-low','low-high','high-high','low','high'],
      labels: { 'low-low':'Low/Low (DK)', 'low-high':'Low/High (DK)', 'high-high':'High/High (DK)', 'low':'Low (FD)', 'high':'High (FD)' },
    },
    {
      title: 'Stack ownership',
      key: 'stackOwn',
      order: ['low','high'],
      labels: { 'low':'Low owned', 'high':'High owned' },
    },
    {
      title: 'Stack size',
      key: 'stackSize',
      order: ['3man','4man','5man'],
      labels: { '3man':'3-man', '4man':'4-man', '5man':'5-man' },
    },
    {
      title: 'Bring-back',
      key: 'bringback',
      order: ['yes','no'],
      labels: { 'yes':'Yes', 'no':'No' },
    },
    {
      title: 'Projection source',
      key: 'proj',
      order: ['SplashPlay','Stokastic'],
      labels: { 'SplashPlay':'SplashPlay', 'Stokastic':'Stokastic' },
    },
    {
      title: 'By site',
      key: 'site',
      order: ['DK','FD'],
      labels: { 'DK':'DK', 'FD':'FD' },
    },
    {
      title: 'By contest type',
      key: 'ctype',
      order: null, // dynamic
      labels: {},
    },
  ];

  function bucketsFor(bk) {
    const map = {};
    slates.forEach(s => {
      const val = s[bk.key] || 'Unknown';
      if (!map[val]) map[val] = { n: 0, invested: 0, winnings: 0, cashes: 0, cashTotal: 0 };
      map[val].n++;
      map[val].invested += s.invested || 0;
      if (s.hasResults) {
        map[val].winnings += s.winnings || 0;
        if (s.ctype && s.ctype.startsWith('Cash')) {
          map[val].cashTotal++;
          if (s.cashed === 'Y') map[val].cashes++;
        }
      }
    });
    return map;
  }

  function renderBreakdownCard(bk) {
    const map = bucketsFor(bk);
    const keys = bk.order
      ? bk.order.filter(k => map[k])
      : Object.keys(map).sort();
    if (!keys.length) return '';
    const rows = keys.map(k => {
      const d   = map[k];
      const pl  = +(d.winnings - d.invested).toFixed(2);
      const roi = d.invested > 0 ? (pl / d.invested * 100).toFixed(1) + '%' : '—';
      const cashRateStr = d.cashTotal > 0
        ? `${Math.round(d.cashes / d.cashTotal * 100)}%`
        : '—';
      const label = bk.labels[k] || k;
      return `<tr>
        <td>${label}</td>
        <td style="text-align:right;color:var(--gray-500)">${d.n}</td>
        <td style="text-align:right;color:var(--gray-500)">$${d.invested.toFixed(2)}</td>
        <td style="text-align:right" class="${pl >= 0 ? 'pos' : 'neg'}">${pl >= 0 ? '+' : ''}$${Math.abs(pl).toFixed(2)}</td>
        <td style="text-align:right" class="${pl >= 0 ? 'pos' : 'neg'}">${roi}</td>
        <td style="text-align:right;color:var(--gray-500)">${cashRateStr}</td>
      </tr>`;
    }).join('');
    return `<div class="breakdown-card">
      <h3>${bk.title}</h3>
      <table class="bd-table">
        <thead><tr><th></th><th>N</th><th>Invested</th><th>P/L</th><th>ROI</th><th>Cash%</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }

  g('breakdown-grid').innerHTML = breakdowns.map(renderBreakdownCard).filter(Boolean).join('') ||
    '<p style="font-size:13px;color:var(--gray-400);grid-column:1/-1">Log more lineups to see breakdowns.</p>';
}

// ── History ───────────────────────────────────────────────────────────────────
function renderHistory() {
  const sf = gv('hist-site'), tf = gv('hist-type'), rf = gv('hist-result');
  let data = [...slates];
  if (sf) data = data.filter(s => s.site === sf);
  if (tf) data = data.filter(s => s.ctype === tf);
  if (rf === 'pending') data = data.filter(s => !s.hasResults);
  else if (rf === 'Y')  data = data.filter(s => s.cashed === 'Y');
  else if (rf === 'N')  data = data.filter(s => s.hasResults && s.cashed === 'N');

  if (!data.length) {
    g('hist-table').innerHTML = '<div class="empty"><i class="ti ti-database-off"></i>No lineups yet</div>';
    return;
  }

  const rows = data.map(s => `<tr>
    <td>${s.date}</td>
    <td><span class="badge ${(s.site||'').toLowerCase()}">${s.site||'—'}</span></td>
    <td style="max-width:150px;overflow:hidden;text-overflow:ellipsis" title="${s.contest}">${s.contest}</td>
    <td><span class="badge ${s.ctype&&s.ctype.startsWith('Cash')?'cash':'gpp'}">${s.ctype||'—'}</span></td>
    <td>$${(s.fee||0).toFixed(2)}</td>
    <td>${s.sp||'—'}</td>
    <td>${[s.stackOwn,s.stackSize].filter(Boolean).join(' ')||'—'}</td>
    <td>${s.proj||'—'}</td>
    <td>${s.hasResults?(s.score!=null?s.score.toFixed(1):'—'):'<span style="color:var(--gray-400);font-size:11px">pending</span>'}</td>
    <td>${s.hasResults?(s.cashed||'—'):'—'}</td>
    <td>${s.hasResults?`<span class="${(s.pl||0)>=0?'pos':'neg'}">${(s.pl||0)>=0?'+':''}$${Math.abs(s.pl||0).toFixed(2)}</span>`:'—'}</td>
    <td><button class="btn danger" style="padding:4px 8px;font-size:11px" onclick="deleteLineup(${s.id})"><i class="ti ti-trash"></i></button></td>
  </tr>`).join('');

  g('hist-table').innerHTML = `<table>
    <thead><tr>
      <th>Date</th><th>Site</th><th>Contest</th><th>Type</th><th>Fee</th>
      <th>SP own</th><th>Stack</th><th>Proj</th><th>Score</th><th>Cash</th><th>P/L</th><th></th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function deleteLineup(id) {
  if (!confirm('Delete this lineup?')) return;
  slates = slates.filter(s => s.id !== id);
  persistSlates(); renderAll(); renderPendingSelect();
}

// ── Export CSV ────────────────────────────────────────────────────────────────
function exportCSV() {
  const h = ['Date','Site','Slate Type','Contest','Contest Type','Fee','Max Entries',
    'SP Ownership','Stack Ownership','Stack Size','Bring-Back','Proj Source','Note',
    'Score','Finish','Field Size','Cashed','Winnings','P/L'];
  const rows = slates.map(s => [
    s.date,s.site,s.slateType,s.contest,s.ctype,s.fee,s.maxEntries,
    s.sp,s.stackOwn,s.stackSize,s.bringback,s.proj,s.note,
    s.score,s.finish,s.field,s.cashed,s.winnings,s.pl,
  ].map(v => v == null ? '' : `"${String(v).replace(/"/g,'""')}"`));
  const csv = [h.join(','), ...rows.map(r => r.join(','))].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], {type:'text/csv'}));
  a.download = `mlb_dfs_${todayISO()}.csv`;
  a.click();
}

// ── Checklist ─────────────────────────────────────────────────────────────────
const CHECKLIST = [
  'Pull SplashPlay pitcher + batter projections for slate',
  'Open Stokastic — check projected ownership + top stacks tool',
  'Compare SP projection between SplashPlay and Stokastic — flag divergences >1.5 pts',
  'Identify primary stack: top-4 implied total team with Stokastic stack edge score',
  'Identify secondary stack: mid-tier implied total, low proj ownership (<12%)',
  'Pick bring-back hitter from opposing team vs your SP',
  'Check late lineup news and scratches within 30 min of lock',
  'Confirm contest type — cash lineup ≠ GPP lineup, never enter same lineup in both',
  'Log each lineup in the app immediately after lock',
];

function renderChecklist() {
  let checked = {};
  try { checked = JSON.parse(localStorage.getItem(CHECK_KEY) || '{}'); } catch {}
  g('checklist').innerHTML = CHECKLIST.map((item, i) =>
    `<li class="${checked[i]?'done':''}" onclick="toggleCheck(${i})">
      <div class="check-box">${checked[i]?'<i class="ti ti-check"></i>':''}</div>
      <span class="step-num">${String(i+1).padStart(2,'0')}</span>
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

function resetChecklist() { localStorage.removeItem(CHECK_KEY); renderChecklist(); }

function renderAll() { renderDashboard(); renderHistory(); }
