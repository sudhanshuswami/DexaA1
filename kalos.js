/**
 * ═══════════════════════════════════════════════════════════════
 *  KALOS — Unified Application JavaScript
 *  Namespace: window.Kalos
 *  Sections:
 *    1. Config & State
 *    2. Utilities (formatters, DOM helpers, skeleton, toast)
 *    3. API layer (all fetch calls)
 *    4. Auth module
 *    5. Dashboard module
 *    6. Coach / MemberGPT module
 *    7. DBViewer module
 *    8. Boot (auto-init based on page)
 * ═══════════════════════════════════════════════════════════════
 */

const Kalos = (() => {

/* ╔═══════════════════════════════════════════════════════════╗
   ║  1. CONFIG & SHARED STATE                                 ║
   ╚═══════════════════════════════════════════════════════════╝ */
const API = '';

// ── Dashboard state ──
let _member  = null;
let _scans   = [];
let _chart   = null;

// ── Coach state ──
let _members       = [];
let _chatHistory   = [];
let _isStreaming   = false;
let _abortCtrl     = null;   // AbortController for stop-streaming
let _selectedIds   = null;   // null = ALL, Set of ids = filtered

// ── DBViewer state ──
let _editTable  = null;
let _editId     = null;
let _pending    = {};
let _valErr     = {};
let _arTimer    = null;
let _prevCounts = { scans: 0, members: 0 };
let _refreshing = false;   // race-condition lock

/* ╔═══════════════════════════════════════════════════════════╗
   ║  2. UTILITIES                                             ║
   ╚═══════════════════════════════════════════════════════════╝ */
const Utils = {

  // ── Formatters ──
  pct:  v => v != null ? v.toFixed(1) : '—',
  lbs:  v => v != null ? v.toFixed(1) : '—',
  fmt:  v => v != null ? parseFloat(v).toFixed(0) : '—',
  delta:(a, b) => (a != null && b != null) ? a - b : null,

  fmtNum(col, v) {
    if (typeof v !== 'number') return v;
    if (col === 'resting_metabolic_rate') return Math.round(v);
    return v.toFixed(1);
  },

  formatDate(d) {
    if (!d) return '—';
    return new Date(d + 'T00:00:00').toLocaleDateString('en-US',
      { year: 'numeric', month: 'long', day: 'numeric' });
  },

  formatDateShort(d) {
    if (!d) return '—';
    return new Date(d + 'T00:00:00').toLocaleDateString('en-US',
      { month: 'short', day: 'numeric' });
  },

  escapeHTML: s => String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;'),

  initials: name => name.split(' ').map(p => p[0]).join('').toUpperCase().slice(0, 2),

  autoResize(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  },

  fatStatus(p)  { return p == null ? '' : p < 20 ? 'improved' : p > 30 ? 'regressed' : ''; },
  visceralStatus(v) { return v == null ? '' : v < 100 ? 'improved' : v > 160 ? 'regressed' : ''; },

  // ── Markdown → HTML (safe) ──
  markdownToHTML(text) {
    let s = text
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/\*\*(.+?)\*\*/gs, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/gs, '<em>$1</em>')
      .replace(/^#{1,3} (.+)$/gm, '<strong>$1</strong>')
      .replace(/^- (.+)$/gm, '<li>$1</li>')
      .replace(/(<li>[^]*?<\/li>)/g, '<ul>$1</ul>')
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br/>');
    s = '<p>' + s + '</p>';
    return s.replace(/<p><\/p>/g, '')
            .replace(/<p>(<ul>)/g, '$1')
            .replace(/(<\/ul>)<\/p>/g, '$1');
  },

  // ── Toast ──
  toast(msg, type = 'ok', duration = 3200) {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.className = `show ${type}`;
    clearTimeout(el._timer);
    el._timer = setTimeout(() => { el.className = ''; }, duration);
  },

  // ── Skeleton loaders ──
  skeletonMetricCards(count = 6) {
    return `<div class="metrics-grid">${Array(count).fill(0).map(() => `
      <div class="metric-card">
        <div class="skel skel-label"></div>
        <div class="skel skel-value"></div>
        <div class="skel skel-delta"></div>
      </div>`).join('')}</div>`;
  },

  skeletonTable(rows = 5, cols = 6) {
    const headerCells = Array(cols).fill('<th><div class="skel skel-th"></div></th>').join('');
    const bodyCells   = Array(cols).fill(0).map(() =>
      `<td><div class="skel skel-td"></div></td>`).join('');
    const bodyRows = Array(rows).fill(`<tr>${bodyCells}</tr>`).join('');
    return `<div class="table-wrap">
      <table><thead><tr>${headerCells}</tr></thead><tbody>${bodyRows}</tbody></table>
    </div>`;
  },

  skeletonChat() {
    return `<div class="skel-chat">
      <div class="skel-msg skel-msg-ai"><div class="skel skel-avatar"></div><div class="skel skel-bubble"></div></div>
      <div class="skel-msg skel-msg-user"><div class="skel skel-bubble skel-bubble-sm"></div><div class="skel skel-avatar"></div></div>
    </div>`;
  },
};

/* ╔═══════════════════════════════════════════════════════════╗
   ║  3. API LAYER                                             ║
   ╚═══════════════════════════════════════════════════════════╝ */
const Api = {

  async post(url, body) {
    const r = await fetch(API + url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'include',
    });
    return r;
  },

  async get(url) {
    return fetch(API + url, { credentials: 'include' });
  },

  async login(email, password)   { return Api.post('/api/auth/login', { email, password }); },
  async logout()                 { return Api.post('/api/auth/logout', {}); },
  async me()                     { return Api.get('/api/auth/me'); },
  async myScans()                { return Api.get('/api/scans/me'); },
  async allMembers()             { return Api.get('/api/members'); },
  async dbData()                 { return fetch('/api/dbviewer/data'); },
  async dbRules()                { return fetch('/api/dbviewer/rules'); },
  async dbReset()                { return fetch('/api/dbviewer/reset', { method: 'POST' }); },

  async patchScan(id, field, value) {
    return fetch(`/api/dbviewer/scan/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ field, value }),
    });
  },

  async patchMember(id, field, value) {
    return fetch(`/api/dbviewer/member/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ field, value }),
    });
  },

  async deleteScan(id) {
    return fetch(`/api/dbviewer/scan/${id}`, { method: 'DELETE' });
  },

  async uploadScan(file, overrideDate, signal) {
    const form = new FormData();
    form.append('file', file);
    if (overrideDate) form.append('scan_date_override', overrideDate);
    return fetch(API + '/api/scans/upload', {
      method: 'POST', body: form, credentials: 'include', signal,
    });
  },

  // Streaming chat — returns response object, caller reads stream
  async chat(message, history, memberIds, signal) {
    return fetch(API + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, history, member_ids: memberIds }),
      signal,
    });
  },
};

/* ╔═══════════════════════════════════════════════════════════╗
   ║  4. AUTH MODULE                                           ║
   ╚═══════════════════════════════════════════════════════════╝ */
const Auth = {

  async login() {
    const email    = document.getElementById('login-email')?.value.trim();
    const password = document.getElementById('login-password')?.value;
    const errEl    = document.getElementById('auth-error');
    if (errEl) errEl.textContent = '';

    if (!email || !password) {
      if (errEl) errEl.textContent = 'Please enter email and password.';
      return;
    }
    try {
      const r = await Api.login(email, password);
      if (!r.ok) {
        const data = await r.json();
        if (errEl) errEl.textContent = data.detail || 'Login failed.';
        return;
      }
      _member = await r.json();
      Dashboard.show();
    } catch {
      if (errEl) errEl.textContent = 'Connection error. Is the server running?';
    }
  },

  async logout() {
    await Api.logout();
    _member = null;
    _scans  = [];
    document.getElementById('app').style.display = 'none';
    document.getElementById('auth-screen').style.display = 'flex';
  },

  async checkSession() {
    try {
      const r = await Api.me();
      if (r.ok) {
        _member = await r.json();
        Dashboard.show();
      } else {
        document.getElementById('auth-screen').style.display = 'flex';
      }
    } catch {
      document.getElementById('auth-screen').style.display = 'flex';
    }
  },
};

