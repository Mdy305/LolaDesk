/* ============================================================
   REVENUE / REPORTS — LolaDesk
   KPIs, revenue trend, revenue by service, staff performance,
   client retention cohorts. Tolerant of missing endpoints.
   ============================================================ */

(function () {
  'use strict';

  const state = {
    range: '30d',
    metrics: null,
    trend: [],      // [{d, v}]  daily revenue
    services: [],   // [{name, revenue_cents, count}]
    staff: [],      // [{name, bookings, hours, revenue_cents}]
    retention: [],  // [{cohort, clients, rebooked, rate}]
  };

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt$ = c => `$${Math.round(Math.max(0, +c || 0) / 100).toLocaleString()}`;
  const fmt$2 = c => `$${(Math.max(0, +c || 0) / 100).toFixed(2)}`;
  const iso = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const daysAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); d.setHours(0,0,0,0); return d; };
  const rangeDays = () => parseInt(state.range, 10) || 30;

  // One source for bookings in a range, one money rule. Bookings keep
  // dollars (total_amount: 250) — the page works in cents.
  const apptCache = new Map();
  async function appts(fromDaysAgo) {
    const from = iso(daysAgo(fromDaysAgo)), to = iso(new Date()), k = from + to;
    if (!apptCache.has(k)) apptCache.set(k, (async () => {
      try {
        const r = await fetch(`/api/calendar?action=range&from=${from}&to=${to}`, { credentials: 'include' });
        if (!r.ok) return [];
        const d = await r.json();
        const rows = Array.isArray(d) ? d : (d.bookings || d.appointments || d.rows || d.data || []);
        const now = Date.now();
        return rows.filter(a => new Date(a.start_time || a.starts_at) <= now && !/cancel|no.?show/i.test(a.status || ''));
      } catch (_) { return []; }
    })());
    return apptCache.get(k);
  }
  const centsOf = a => a.price_cents != null ? (+a.price_cents || 0) : a.total_cents != null ? (+a.total_cents || 0) : Math.round((+(a.total_amount ?? a.price ?? a.amount) || 0) * 100);
  const svcOf = a => a.service_name || (a.service && typeof a.service === 'object' ? a.service.name : a.service) || a.service_title || 'Other';
  const staffOf = a => a.staff_name || (a.staff && typeof a.staff === 'object' ? a.staff.name : null) || a.stylist_name || a.stylist || 'Unassigned';

  // ── Boot ─────────────────────────────────────────────────
  async function boot() {
    document.querySelectorAll('.rv-r').forEach(b => {
      b.addEventListener('click', () => {
        document.querySelectorAll('.rv-r').forEach(x => x.classList.remove('on'));
        b.classList.add('on');
        state.range = b.dataset.range;
        load();
      });
    });
    load();
  }

  async function load() {
    apptCache.clear();
    appts(rangeDays() - 1).then(rows => { const m = new Map(); rows.forEach(a => { const k = iso(new Date(a.start_time || a.starts_at)); m.set(k, (m.get(k) || 0) + 1); }); state.dailyCount = m; });
    await Promise.all([
      loadMetrics(),
      loadServices(),
      loadStaff(),
      loadTrend(),
      loadRetention(),
    ]);
    render();
  }

  async function loadMetrics() {
    for (const ep of [
      `/api/stripe/metrics?range=${state.range}`,
      `/api/dashboard/snapshot?range=${state.range}`
    ]) {
      try {
        const r = await fetch(ep, { credentials: 'include' });
        if (!r.ok) continue;
        const d = await r.json();
        const src = d.data || d;
        state.metrics = {
          revenue: parseInt(src.revenue || src.revenue_cents || 0, 10) || 0,
          charges: parseInt(src.charges || src.charge_count || src.bookings || 0, 10) || 0,
          tips: parseInt(src.tips || src.tips_cents || 0, 10) || 0,
          deposits: parseInt(src.deposits || 0, 10) || 0,
          refunds: parseInt(src.refunds || 0, 10) || 0,
          sparkline: Array.isArray(src.sparkline) ? src.sparkline : [],
          trend_pct: parseFloat(src.trend_pct || 0) || 0,
        };
        return;
      } catch (_) {}
    }
  }

  async function loadTrend() {
    // Prefer daily rollup if there's a sparkline in metrics
    if (state.metrics?.sparkline?.length) {
      state.trend = state.metrics.sparkline.map(p => ({
        d: p.d || p.date || p.day,
        v: parseInt(p.v || p.value || p.revenue_cents || p.revenue || 0, 10) || 0
      }));
      return;
    }
    // Fall back to computing from appointments
    try {
      const rows = await appts(rangeDays() - 1);
      // Bucket by date
      const buckets = new Map();
      for (const a of rows) {
        const t = new Date(a.start_time || a.starts_at || a.created_at);
        if (isNaN(t)) continue;
        const k = iso(t);
        buckets.set(k, (buckets.get(k) || 0) + centsOf(a));
      }
      // Fill zero days
      const out = [];
      for (let i = rangeDays() - 1; i >= 0; i--) {
        const k = iso(daysAgo(i));
        out.push({ d: k, v: buckets.get(k) || 0 });
      }
      state.trend = out;
    } catch (_) {}
  }

  async function loadServices() {
    try {
      const r = await fetch(`/api/stripe/payments?range=${state.range}&group_by=service&limit=200`, { credentials: 'include' });
      if (!r.ok) throw new Error('no group');
      const d = await r.json();
      const rows = Array.isArray(d) ? d : (d.payments || d.rows || d.data || d.services || []);
      if (!rows.length) throw new Error('no payments yet');
      // Try to detect service grouping in the response
      const grouped = new Map();
      for (const p of rows) {
        const name = p.service || p.service_name || p.description || 'Other';
        const amt = parseInt(p.amount || p.amount_cents || p.revenue_cents || 0, 10) || 0;
        grouped.set(name, (grouped.get(name) || 0) + amt);
      }
      state.services = Array.from(grouped, ([name, revenue_cents]) => ({ name, revenue_cents }))
        .sort((a, b) => b.revenue_cents - a.revenue_cents)
        .slice(0, 8);
    } catch (_) {
      // Fall back: derive from appointments
      try {
        const rows = await appts(rangeDays() - 1);
        const grouped = new Map();
        for (const a of rows) grouped.set(svcOf(a), (grouped.get(svcOf(a)) || 0) + centsOf(a));
        state.services = Array.from(grouped, ([name, revenue_cents]) => ({ name, revenue_cents }))
          .sort((a, b) => b.revenue_cents - a.revenue_cents)
          .slice(0, 8);
      } catch (_) {}
    }
  }

  async function loadStaff() {
    for (const ep of [
      `/api/revenue/staff?range=${state.range}`
    ]) {
      try {
        const r = await fetch(ep, { credentials: 'include' });
        if (!r.ok) continue;
        const d = await r.json();
        const rows = Array.isArray(d) ? d : (d.staff || d.rows || d.data || []);
        if (!rows.length) continue;
        state.staff = rows.map(x => ({
          name: x.name || x.stylist_name || x.staff_name || 'Stylist',
          bookings: parseInt(x.bookings ?? x.count ?? x.appointment_count ?? 0, 10) || 0,
          hours: parseFloat(x.hours || (parseInt(x.total_minutes || 0, 10) / 60)) || 0,
          revenue_cents: x.revenue_cents != null ? (parseInt(x.revenue_cents, 10) || 0) : Math.round((+x.revenue || 0) * 100)
        })).sort((a, b) => b.revenue_cents - a.revenue_cents);
        return;
      } catch (_) {}
    }
    // Fall back: derive from appointments
    try {
      const rows = await appts(rangeDays() - 1);
      const bucket = new Map();
      for (const a of rows) {
        const name = staffOf(a);
        const p = bucket.get(name) || { name, bookings: 0, hours: 0, revenue_cents: 0 };
        p.bookings += 1;
        p.hours += (parseInt(a.duration_minutes || a.duration_min || 60, 10) || 60) / 60;
        p.revenue_cents += centsOf(a);
        bucket.set(name, p);
      }
      state.staff = Array.from(bucket.values()).sort((a, b) => b.revenue_cents - a.revenue_cents);
    } catch (_) {}
  }

  async function loadRetention() {
    // Compute rebooking rate by monthly cohort. We look back rangeDays()+90.
    try {
      const rows = await appts(rangeDays() + 90 - 1);
      // Group by client_id — first visit month = cohort
      const clients = new Map();
      for (const a of rows) {
        const cid = a.client_id || a.client_name || a.client_phone;
        if (!cid) continue;
        const t = new Date(a.start_time || a.starts_at);
        if (isNaN(t)) continue;
        const rec = clients.get(cid) || { visits: [], name: a.client_name || 'Client' };
        rec.visits.push(t);
        clients.set(cid, rec);
      }
      // For each cohort month, count clients with ≥ 2 visits
      const cohorts = new Map();
      for (const rec of clients.values()) {
        rec.visits.sort((a, b) => a - b);
        const first = rec.visits[0];
        const key = `${first.getFullYear()}-${String(first.getMonth()+1).padStart(2,'0')}`;
        const c = cohorts.get(key) || { cohort: key, clients: 0, rebooked: 0 };
        c.clients += 1;
        if (rec.visits.length >= 2) c.rebooked += 1;
        cohorts.set(key, c);
      }
      state.retention = Array.from(cohorts.values())
        .sort((a, b) => b.cohort.localeCompare(a.cohort))
        .slice(0, 6)
        .map(c => ({ ...c, rate: c.clients ? Math.round((c.rebooked / c.clients) * 100) : 0 }));
    } catch (_) {}
  }

  // ── Render ───────────────────────────────────────────────
  function render() {
    renderKPIs();
    renderTrend();
    renderServices();
    renderStaff();
    renderRetention();
  }

  function renderKPIs() {
    const m = state.metrics || {};
    const trend = state.trend || [];
    const rev = trend.reduce((s, p) => s + (p.v || 0), 0) || m.revenue || 0;
    const days = trend.length || rangeDays();
    const bookings = state.staff.reduce((s, x) => s + x.bookings, 0) || m.charges || 0;
    const avgTicket = bookings ? Math.round(rev / bookings) : 0;
    const workedHours = state.staff.reduce((s, x) => s + x.hours, 0);
    const capacityHours = (state.staff.length || 1) * 12 * days;
    const occ = capacityHours ? Math.round((workedHours / capacityHours) * 100) : 0;

    document.getElementById('kpiRevenue').textContent = fmt$(rev);
    document.getElementById('kpiBookings').textContent = bookings.toLocaleString();
    document.getElementById('kpiAvgTicket').textContent = fmt$(avgTicket);
    document.getElementById('kpiOccupancy').textContent = occ + '%';

    const tp = m.trend_pct || 0;
    setTrend('kpiRevenueTrend',  tp);
    setTrend('kpiBookingsTrend', 0);
    setTrend('kpiAvgTrend',      0);
    setTrend('kpiOccTrend',      0);

    drawSpark('sparkRevenue',  trend.map(p => p.v), '#ccff00');
    drawSpark('sparkBookings', trend.map(p => state.dailyCount?.get(p.d) || 0), '#af52de');
    drawSpark('sparkAvg',      trend.map(p => p.v > 0 ? avgTicket : 0), '#ff2d92');
    drawSpark('sparkOcc',      trend.map(p => Math.min(100, (p.v / (rev / days || 1)) * occ)), '#34c759');
  }

  function setTrend(id, pct) {
    const el = document.getElementById(id);
    if (!el) return;
    if (!pct) { el.textContent = '—'; el.className = 'kpi-trend'; return; }
    el.textContent = (pct >= 0 ? '▲ ' : '▼ ') + Math.abs(pct).toFixed(1) + '%';
    el.className = 'kpi-trend ' + (pct >= 0 ? 'up' : 'down');
  }

  function drawSpark(id, values, color) {
    const el = document.getElementById(id);
    if (!el) return;
    const W = 200, H = 40;
    const arr = values && values.length ? values : [0];
    const max = Math.max(...arr, 1);
    const min = Math.min(...arr, 0);
    const range = Math.max(1, max - min);
    const pts = arr.map((v, i) => {
      const x = (i / Math.max(1, arr.length - 1)) * W;
      const y = H - ((v - min) / range) * (H - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    el.innerHTML = `
      <defs>
        <linearGradient id="g${id}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${color}" stop-opacity="0.25"/>
          <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <polygon points="0,${H} ${pts} ${W},${H}" fill="url(#g${id})"/>
      <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    `;
  }

  function renderTrend() {
    const el = document.getElementById('chartTrend');
    const data = state.trend || [];
    if (!data.length) { el.innerHTML = '<text x="400" y="110" text-anchor="middle" fill="#86868b" font-size="13">No data</text>'; document.getElementById('trendSub').textContent = ''; return; }
    const W = 800, H = 220, pad = { l: 40, r: 12, t: 12, b: 30 };
    const max = Math.max(...data.map(p => p.v || 0), 1);
    const cellW = (W - pad.l - pad.r) / data.length;
    const barW = Math.max(2, cellW * 0.6);
    let bars = '';
    data.forEach((p, i) => {
      const h = ((p.v || 0) / max) * (H - pad.t - pad.b);
      const x = pad.l + i * cellW + (cellW - barW) / 2;
      const y = H - pad.b - h;
      bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="#ccff00" rx="2"/>`;
    });
    // Y-axis: 3 gridlines
    let grid = '';
    for (let i = 0; i <= 3; i++) {
      const y = pad.t + (i / 3) * (H - pad.t - pad.b);
      const val = Math.round(max * (1 - i / 3) / 100) * 100;
      grid += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y}" y2="${y}" stroke="rgba(0,0,0,0.06)"/>`;
      grid += `<text x="${pad.l - 6}" y="${y + 3}" text-anchor="end" fill="#86868b" font-size="10" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">${fmt$(val * 100)}</text>`;
    }
    // X labels — first, middle, last date
    let xlabels = '';
    [0, Math.floor(data.length / 2), data.length - 1].forEach(i => {
      if (!data[i]) return;
      const x = pad.l + i * cellW + cellW / 2;
      const d = new Date(data[i].d);
      const lab = isNaN(d) ? '' : d.toLocaleDateString('en-US', { month:'short', day:'numeric' });
      xlabels += `<text x="${x}" y="${H - 10}" text-anchor="middle" fill="#86868b" font-size="10">${lab}</text>`;
    });
    el.innerHTML = grid + bars + xlabels;
    const tot = data.reduce((s, p) => s + (p.v || 0), 0);
    document.getElementById('trendSub').textContent = `${fmt$(tot)} · ${data.length}d`;
  }

  function renderServices() {
    const el = document.getElementById('chartServices');
    const rows = state.services || [];
    if (!rows.length) { el.innerHTML = '<div style="text-align:center;color:#86868b;padding:40px 0;font-size:13px;">No service data yet.</div>'; return; }
    const max = rows[0]?.revenue_cents || 1;
    el.innerHTML = rows.map(r => {
      const pct = Math.max(2, (r.revenue_cents / max) * 100);
      return `
        <div class="hbar-row">
          <div class="hbar-label">${esc(r.name)}</div>
          <div class="hbar-amount">${fmt$(r.revenue_cents)}</div>
          <div class="hbar-bar"><div class="hbar-fill" style="width:${pct}%"></div></div>
        </div>
      `;
    }).join('');
    document.getElementById('serviceSub').textContent = `${rows.length} services`;
  }

  function renderStaff() {
    const tbody = document.querySelector('#tblStaff tbody');
    if (!state.staff.length) { tbody.innerHTML = '<tr><td colspan="5" class="empty">No stylist data yet.</td></tr>'; return; }
    tbody.innerHTML = state.staff.map(s => `
      <tr>
        <td>${esc(s.name)}</td>
        <td>${s.bookings}</td>
        <td>${s.hours.toFixed(1)}h</td>
        <td>${fmt$(s.revenue_cents)}</td>
        <td>${s.bookings ? fmt$(s.revenue_cents / s.bookings) : '—'}</td>
      </tr>
    `).join('');
  }

  function renderRetention() {
    const tbody = document.querySelector('#tblRetention tbody');
    if (!state.retention.length) { tbody.innerHTML = '<tr><td colspan="4" class="empty">Need at least 2 months of visits to compute cohorts.</td></tr>'; return; }
    tbody.innerHTML = state.retention.map(c => {
      const [y, m] = c.cohort.split('-');
      const dt = new Date(parseInt(y), parseInt(m) - 1, 1);
      const label = dt.toLocaleDateString('en-US', { month:'short', year:'numeric' });
      return `
        <tr>
          <td>${esc(label)}</td>
          <td>${c.clients}</td>
          <td>${c.rebooked}</td>
          <td>${c.rate}%</td>
        </tr>
      `;
    }).join('');
  }

  boot();
  console.info('[reports] ready');
})();