/* ╔═══════════════════════════════════════════════════════════╗
   ║  5. DASHBOARD MODULE                                      ║
   ╚═══════════════════════════════════════════════════════════╝ */
const Dashboard = {

  show() {
    document.getElementById('auth-screen').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    const nn = document.getElementById('nav-name');
    if (nn) nn.textContent = _member.name;
    Dashboard.load();
  },

  async load() {
    const main = document.getElementById('main-content');
    if (!main) return;
    // Skeleton while loading
    main.innerHTML = Utils.skeletonMetricCards(6);
    try {
      const r = await Api.myScans();
      if (!r.ok) throw new Error('Failed');
      _scans = await r.json();
      Dashboard.render();
    } catch {
      main.innerHTML = `<div class="card card-pad" style="color:var(--danger)">
        ⚠️ Failed to load scan data. <button class="btn-ghost btn-sm" onclick="Kalos.Dashboard.load()">Retry</button>
      </div>`;
    }
  },

  render() {
    const n = _scans.length;
    if      (n === 0) Dashboard.renderOnboarding();
    else if (n === 1) Dashboard.renderFirstScan();
    else if (n === 2) Dashboard.renderSecondScan();
    else              Dashboard.renderReturning();
  },

  // ── Persona 0: no scans ──
  renderOnboarding() {
    const main = document.getElementById('main-content');
    main.innerHTML = `
      <div class="persona-header fade-in">
        <h1>Welcome, <em>${Utils.escapeHTML(_member.name.split(' ')[0])}</em>.</h1>
        <p>You haven't had a DEXA scan yet. Upload your first scan below to get started.</p>
      </div>
      ${Dashboard._uploadHTML()}`;
    Dashboard._bindUpload();
  },

  // ── Persona 1: first scan ──
  renderFirstScan() {
    const s = _scans[0];
    const main = document.getElementById('main-content');
    main.innerHTML = `
      <div class="persona-header fade-in">
        <h1>Your first scan,<br/><em>decoded.</em></h1>
        <p>Welcome to your body composition baseline. Here's what your numbers mean.</p>
      </div>
      ${Dashboard._goalBanner()}
      <div class="metrics-grid fade-in">
        ${Dashboard._metricCard('Body Fat',    Utils.pct(s.total_body_fat_pct),   '%',      Utils.fatStatus(s.total_body_fat_pct))}
        ${Dashboard._metricCard('Lean Mass',   Utils.lbs(s.total_lean_mass_lbs),  'lbs')}
        ${Dashboard._metricCard('Fat Mass',    Utils.lbs(s.total_fat_mass_lbs),   'lbs')}
        ${Dashboard._metricCard('Total Weight',Utils.lbs(s.total_weight_lbs),     'lbs')}
        ${Dashboard._metricCard('Visceral Fat',Utils.fmt(s.visceral_fat_area_cm2),'cm²',    Utils.visceralStatus(s.visceral_fat_area_cm2))}
        ${Dashboard._metricCard('RMR',         Utils.fmt(s.resting_metabolic_rate),'kcal/day')}
      </div>
      <div class="education-grid fade-in">
        ${Dashboard._eduCard('🔥','Body Fat %',`Your body fat is <span class="edu-highlight">${Utils.pct(s.total_body_fat_pct)}%</span>. Tracking changes here is the core of body composition work.`)}
        ${Dashboard._eduCard('💪','Lean Mass',`You have <span class="edu-highlight">${Utils.lbs(s.total_lean_mass_lbs)} lbs</span> of lean mass. Protecting and building this is key to a higher metabolism.`)}
        ${Dashboard._eduCard('🫀','Visceral Fat',`Your visceral fat area is <span class="edu-highlight">${Utils.fmt(s.visceral_fat_area_cm2)} cm²</span>. Under 100 cm² is the target zone.`)}
        ${Dashboard._eduCard('⚡','Resting Metabolic Rate',`You burn <span class="edu-highlight">${Utils.fmt(s.resting_metabolic_rate)} calories/day</span> at rest. Building muscle increases this.`)}
      </div>
      ${Dashboard._regionalHTML(s)}
      ${Dashboard._uploadHTML()}`;
    Dashboard._bindUpload();
  },

  // ── Persona 2: second scan ──
  renderSecondScan() {
    const first = _scans[0], latest = _scans[1];
    const main = document.getElementById('main-content');
    const dFat    = Utils.delta(latest.total_body_fat_pct,  first.total_body_fat_pct);
    const dLean   = Utils.delta(latest.total_lean_mass_lbs, first.total_lean_mass_lbs);
    const dFatM   = Utils.delta(latest.total_fat_mass_lbs,  first.total_fat_mass_lbs);
    const dWeight = Utils.delta(latest.total_weight_lbs,    first.total_weight_lbs);

    main.innerHTML = `
      <div class="persona-header fade-in">
        <h1>The moment<br/><em>of truth.</em></h1>
        <p>Your second scan is in. Here's exactly what changed.</p>
      </div>
      ${Dashboard._goalBanner()}
      <div class="metrics-grid fade-in">
        ${Dashboard._metricCardDelta('Body Fat',    Utils.pct(latest.total_body_fat_pct),  '%',   dFat,    true)}
        ${Dashboard._metricCardDelta('Lean Mass',   Utils.lbs(latest.total_lean_mass_lbs), 'lbs', dLean,   false)}
        ${Dashboard._metricCardDelta('Fat Mass',    Utils.lbs(latest.total_fat_mass_lbs),  'lbs', dFatM,   true)}
        ${Dashboard._metricCardDelta('Total Weight',Utils.lbs(latest.total_weight_lbs),    'lbs', dWeight, null)}
        ${Dashboard._metricCard('Visceral Fat',Utils.fmt(latest.visceral_fat_area_cm2),'cm²',Utils.visceralStatus(latest.visceral_fat_area_cm2))}
        ${Dashboard._metricCard('RMR',Utils.fmt(latest.resting_metabolic_rate),'kcal/day')}
      </div>
      <div class="comparison-grid fade-in">
        <div class="scan-col">
          <div class="scan-col-label">Baseline Scan</div>
          <div class="scan-col-date">${Utils.formatDate(first.scan_date)}</div>
          ${Dashboard._scanRows(first)}
        </div>
        <div class="scan-col">
          <div class="scan-col-label">Latest Scan</div>
          <div class="scan-col-date">${Utils.formatDate(latest.scan_date)}</div>
          ${Dashboard._scanRows(latest)}
        </div>
      </div>
      ${Dashboard._regionalHTML(latest)}
      ${Dashboard._uploadHTML()}`;
    Dashboard._bindUpload();
  },

  // ── Persona 3+: returning ──
  renderReturning() {
    const latest = _scans[_scans.length - 1];
    const prev   = _scans[_scans.length - 2];
    const first  = _scans[0];
    const main   = document.getElementById('main-content');
    const dFat     = Utils.delta(latest.total_body_fat_pct,  prev.total_body_fat_pct);
    const dLean    = Utils.delta(latest.total_lean_mass_lbs, prev.total_lean_mass_lbs);
    const dFatAll  = Utils.delta(latest.total_body_fat_pct,  first.total_body_fat_pct);
    const dLeanAll = Utils.delta(latest.total_lean_mass_lbs, first.total_lean_mass_lbs);

    main.innerHTML = `
      <div class="persona-header fade-in">
        <h1>Your progress,<br/><em>${_scans.length} scans deep.</em></h1>
        <p>You've been consistent. Here's your full body composition story over time.</p>
      </div>
      ${Dashboard._goalBanner()}
      <div class="metrics-grid fade-in">
        ${Dashboard._metricCardDelta('Body Fat Now',   Utils.pct(latest.total_body_fat_pct),         '%',   dFat,    true,  'vs last scan')}
        ${Dashboard._metricCardDelta('Lean Mass Now',  Utils.lbs(latest.total_lean_mass_lbs),        'lbs', dLean,   false, 'vs last scan')}
        ${Dashboard._metricCardDelta('Total Fat Δ',   Utils.pct(Math.abs(dFatAll ?? 0)),             '%',   dFatAll, true,  'since first')}
        ${Dashboard._metricCardDelta('Total Lean Δ',  Utils.lbs(Math.abs(dLeanAll ?? 0)),            'lbs', dLeanAll,false, 'since first')}
        ${Dashboard._metricCard('Visceral Fat',Utils.fmt(latest.visceral_fat_area_cm2),'cm²',Utils.visceralStatus(latest.visceral_fat_area_cm2))}
        ${Dashboard._metricCard('RMR',Utils.fmt(latest.resting_metabolic_rate),'kcal/day')}
      </div>
      <div class="chart-section fade-in">
        <div class="chart-header">
          <div class="chart-title">Body Composition Trend</div>
          <div class="chart-tabs">
            <button class="chart-tab active" data-type="fat"      onclick="Kalos.Dashboard.switchChart('fat',this)">Body Fat %</button>
            <button class="chart-tab"        data-type="lean"     onclick="Kalos.Dashboard.switchChart('lean',this)">Lean Mass</button>
            <button class="chart-tab"        data-type="visceral" onclick="Kalos.Dashboard.switchChart('visceral',this)">Visceral Fat</button>
          </div>
        </div>
        <div class="chart-wrap"><canvas id="trend-chart"></canvas></div>
      </div>
      <div class="history-section fade-in">
        <div class="section-title">Scan History</div>
        <div class="table-wrap">
          <table class="history-table">
            <thead><tr>
              <th>Date</th><th>Body Fat %</th><th>Lean Mass</th><th>Fat Mass</th><th>Weight</th><th>Visceral</th><th>RMR</th>
            </tr></thead>
            <tbody>${[..._scans].reverse().map((s, i) => `
              <tr>
                <td>${Utils.formatDate(s.scan_date)}${i === 0 ? ' <span class="badge badge-purple">Latest</span>' : ''}</td>
                <td>${Utils.pct(s.total_body_fat_pct)}%</td>
                <td>${Utils.lbs(s.total_lean_mass_lbs)} lbs</td>
                <td>${Utils.lbs(s.total_fat_mass_lbs)} lbs</td>
                <td>${Utils.lbs(s.total_weight_lbs)} lbs</td>
                <td>${Utils.fmt(s.visceral_fat_area_cm2)} cm²</td>
                <td>${Utils.fmt(s.resting_metabolic_rate)} kcal</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
      ${Dashboard._regionalHTML(latest)}
      ${Dashboard._uploadHTML()}`;
    Dashboard._bindUpload();
    Dashboard.renderChart('fat');
  },

  switchChart(type, btn) {
    document.querySelectorAll('.chart-tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    Dashboard.renderChart(type);
  },

  renderChart(type) {
    if (_chart) { _chart.destroy(); _chart = null; }
    const canvas = document.getElementById('trend-chart');
    if (!canvas) return;
    const labels = _scans.map(s => Utils.formatDateShort(s.scan_date));
    const configs = {
      fat:      { data: _scans.map(s => s.total_body_fat_pct),    label: 'Body Fat %',          color: '#ef4444', yLabel: '%'    },
      lean:     { data: _scans.map(s => s.total_lean_mass_lbs),   label: 'Lean Mass (lbs)',     color: '#059669', yLabel: 'lbs'  },
      visceral: { data: _scans.map(s => s.visceral_fat_area_cm2), label: 'Visceral Fat (cm²)',  color: '#d97706', yLabel: 'cm²'  },
    };
    const { data, label, color, yLabel } = configs[type] || configs.fat;
    _chart = new Chart(canvas, {
      type: 'line',
      data: { labels, datasets: [{
        label, data, borderColor: color,
        backgroundColor: color + '18',
        borderWidth: 2.5, pointRadius: 5,
        pointBackgroundColor: color, tension: 0.35, fill: true,
      }]},
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false },
          tooltip: { callbacks: { label: ctx => ` ${ctx.parsed.y} ${yLabel}` } }},
        scales: {
          x: { grid: { color: '#e2dff5' }, ticks: { color: '#6b6b8a', font: { family: 'Inter' } } },
          y: { grid: { color: '#e2dff5' }, ticks: { color: '#6b6b8a', font: { family: 'Inter' },
            callback: v => v + ' ' + yLabel } },
        },
      },
    });
  },

  // ── Upload ──
  _uploadHTML() {
    const today = new Date().toISOString().split('T')[0];
    return `
      <div class="upload-section" id="upload-zone">
        <div class="upload-icon">📄</div>
        <div class="upload-title">Upload a DEXA Scan PDF</div>
        <div class="upload-sub">AI extracts your results automatically — works with any DEXA format</div>
        <div class="date-override-row" onclick="event.stopPropagation()">
          <label for="scan-date-override">📅 Override scan date:</label>
          <input type="date" id="scan-date-override" class="date-override-input" value="${today}" />
          <span class="date-hint">(optional — overrides extracted date for testing)</span>
        </div>
        <label class="btn-upload" for="file-input">Choose PDF</label>
        <div class="upload-status" id="upload-status"></div>
      </div>`;
  },

  _bindUpload() {
    const zone = document.getElementById('upload-zone');
    if (!zone) return;
    zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('dragover'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
    zone.addEventListener('drop', e => {
      e.preventDefault(); zone.classList.remove('dragover');
      const f = e.dataTransfer.files[0];
      if (f) Dashboard.uploadFile(f);
    });
    // File input
    const fi = document.getElementById('file-input');
    if (fi) {
      fi.onchange = e => { if (e.target.files[0]) Dashboard.uploadFile(e.target.files[0]); };
    }
    // Keyboard enter on password field (in case auth screen is still in DOM)
    const pw = document.getElementById('login-password');
    if (pw && !pw._bound) { pw._bound = true; pw.addEventListener('keydown', e => { if (e.key === 'Enter') Auth.login(); }); }
  },

  async uploadFile(file) {
    const status = document.getElementById('upload-status');
    if (!status) return;

    if (!file.name.toLowerCase().endsWith('.pdf')) {
      status.innerHTML = '<span class="upload-err">❌ Please upload a PDF file.</span>';
      return;
    }

    const overrideDate = document.getElementById('scan-date-override')?.value || '';
    status.innerHTML = `<span style="color:var(--text3)">⏳ Uploading and extracting with AI…${overrideDate ? ' (date: ' + overrideDate + ')' : ''}</span>`;

    const fi = document.getElementById('file-input');

    try {
      const r = await Api.uploadScan(file, overrideDate, null);

      if (!r.ok) {
        let errMsg = 'Upload failed.';
        try {
          const err = await r.json();
          errMsg = err.detail || errMsg;
        } catch {}

        // Show manual entry fallback if extraction failed
        if (r.status === 422) {
          status.innerHTML = `
            <span class="upload-err">❌ Could not extract data from this PDF automatically.</span>
            <button class="btn-secondary btn-sm" style="margin-top:10px"
              onclick="Kalos.Dashboard.showManualEntry()">Enter data manually instead</button>`;
        } else {
          status.innerHTML = `<span class="upload-err">❌ ${Utils.escapeHTML(errMsg)}</span>`;
        }
        return;
      }

      const scan = await r.json();
      status.innerHTML = `<span class="upload-ok">✅ Scan saved for ${scan.scan_date}! Refreshing…</span>`;

      // Immediately add to local array and re-render (no fixed timeout)
      _scans.push(scan);
      _scans.sort((a, b) => a.scan_date.localeCompare(b.scan_date));
      setTimeout(() => Dashboard.render(), 600);

    } catch (e) {
      status.innerHTML = '<span class="upload-err">❌ Upload failed. Check connection.</span>';
    }

    if (fi) fi.value = '';
  },

  showManualEntry() {
    const status = document.getElementById('upload-status');
    if (!status) return;
    const today = new Date().toISOString().split('T')[0];
    status.innerHTML = `
      <div class="manual-entry-form" style="text-align:left;margin-top:16px">
        <div style="font-weight:700;margin-bottom:12px;color:var(--text)">Manual Scan Entry</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div class="field"><label>Scan Date</label><input class="input" type="date" id="me-date" value="${today}"/></div>
          <div class="field"><label>Body Fat %</label><input class="input" type="number" step="0.1" id="me-fat" placeholder="e.g. 24.5"/></div>
          <div class="field"><label>Lean Mass (lbs)</label><input class="input" type="number" step="0.1" id="me-lean" placeholder="e.g. 130.2"/></div>
          <div class="field"><label>Fat Mass (lbs)</label><input class="input" type="number" step="0.1" id="me-fatm" placeholder="e.g. 42.1"/></div>
          <div class="field"><label>Total Weight (lbs)</label><input class="input" type="number" step="0.1" id="me-weight" placeholder="e.g. 178.0"/></div>
          <div class="field"><label>Visceral Fat Area (cm²)</label><input class="input" type="number" step="1" id="me-visceral" placeholder="e.g. 85"/></div>
          <div class="field"><label>RMR (kcal/day)</label><input class="input" type="number" step="1" id="me-rmr" placeholder="e.g. 1800"/></div>
        </div>
        <div style="margin-top:14px;display:flex;gap:10px">
          <button class="btn-primary btn-sm" onclick="Kalos.Dashboard.submitManualEntry()">Save Scan</button>
          <button class="btn-ghost btn-sm" onclick="document.getElementById('upload-status').innerHTML=''">Cancel</button>
        </div>
        <div id="me-error" style="color:var(--danger);font-size:0.8rem;margin-top:8px"></div>
      </div>`;
  },

  async submitManualEntry() {
    const get = id => document.getElementById(id)?.value;
    const errEl = document.getElementById('me-error');
    const payload = {
      scan_date:             get('me-date'),
      total_body_fat_pct:    parseFloat(get('me-fat'))     || null,
      total_lean_mass_lbs:   parseFloat(get('me-lean'))    || null,
      total_fat_mass_lbs:    parseFloat(get('me-fatm'))    || null,
      total_weight_lbs:      parseFloat(get('me-weight'))  || null,
      visceral_fat_area_cm2: parseFloat(get('me-visceral'))|| null,
      resting_metabolic_rate:parseFloat(get('me-rmr'))     || null,
    };
    if (!payload.scan_date) { if (errEl) errEl.textContent = 'Scan date is required.'; return; }

    try {
      const r = await fetch(API + '/api/scans/manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        credentials: 'include',
      });
      if (!r.ok) {
        const e = await r.json();
        if (errEl) errEl.textContent = e.detail || 'Save failed.';
        return;
      }
      const scan = await r.json();
      _scans.push(scan);
      _scans.sort((a, b) => a.scan_date.localeCompare(b.scan_date));
      Dashboard.render();
    } catch {
      if (errEl) errEl.textContent = 'Connection error.';
    }
  },

  // ── HTML helpers ──
  _goalBanner() {
    if (!_member?.goal) return '';
    return `<div class="goal-banner fade-in">
      <div class="goal-icon">🎯</div>
      <div class="goal-text"><strong>Your Goal</strong><span>${Utils.escapeHTML(_member.goal)}</span></div>
    </div>`;
  },

  _metricCard(label, value, unit, cls = '') {
    return `<div class="metric-card ${cls}">
      <div class="metric-label">${label}</div>
      <div class="metric-value">${value}<span class="metric-unit">${unit}</span></div>
    </div>`;
  },

  _metricCardDelta(label, value, unit, d, lowerIsBetter, note = '') {
    let cls = '', arrow = '', dcls = 'delta-neutral';
    if (d !== null && d !== undefined) {
      const improved = lowerIsBetter ? d < 0 : d > 0;
      cls = improved ? 'improved' : 'regressed';
      arrow = improved ? '▲' : '▼';
      dcls = improved ? 'delta-up' : 'delta-down';
    }
    return `<div class="metric-card ${cls}">
      <div class="metric-label">${label}</div>
      <div class="metric-value">${value}<span class="metric-unit">${unit}</span></div>
      ${d != null ? `<div class="metric-delta ${dcls}">${arrow} ${Math.abs(d).toFixed(1)} ${unit} ${note}</div>` : ''}
    </div>`;
  },

  _eduCard(icon, title, body) {
    return `<div class="edu-card fade-in">
      <div class="edu-icon">${icon}</div>
      <div class="edu-title">${title}</div>
      <div class="edu-body">${body}</div>
    </div>`;
  },

  _scanRows(s) {
    return [
      ['Body Fat',        Utils.pct(s.total_body_fat_pct)   + '%'  ],
      ['Lean Mass',       Utils.lbs(s.total_lean_mass_lbs)  + ' lbs'],
      ['Fat Mass',        Utils.lbs(s.total_fat_mass_lbs)   + ' lbs'],
      ['Total Weight',    Utils.lbs(s.total_weight_lbs)     + ' lbs'],
      ['Android Fat',     Utils.pct(s.android_fat_pct)      + '%'  ],
      ['Visceral Fat',    Utils.fmt(s.visceral_fat_area_cm2) + ' cm²'],
      ['RMR',             Utils.fmt(s.resting_metabolic_rate)+ ' kcal'],
    ].map(([l, v]) =>
      `<div class="scan-row"><span class="scan-row-label">${l}</span><span class="scan-row-val">${v}</span></div>`
    ).join('');
  },

  _regionalHTML(s) {
    const regions = [
      ['Left Arm',  s.left_arm_lean_lbs ],
      ['Right Arm', s.right_arm_lean_lbs],
      ['Left Leg',  s.left_leg_lean_lbs ],
      ['Right Leg', s.right_leg_lean_lbs],
      ['Trunk',     s.trunk_lean_lbs    ],
    ];
    return `<div class="regional-section fade-in">
      <div class="section-title">Regional Lean Mass</div>
      <div class="body-grid">
        ${regions.map(([name, val]) => `
          <div class="region-card">
            <div class="region-name">${name}</div>
            <div class="region-val">${Utils.lbs(val)}</div>
            <div class="region-sub">lbs lean</div>
          </div>`).join('')}
      </div>
    </div>`;
  },
};

/* ╔═══════════════════════════════════════════════════════════╗
   ║  6. COACH / MEMBERGPT MODULE                             ║
   ╚═══════════════════════════════════════════════════════════╝ */

// ── Question templates ──
const TEMPLATES = {
  single: [
    { label: 'Body fat trend for {name}',       template: "How has {name}'s body fat percentage trended over time?" },
    { label: 'Latest scan changes for {name}',  template: "What changed between {name}'s last two scans?" },
    { label: 'Coaching focus for {name}',       template: "What should I focus on in my next coaching session with {name}?" },
    { label: 'Visceral fat status for {name}',  template: "What is {name}'s visceral fat area and is it in a healthy range?" },
    { label: 'Full overview for {name}',        template: "Give me a full body composition overview for {name}." },
    { label: 'Lean mass trend for {name}',      template: "How has {name}'s lean mass changed over all their scans?" },
    { label: 'Weight vs fat vs lean for {name}',template: "Break down {name}'s weight change into fat vs lean mass components." },
    { label: 'Bone density for {name}',         template: "What is {name}'s bone mineral density and is it in a healthy range?" },
    { label: 'RMR change for {name}',           template: "How has {name}'s resting metabolic rate changed over time?" },
    { label: 'Android/Gynoid ratio for {name}', template: "What is {name}'s android to gynoid fat ratio and what does it mean for their health?" },
    { label: 'Progress summary for {name}',     template: "Give me a concise progress report for {name} covering all their scans." },
  ],
  multi: [
    { label: 'Compare lean mass changes',       template: 'Compare lean mass changes between {names}.' },
    { label: 'Highest body fat %',              template: 'Which of {names} has the highest body fat percentage?' },
    { label: 'Best progress',                   template: 'Which of {names} has made the most progress in body composition?' },
    { label: 'Compare visceral fat',            template: "Compare visceral fat levels between {names}." },
    { label: 'Who improved most',               template: "Who made the most improvement in body composition among {names}?" },
    { label: 'Compare RMR',                     template: "Compare resting metabolic rates between {names}." },
  ],
  all: [
    { label: 'Members losing lean mass',        template: 'Which members have lost lean mass between their last two scans?' },
    { label: '3+ scans count',                  template: 'How many members have had 3 or more scans?' },
    { label: 'Average body fat %',              template: 'What is the average body fat percentage across all members?' },
    { label: 'High visceral fat members',       template: 'Which members have visceral fat area above 100 cm²?' },
    { label: 'Overdue for scan',                template: 'Which members have not had a scan in the last 90 days?' },
    { label: 'Best body fat improvement',       template: "Which member has improved their body fat percentage the most since their first scan?" },
    { label: 'Most lean mass gained',           template: "Which member has gained the most lean mass overall?" },
    { label: 'Members with low bone density',   template: "Are there any members with concerning bone mineral density scores?" },
    { label: 'Members ready for next scan',     template: "Which members are due for their next scan based on typical 90-day intervals?" },
    { label: 'Overall program summary',         template: "Give me a summary of how the overall member base is progressing." },
    { label: 'Biggest health risks',            template: "Which members have the most concerning health indicators based on their scan data?" },
  ],
};


 

const Coach = {

  async init() {
    // Skeleton sidebar while loading
    const list = document.getElementById('member-list');
    if (list) list.innerHTML = [1,2,3,4].map(() => `
      <div class="member-item">
        <div class="skel skel-avatar-round"></div>
        <div style="flex:1"><div class="skel skel-label" style="margin-bottom:6px"></div><div class="skel skel-delta"></div></div>
      </div>`).join('');

    try {
      const r = await Api.allMembers();
      _members = await r.json();
    } catch {
      if (list) list.innerHTML = '<div style="padding:16px;color:var(--danger);font-size:0.82rem">Failed to load members.</div>';
      return;
    }

    Coach._renderSidebar();
    Coach._updateTemplateDropdown();
    Coach._bindInputs();
  },

  _renderSidebar() {
    const list = document.getElementById('member-list');
    if (!list) return;

    // "All members" option at top
    list.innerHTML = `
      <div class="member-item active" id="mi-all" onclick="Kalos.Coach.selectAll()">
        <div class="member-avatar" style="background:var(--border2);color:var(--text3);font-size:0.7rem">ALL</div>
        <div class="member-info">
          <div class="member-info-name">All Members</div>
          <div class="member-info-scans">${_members.length} members</div>
        </div>
      </div>
      ${_members.map(m => `
        <div class="member-item" id="mi-${m.id}" onclick="Kalos.Coach.toggleMember(${m.id})">
          <div class="member-avatar">${Utils.initials(m.name)}</div>
          <div class="member-info">
            <div class="member-info-name">${Utils.escapeHTML(m.name)}</div>
            <div class="member-info-scans"><span class="scan-badge"></span>${m.scan_count} scan${m.scan_count !== 1 ? 's' : ''}</div>
          </div>
          <div class="member-check" id="mc-${m.id}">☐</div>
        </div>`).join('')}`;
  },

  selectAll() {
    _selectedIds = null;
    // Update UI
    document.querySelectorAll('.member-item').forEach(el => el.classList.remove('active'));
    document.getElementById('mi-all')?.classList.add('active');
    document.querySelectorAll('.member-check').forEach(el => el.textContent = '☐');
    Coach._updateHeader('All members', `${_members.length} members · All data`);
    Coach._updateTemplateDropdown();
  },

  toggleMember(id) {
    // Deselect "ALL"
    document.getElementById('mi-all')?.classList.remove('active');

    if (!_selectedIds) _selectedIds = new Set();

    if (_selectedIds.has(id)) {
      _selectedIds.delete(id);
      document.getElementById('mi-' + id)?.classList.remove('active');
      const _mc = document.getElementById('mc-' + id); if(_mc) _mc.textContent = '☐';
    } else {
      _selectedIds.add(id);
      document.getElementById('mi-' + id)?.classList.add('active');
      const _mc2 = document.getElementById('mc-' + id); if(_mc2) _mc2.textContent = '☑';
    }

    // If nothing selected, go back to ALL
    if (_selectedIds.size === 0) { Coach.selectAll(); return; }

    const selected = Coach._getSelected();
    const names = selected.map(m => m.name).join(', ');
    Coach._updateHeader(selected.length === 1 ? selected[0].name : `${selected.length} members`, names);
    Coach._updateTemplateDropdown();
  },

  _getSelected() {
    if (!_selectedIds) return _members;
    return _members.filter(m => _selectedIds.has(m.id));
  },

  _getMemberIds() {
    if (!_selectedIds) return null; // backend: all
    return [..._selectedIds];
  },

  _updateHeader(title, sub) {
    const t = document.getElementById('chat-title');
    const s = document.getElementById('chat-sub');
    if (t) t.textContent = title;
    if (s) s.textContent = sub + ' · Powered by Gemini';
  },

  _updateTemplateDropdown() {
    const sel = document.getElementById('question-template');
    if (!sel) return;
    const selected = Coach._getSelected();
    let set;
    if (!_selectedIds)            set = TEMPLATES.all;
    else if (selected.length === 1) set = TEMPLATES.single;
    else                            set = TEMPLATES.multi;

    sel.innerHTML = '<option value="">— Quick question template —</option>';
    set.forEach((t, i) => {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = t.label;
      sel.appendChild(opt);
    });
  },

  applyTemplate(idx) {
    if (idx === '' || idx === null || idx === undefined) return;
    const selected = Coach._getSelected();
    let set;
    if (!_selectedIds)              set = TEMPLATES.all;
    else if (selected.length === 1) set = TEMPLATES.single;
    else                            set = TEMPLATES.multi;

    const tmpl = set[parseInt(idx)];
    if (!tmpl) return;
    let q = tmpl.template;
    if (selected.length === 1)       q = q.replace(/\{name\}/g,  selected[0].name);
    else if (selected.length > 1)    q = q.replace(/\{names\}/g, selected.map(m => m.name).join(', '));

    const box = document.getElementById('input-box');
    if (box) { box.value = q; Utils.autoResize(box); }
    // Reset dropdown
    const sel = document.getElementById('question-template');
    if (sel) sel.value = '';
  },

  _bindInputs() {
    const box = document.getElementById('input-box');
    if (box) {
      box.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); Coach.sendMessage(); }
      });
      box.addEventListener('input', () => Utils.autoResize(box));
    }
    // Hamburger menu for mobile
    const hamburger = document.getElementById('sidebar-toggle');
    if (hamburger) {
      hamburger.addEventListener('click', () => {
        const sidebar = document.querySelector('.sidebar');
        if (sidebar) sidebar.classList.toggle('sidebar-open');
      });
    }
    // Close sidebar when clicking outside on mobile
    document.addEventListener('click', e => {
      const sidebar = document.querySelector('.sidebar');
      if (!sidebar) return;
      if (sidebar.classList.contains('sidebar-open') &&
          !sidebar.contains(e.target) &&
          e.target.id !== 'sidebar-toggle') {
        sidebar.classList.remove('sidebar-open');
      }
    });
  },

  newChat() {
    _chatHistory = [];
    Coach.selectAll();
    const msgs = document.getElementById('messages');
    if (msgs) msgs.innerHTML = Coach._welcomeHTML();
  },

  sendSuggestion(q) {
    if (_isStreaming) return; // ignore if streaming
    const box = document.getElementById('input-box');
    if (box) { box.value = q; Utils.autoResize(box); }
    Coach.sendMessage();
  },

  async sendMessage() {
    if (_isStreaming) return;
    const box     = document.getElementById('input-box');
    const sendBtn = document.getElementById('send-btn');
    const stopBtn = document.getElementById('stop-btn');
    const text    = box?.value.trim();
    if (!text) return;

    box.value = '';
    Utils.autoResize(box);
    document.getElementById('welcome-state')?.remove();

    // Disable all suggestion buttons while streaming
    document.querySelectorAll('.suggestion').forEach(b => b.disabled = true);
    if (sendBtn) sendBtn.style.display = 'none';
    if (stopBtn) stopBtn.style.display = 'flex';

    const msgs = document.getElementById('messages');

    // Append user bubble
    Coach._appendUserBubble(text);
    _chatHistory.push({ role: 'user', content: text });

    // Create a fresh AI bubble with unique id
    const bubbleId = 'ai-bubble-' + Date.now();
    const aiBubbleEl = document.createElement('div');
    aiBubbleEl.className = 'message ai fade-in';
    aiBubbleEl.innerHTML = `
      <div class="msg-avatar ai">K</div>
      <div class="msg-bubble" id="${bubbleId}">
        <div class="typing-indicator">
          <div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>
        </div>
      </div>`;
    msgs.appendChild(aiBubbleEl);
    msgs.scrollTop = msgs.scrollHeight;

    _isStreaming = true;
    _abortCtrl = new AbortController();

    let fullResponse = '';
    const bubble = document.getElementById(bubbleId);

    try {
      const memberIds = Coach._getMemberIds();
      const r = await Api.chat(text, _chatHistory.slice(0, -1), memberIds, _abortCtrl.signal);

      if (!r.ok) {
        let detail = 'Server error.';
        try { detail = (await r.json()).detail || detail; } catch {}
        if (bubble) bubble.innerHTML = `<span class="upload-err">⚠️ ${Utils.escapeHTML(detail)}</span>`;
        _chatHistory.pop(); // remove the user message since we got no response
      } else {
        const reader  = r.body.getReader();
        const decoder = new TextDecoder();
        if (bubble) bubble.innerHTML = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          fullResponse += decoder.decode(value, { stream: true });
          if (bubble) bubble.innerHTML = Utils.markdownToHTML(fullResponse);
          msgs.scrollTop = msgs.scrollHeight;
        }

        if (fullResponse) {
          _chatHistory.push({ role: 'assistant', content: fullResponse });
        } else {
          _chatHistory.pop();
        }
      }

    } catch (e) {
      if (e.name === 'AbortError') {
        // User stopped streaming
        if (bubble && fullResponse) {
          bubble.innerHTML = Utils.markdownToHTML(fullResponse) +
            '<div style="color:var(--muted);font-size:.75rem;margin-top:6px">— stopped —</div>';
          _chatHistory.push({ role: 'assistant', content: fullResponse });
        } else if (bubble) {
          bubble.innerHTML = '<span style="color:var(--muted);font-size:.82rem">Stopped.</span>';
          _chatHistory.pop();
        }
      } else {
        if (bubble) bubble.innerHTML = '<span class="upload-err">⚠️ Connection error. Is the server running?</span>';
        _chatHistory.pop();
      }
    }

    _isStreaming = false;
    _abortCtrl  = null;
    if (sendBtn) sendBtn.style.display = 'flex';
    if (stopBtn) stopBtn.style.display = 'none';
    document.querySelectorAll('.suggestion').forEach(b => b.disabled = false);
    msgs.scrollTop = msgs.scrollHeight;
  },

  stopStreaming() {
    if (_abortCtrl) _abortCtrl.abort();
  },

  _appendUserBubble(text) {
    const msgs = document.getElementById('messages');
    const div  = document.createElement('div');
    div.className = 'message user fade-in';
    div.innerHTML = `<div class="msg-avatar user">👤</div><div class="msg-bubble">${Utils.escapeHTML(text)}</div>`;
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
  },

  _welcomeHTML() {
    return `<div class="welcome fade-in" id="welcome-state">
      <h2>Hey Coach,<br/>ask me <em>anything.</em></h2>
      <p>Select members on the left, pick a template, or type your own question. All answers are grounded in real scan data.</p>
      <div class="suggestions">
        <button class="suggestion" onclick="Kalos.Coach.sendSuggestion(this.dataset.q)"
          data-q="How has Maya's body fat percentage trended over the last year?">
          How has Maya's body fat percentage trended?
          <span>Trend analysis</span>
        </button>
        <button class="suggestion" onclick="Kalos.Coach.sendSuggestion(this.dataset.q)"
          data-q="Which members have lost lean mass between their last two scans?">
          Which members have lost lean mass?
          <span>Cross-member comparison</span>
        </button>
        <button class="suggestion" onclick="Kalos.Coach.sendSuggestion(this.dataset.q)"
          data-q="How many members have had 3 or more scans?">
          How many members have 3+ scans?
          <span>Database query</span>
        </button>
        <button class="suggestion" onclick="Kalos.Coach.sendSuggestion(this.dataset.q)"
          data-q="What should I focus on in my next coaching session with Jordan?">
          What to focus on with Jordan?
          <span>Coaching recommendation</span>
        </button>
      </div>
    </div>`;
  },
};

/* ╔═══════════════════════════════════════════════════════════╗
   ║  7. DBVIEWER MODULE                                       ║
   ╚═══════════════════════════════════════════════════════════╝ */

// Validation rules (mirrors backend)
const DB_RULES = {
  scans: {
    scan_date:             { type:'date' },
    total_body_fat_pct:    { type:'num', min:1,   max:70   },
    total_lean_mass_lbs:   { type:'num', min:10,  max:300  },
    total_fat_mass_lbs:    { type:'num', min:1,   max:400  },
    total_weight_lbs:      { type:'num', min:50,  max:700  },
    android_fat_pct:       { type:'num', min:1,   max:80   },
    gynoid_fat_pct:        { type:'num', min:1,   max:80   },
    visceral_fat_area_cm2: { type:'num', min:0,   max:500  },
    resting_metabolic_rate:{ type:'num', min:500, max:5000 },
    trunk_lean_lbs:        { type:'num', min:10,  max:150  },
  },
  members: {
    name: { type:'str', minLen:2, maxLen:80  },
    goal: { type:'str', minLen:0, maxLen:200 },
    age:  { type:'num', min:10,  max:110    },
  },
};

const SCAN_COLS    = ['id','member_name','scan_date','total_body_fat_pct','total_lean_mass_lbs','total_fat_mass_lbs','total_weight_lbs','android_fat_pct','gynoid_fat_pct','visceral_fat_area_cm2','resting_metabolic_rate','trunk_lean_lbs','created_at','_actions'];
const SCAN_LABELS  = { id:'ID',member_name:'Member',scan_date:'Scan Date',total_body_fat_pct:'Fat %',total_lean_mass_lbs:'Lean lbs',total_fat_mass_lbs:'Fat lbs',total_weight_lbs:'Weight lbs',android_fat_pct:'Android%',gynoid_fat_pct:'Gynoid%',visceral_fat_area_cm2:'Visceral cm²',resting_metabolic_rate:'RMR',trunk_lean_lbs:'Trunk Lean',created_at:'Saved At',_actions:'Actions' };
const SCAN_EDIT    = new Set(['scan_date','total_body_fat_pct','total_lean_mass_lbs','total_fat_mass_lbs','total_weight_lbs','android_fat_pct','gynoid_fat_pct','visceral_fat_area_cm2','resting_metabolic_rate','trunk_lean_lbs']);
const MBR_COLS     = ['id','name','email','age','goal','scan_count','last_scan','_actions'];
const MBR_LABELS   = { id:'ID',name:'Name',email:'Email',age:'Age',goal:'Goal',scan_count:'Scans',last_scan:'Last Scan',_actions:'Actions' };
const MBR_EDIT     = new Set(['name','goal','age']);

const DBViewer = {

  async init() {
    // Skeleton while loading
    document.getElementById('tab-scans').innerHTML   = Utils.skeletonTable(6, 7);
    document.getElementById('tab-members').innerHTML = Utils.skeletonTable(5, 5);

    await DBViewer.refresh();
    // Auto-refresh — skip if editing (atomic check)
    _arTimer = setInterval(() => {
      if (_editId === null && !_refreshing) DBViewer.refresh();
    }, 3000);
  },

  async refresh() {
    if (_refreshing) return;
    _refreshing = true;
    try {
      const r = await Api.dbData();
      if (!r.ok) throw new Error(r.status);
      const data = await r.json();

      DBViewer._updateStats(data.stats);
      DBViewer._renderScans(data.scans);
      DBViewer._renderMembers(data.members);

      if (_prevCounts.scans && data.stats.total_scans > _prevCounts.scans)
        DBViewer.log('OK', `🆕 ${data.stats.total_scans - _prevCounts.scans} new scan(s) added`);
      if (_prevCounts.members && data.stats.total_members > _prevCounts.members)
        DBViewer.log('OK', '🆕 New member added');
      _prevCounts = { scans: data.stats.total_scans, members: data.stats.total_members };

      document.getElementById('sdot').className = 'dot';
      document.getElementById('stext').textContent = 'Connected — click any cell to edit';
      document.getElementById('lupd').textContent  = 'Updated ' + new Date().toLocaleTimeString();
    } catch (e) {
      document.getElementById('sdot').className = 'dot off';
      document.getElementById('stext').textContent = 'Connection error';
      DBViewer.log('ERR', 'Fetch failed: ' + e.message);
    } finally {
      _refreshing = false;
    }
  },

  _updateStats(s) {
    document.getElementById('s-m').textContent = s.total_members;
    document.getElementById('s-s').textContent = s.total_scans;
    document.getElementById('s-l').textContent = s.latest_scan ? s.latest_scan.slice(0, 16) : '—';
  },

  _renderScans(scans) {
    const el = document.getElementById('tab-scans');
    if (!scans.length) { el.innerHTML = '<div class="empty">No scans.</div>'; return; }
    const thead = SCAN_COLS.map(c => `<th>${SCAN_LABELS[c]}</th>`).join('');
    const tbody = scans.map(s => DBViewer._scanRow(s)).join('');
    el.innerHTML = `<div class="table-wrap"><table>
      <thead><tr>${thead}</tr></thead>
      <tbody>${tbody}</tbody>
    </table></div>`;
  },

  _scanRow(s) {
    const id        = s.id;
    const isEditing = _editTable === 'scans' && _editId === id;
    const isLocked  = _editTable === 'scans' && _editId !== null && _editId !== id;
    const cls       = isEditing ? 'editing' : isLocked ? 'locked' : '';

    const cells = SCAN_COLS.map(col => {
      if (col === '_actions') return `<td>${DBViewer._actionBtns('scans', id, isEditing)}</td>`;
      if (col === 'id')          return `<td style="color:var(--muted);font-family:var(--font-mono)">${id}</td>`;
      if (col === 'member_name') return `<td style="font-weight:600">${Utils.escapeHTML(s.member_name || '—')}</td>`;
      if (col === 'created_at')  return `<td style="color:var(--muted);font-size:.72rem">${(s[col]||'').slice(0,16)}</td>`;

      const val = s[col];
      if (isEditing && SCAN_EDIT.has(col)) return DBViewer._editCell('scans', id, col, val);

      const disp = val == null
        ? '<span class="null-val">null</span>'
        : col === 'scan_date'
          ? `<span style="color:var(--success);font-weight:600">${val}</span>`
          : `<span style="font-family:var(--font-mono)">${Utils.fmtNum(col, val)}</span>`;

      return SCAN_EDIT.has(col)
        ? `<td><span class="cell-view" onclick="Kalos.DBViewer.startEdit('scans',${id})" title="Click to edit">${disp}</span></td>`
        : `<td>${disp}</td>`;
    }).join('');

    return `<tr id="sr-${id}" class="${cls}">${cells}</tr>`;
  },

  _renderMembers(members) {
    const el = document.getElementById('tab-members');
    if (!members.length) { el.innerHTML = '<div class="empty">No members.</div>'; return; }
    const thead = MBR_COLS.map(c => `<th>${MBR_LABELS[c]}</th>`).join('');
    const tbody = members.map(m => DBViewer._memberRow(m)).join('');
    el.innerHTML = `<div class="table-wrap"><table>
      <thead><tr>${thead}</tr></thead>
      <tbody>${tbody}</tbody>
    </table></div>`;
  },

  _memberRow(m) {
    const id        = m.id;
    const isEditing = _editTable === 'members' && _editId === id;
    const isLocked  = _editTable === 'members' && _editId !== null && _editId !== id;
    const cls       = isEditing ? 'editing' : isLocked ? 'locked' : '';

    const cells = MBR_COLS.map(col => {
      if (col === '_actions')   return `<td>${DBViewer._actionBtns('members', id, isEditing)}</td>`;
      if (col === 'id')         return `<td style="color:var(--muted);font-family:var(--font-mono)">${id}</td>`;
      if (col === 'email')      return `<td style="color:var(--info)">${Utils.escapeHTML(m.email)}</td>`;
      if (col === 'last_scan')  return `<td style="color:var(--muted)">${m.last_scan || '—'}</td>`;
      if (col === 'scan_count') {
        const bc = m.scan_count >= 3 ? 'badge-green' : m.scan_count >= 1 ? 'badge-yellow' : 'badge-red';
        return `<td><span class="badge ${bc}">${m.scan_count}</span></td>`;
      }
      const val = m[col];
      if (isEditing && MBR_EDIT.has(col)) return DBViewer._editCell('members', id, col, val);
      const disp = val == null ? '<span class="null-val">—</span>' : Utils.escapeHTML(String(val));
      return MBR_EDIT.has(col)
        ? `<td><span class="cell-view" onclick="Kalos.DBViewer.startEdit('members',${id})" title="Click to edit">${disp}</span></td>`
        : `<td>${disp}</td>`;
    }).join('');

    return `<tr id="mr-${id}" class="${cls}">${cells}</tr>`;
  },

  _editCell(table, id, col, originalVal) {
    const curVal    = col in _pending ? _pending[col] : (originalVal ?? '');
    const err       = _valErr[col];
    const isDate    = col === 'scan_date';
    const isWide    = col === 'goal';
    const inputType = isDate ? 'date' : (col === 'age' || col === 'name' || col === 'goal') ? 'text' : 'number';
    const escaped   = Utils.escapeHTML(String(curVal));
    return `<td>
      <input class="cell-input${isWide ? ' wide' : ''}${err ? ' error' : ''}"
        type="${inputType}" ${inputType === 'number' ? 'step="0.01"' : ''}
        id="ci-${id}-${col}" value="${escaped}"
        oninput="Kalos.DBViewer.onInput('${table}','${col}',this.value,${id})"
        onkeydown="Kalos.DBViewer.onKey(event,${id})" />
      ${err ? `<span class="cell-err">${err}</span>` : ''}
    </td>`;
  },

  _actionBtns(table, id, isEditing) {
    const del = table === 'scans' ? `<button class="btn-del" onclick="Kalos.DBViewer.delScan(${id})" title="Delete">🗑</button>` : '';
    if (isEditing) return `<div class="row-actions">
      <button class="btn-save" id="sb-${id}" onclick="Kalos.DBViewer.saveRow('${table}',${id})">✓ Save</button>
      <button class="btn-cancel" onclick="Kalos.DBViewer.cancelEdit()">✗ Cancel</button>
      ${del}
    </div>`;
    return `<div class="row-actions">
      <button class="btn-edit-row" onclick="Kalos.DBViewer.startEdit('${table}',${id})">Edit</button>
      ${del}
    </div>`;
  },

  startEdit(table, id) {
    if (_editId === id && _editTable === table) return;
    if (_editId !== null) DBViewer.cancelEdit();
    _editTable = table; _editId = id; _pending = {}; _valErr = {};
    const se = document.getElementById('s-e');
    if (se) se.textContent = `Editing ${table} #${id}`;
    DBViewer.log('INFO', `Started editing ${table} #${id}`);
    DBViewer.refresh(); // re-render with inputs
    setTimeout(() => {
      const firstKey = Object.keys(DB_RULES[table])[0];
      document.getElementById(`ci-${id}-${firstKey}`)?.focus();
    }, 80);
  },

  cancelEdit() {
    if (!_editId) return;
    DBViewer.log('INFO', `Cancelled edits on ${_editTable} #${_editId}`);
    _editTable = null; _editId = null; _pending = {}; _valErr = {};
    const se = document.getElementById('s-e');
    if (se) se.textContent = 'Click any cell to edit';
    DBViewer.refresh();
  },

  onInput(table, col, val, id) {
    _pending[col] = val;
    const err = DBViewer._validate(table, col, val);
    _valErr[col] = err || null;

    const inp = document.getElementById(`ci-${id}-${col}`);
    if (inp) {
      inp.className = `cell-input${col === 'goal' ? ' wide' : ''}${err ? ' error' : ''}`;
      let span = inp.parentElement.querySelector('.cell-err');
      if (err) {
        if (!span) { span = document.createElement('span'); span.className = 'cell-err'; inp.parentElement.appendChild(span); }
        span.textContent = err;
      } else if (span) span.remove();
    }
    const sb = document.getElementById(`sb-${id}`);
    if (sb) sb.disabled = Object.values(_valErr).some(Boolean);
  },

  onKey(e, id) {
    if (e.key === 'Escape') DBViewer.cancelEdit();
    if (e.key === 'Enter')  DBViewer.saveRow(_editTable, id);
  },

  _validate(table, col, val) {
    const r = DB_RULES[table]?.[col];
    if (!r || val === '' || val == null) return null;
    if (r.type === 'date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(val)) return 'Format: YYYY-MM-DD';
      if (new Date(val) > new Date()) return 'Cannot be in the future';
      return null;
    }
    if (r.type === 'num') {
      const n = parseFloat(val);
      if (isNaN(n)) return 'Must be a number';
      if (r.min !== undefined && n < r.min) return `Min: ${r.min}`;
      if (r.max !== undefined && n > r.max) return `Max: ${r.max}`;
      return null;
    }
    if (r.type === 'str') {
      if (r.minLen && val.length < r.minLen) return `Min ${r.minLen} chars`;
      if (r.maxLen && val.length > r.maxLen) return `Max ${r.maxLen} chars`;
      return null;
    }
    return null;
  },

  async saveRow(table, id) {
    if (Object.values(_valErr).some(Boolean)) { Utils.toast('Fix errors first', 'err'); return; }
    const entries = Object.entries(_pending).filter(([, v]) => v !== '');
    if (!entries.length) { DBViewer.cancelEdit(); return; }

    const sb = document.getElementById(`sb-${id}`);
    if (sb) { sb.disabled = true; sb.textContent = '…'; }

    let saved = 0, lastErr = null;
    for (const [field, value] of entries) {
      try {
        const r = table === 'scans'
          ? await Api.patchScan(id, field, value === '' ? null : value)
          : await Api.patchMember(id, field, value === '' ? null : value);
        if (!r.ok) { lastErr = (await r.json()).detail || 'Error'; _valErr[field] = lastErr; }
        else { saved++; DBViewer.log('OK', `${table} #${id} → ${field} = "${value}"`); }
      } catch (e) { lastErr = e.message; DBViewer.log('ERR', e.message); }
    }

    if (lastErr) {
      Utils.toast(lastErr, 'err');
      if (sb) { sb.disabled = false; sb.textContent = '✓ Save'; }
      DBViewer.refresh();
      return;
    }

    Utils.toast(`Saved ${saved} field${saved !== 1 ? 's' : ''} ✓`, 'ok');
    _editTable = null; _editId = null; _pending = {}; _valErr = {};
    const se = document.getElementById('s-e');
    if (se) se.textContent = 'Click any cell to edit';
    DBViewer.refresh();
  },

  async delScan(id) {
    if (!confirm(`Delete scan #${id}? This cannot be undone.`)) return;
    try {
      const r = await Api.deleteScan(id);
      if (!r.ok) throw new Error((await r.json()).detail);
      Utils.toast(`Scan #${id} deleted`, 'ok');
      DBViewer.log('WARN', `Scan #${id} deleted`);
      if (_editId === id) { _editId = null; _editTable = null; _pending = {}; _valErr = {}; }
      DBViewer.refresh();
    } catch (e) {
      Utils.toast('Delete failed: ' + e.message, 'err');
    }
  },

  switchTab(name, btn) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-scans').style.display   = name === 'scans'   ? '' : 'none';
    document.getElementById('tab-members').style.display = name === 'members' ? '' : 'none';
  },

  toggleAutoRefresh(on) {
    if (on) {
      _arTimer = setInterval(() => { if (!_editId && !_refreshing) DBViewer.refresh(); }, 3000);
      DBViewer.log('INFO', 'Auto-refresh on (3s)');
    } else {
      clearInterval(_arTimer);
      DBViewer.log('INFO', 'Auto-refresh off');
    }
  },

  async reset() {
    if (!confirm('⚠️ Delete ALL data and re-seed?')) return;
    DBViewer.cancelEdit();
    try {
      await Api.dbReset();
      Utils.toast('DB reset and re-seeded', 'ok');
      DBViewer.log('WARN', 'Database reset and re-seeded');
      DBViewer.refresh();
    } catch (e) {
      Utils.toast('Reset failed', 'err');
      DBViewer.log('ERR', e.message);
    }
  },

  log(level, msg) {
    const box = document.getElementById('log-box');
    if (!box) return;
    const d = document.createElement('div');
    d.className = 'log-line';
    d.innerHTML = `<span class="log-ts">${new Date().toLocaleTimeString()}</span>` +
                  `<span class="log-${level}">[${level}]</span>` +
                  `<span class="log-msg"> ${Utils.escapeHTML(msg)}</span>`;
    box.appendChild(d);
    box.scrollTop = box.scrollHeight;
  },

  clearLog() {
    const box = document.getElementById('log-box');
    if (box) box.innerHTML = '';
    DBViewer.log('INFO', 'Log cleared');
  },
};

/* ╔═══════════════════════════════════════════════════════════╗
   ║  8. BOOT — auto-init based on page                        ║
   ╚═══════════════════════════════════════════════════════════╝ */
function _boot() {
  const page = document.body.dataset.page;
  if (page === 'dashboard') Auth.checkSession();
  else if (page === 'coach')    Coach.init();
  else if (page === 'dbviewer') DBViewer.init();
}

document.addEventListener('DOMContentLoaded', _boot);

// Public API
return { Utils, Api, Auth, Dashboard, Coach, DBViewer };

})(); // end Kalos IIFE


// Global shims for inline HTML onclick handlers
window.doLogin       = () => Kalos.Auth.login();
window.doLogout      = () => Kalos.Auth.logout();
window.sendMessage   = () => Kalos.Coach.sendMessage();
window.sendSuggestion= (q) => Kalos.Coach.sendSuggestion(q);
window.newChat       = () => Kalos.Coach.newChat();
window.handleFileSelect = (e) => { if(e.target.files[0]) Kalos.Dashboard.uploadFile(e.target.files[0]); };
window.handleKey     = (e) => { if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();Kalos.Coach.sendMessage();} };
window.autoResize    = (el) => Kalos.Utils.autoResize(el);
window.switchChart   = (t,b) => Kalos.Dashboard.switchChart(t,b);
window.toggleAR      = (on) => Kalos.DBViewer.toggleAutoRefresh(on);
window.confirmReset  = () => Kalos.DBViewer.reset();
window.startEdit     = (t,id) => Kalos.DBViewer.startEdit(t,id);
window.cancelEdit    = () => Kalos.DBViewer.cancelEdit();
window.saveRow       = (t,id) => Kalos.DBViewer.saveRow(t,id);
window.delScan       = (id) => Kalos.DBViewer.delScan(id);
window.onInput       = (t,c,v,id) => Kalos.DBViewer.onInput(t,c,v,id);
window.onKey         = (e,id) => Kalos.DBViewer.onKey(e,id);
window.switchTab     = (n,b) => Kalos.DBViewer.switchTab(n,b);
window.clearLog      = () => Kalos.DBViewer.clearLog();
window.focusMember   = (id) => Kalos.Coach.toggleMember(id);