/* ============================================================
   BOOK DIALOG — shared walk-in / owner booking modal.
   Any page can call:  window.LolaBookDialog.open({ date, start_time, stylist, onBooked })
   Renders a modal, lets the owner pick client + service + stylist + duration,
   saves via POST /api/appointments/create, calls onBooked(saved).
   ============================================================ */

(function (global) {
  'use strict';

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt$ = c => `$${(Math.max(0, +c || 0) / 100).toFixed(0)}`;

  const cache = { services: null, staff: null };

  function ensureStyles() {
    if (document.getElementById('lb-book-styles')) return;
    const st = document.createElement('style');
    st.id = 'lb-book-styles';
    st.textContent = `
      .lb-modal { position: fixed; inset: 0; display: grid; place-items: center; background: rgba(0,0,0,0.35); -webkit-backdrop-filter: blur(20px); backdrop-filter: blur(20px); z-index: 300; }
      .lb-modal[hidden] { display: none; }
      .lb-card { width: min(560px, 92vw); max-height: 88vh; overflow: auto; background: #fff; border-radius: 20px; padding: 32px; box-shadow: 0 30px 60px rgba(0,0,0,0.25); position: relative; }
      .lb-close { position: absolute; top: 16px; right: 16px; width: 36px; height: 36px; border: none; background: transparent; border-radius: 50%; font-size: 24px; color: #86868b; cursor: pointer; transition: background 200ms; }
      .lb-close:hover { background: rgba(0,0,0,0.05); color: #1d1d1f; }
      .lb-title { font-size: 22px; font-weight: 600; letter-spacing: -0.01em; margin: 0 0 4px; }
      .lb-when  { color: #6e6e73; font-size: 14px; margin-bottom: 20px; font-variant-numeric: tabular-nums; }
      .lb-field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; }
      .lb-field label { font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: #86868b; font-weight: 600; }
      .lb-input, .lb-select { height: 42px; padding: 0 14px; border: 1px solid rgba(0,0,0,0.12); background: #fff; border-radius: 10px; font: inherit; outline: none; transition: border-color 160ms ease; }
      .lb-input:focus, .lb-select:focus { border-color: #0071e3; }
      .lb-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
      .lb-hint { font-size: 12px; color: #86868b; margin-top: 4px; }
      .lb-suggest { position: relative; }
      .lb-suggest-list { position: absolute; top: 100%; left: 0; right: 0; background: #fff; border: 1px solid rgba(0,0,0,0.12); border-radius: 10px; box-shadow: 0 8px 30px rgba(0,0,0,0.1); max-height: 260px; overflow-y: auto; z-index: 10; margin-top: 4px; display: none; }
      .lb-suggest-list.on { display: block; }
      .lb-sg-row { padding: 10px 14px; cursor: pointer; border-bottom: 1px solid rgba(0,0,0,0.05); }
      .lb-sg-row:last-child { border-bottom: none; }
      .lb-sg-row:hover { background: rgba(0,0,0,0.03); }
      .lb-sg-name { font-size: 14px; font-weight: 500; color: #1d1d1f; }
      .lb-sg-sub  { font-size: 12px; color: #86868b; }
      .lb-actions { display: flex; gap: 8px; margin-top: 20px; }
      .lb-actions button { flex: 1; height: 44px; border-radius: 999px; border: 1px solid rgba(0,0,0,0.12); background: #fff; cursor: pointer; font-size: 14px; font-weight: 500; transition: background 160ms ease; }
      .lb-actions button:hover { background: rgba(0,0,0,0.04); }
      .lb-actions .lb-primary { background: #0071e3; color: #fff; border-color: #0071e3; }
      .lb-actions .lb-primary:hover { background: #0066cc; }
      .lb-actions .lb-primary:disabled { opacity: 0.5; cursor: not-allowed; }
      .lb-status { margin-top: 12px; padding: 10px 14px; border-radius: 10px; font-size: 13px; }
      .lb-status.ok  { background: rgba(52,199,89,0.14); color: #1a7e3e; }
      .lb-status.err { background: rgba(255,59,48,0.14); color: #a72929; }
    `;
    document.head.appendChild(st);
  }

  async function loadServices() {
    if (cache.services) return cache.services;
    for (const ep of ['/api/services', '/api/widget/services']) {
      try {
        const r = await fetch(ep, { credentials: 'include' });
        if (!r.ok) continue;
        const d = await r.json();
        const rows = Array.isArray(d) ? d : (d.services || d.rows || d.data || []);
        if (rows.length) {
          cache.services = rows.map(x => ({
            id: x.id || x.slug,
            name: x.name || x.title || 'Service',
            duration_minutes: parseInt(x.duration_minutes || x.duration_min || x.duration || 60, 10) || 60,
            price_cents: parseInt(x.price_cents || (parseFloat(x.price || 0) * 100), 10) || 0
          }));
          return cache.services;
        }
      } catch (_) {}
    }
    cache.services = [];
    return cache.services;
  }

  async function loadStaff() {
    if (cache.staff) return cache.staff;
    for (const ep of ['/api/staff', '/api/widget/staff']) {
      try {
        const r = await fetch(ep, { credentials: 'include' });
        if (!r.ok) continue;
        const d = await r.json();
        const rows = Array.isArray(d) ? d : (d.staff || d.rows || d.data || []);
        if (rows.length) {
          cache.staff = rows.map(x => ({ id: x.id, name: x.name || x.full_name || 'Stylist' }));
          return cache.staff;
        }
      } catch (_) {}
    }
    cache.staff = [];
    return cache.staff;
  }

  async function searchClients(q) {
    if (!q || q.length < 2) return [];
    for (const ep of [`/api/widget/client-lookup?q=${encodeURIComponent(q)}`, `/api/clients?q=${encodeURIComponent(q)}&limit=10`]) {
      try {
        const r = await fetch(ep, { credentials: 'include' });
        if (!r.ok) continue;
        const d = await r.json();
        const rows = Array.isArray(d) ? d : (d.clients || d.rows || d.data || (d.client ? [d.client] : []));
        return rows.slice(0, 8).map(x => ({ id: x.id, name: x.name || x.full_name, phone: x.phone || '' }));
      } catch (_) {}
    }
    return [];
  }

  function fmtHumanTime(hhmm) {
    const m = /(\d{1,2}):(\d{2})/.exec(hhmm || '');
    if (!m) return String(hhmm || '');
    let h = parseInt(m[1], 10);
    const mm = m[2];
    const ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${mm} ${ap}`;
  }

  async function open(opts) {
    opts = opts || {};
    ensureStyles();
    const services = await loadServices();
    const staff = await loadStaff();

    // Remove any existing dialog
    const existing = document.getElementById('lbBookModal');
    if (existing) existing.remove();

    const dateStr = opts.date || new Date().toISOString().slice(0, 10);
    const startTime = opts.start_time || '10:00';
    const dt = new Date(dateStr + 'T00:00:00');
    const humanDate = dt.toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' });

    const modal = document.createElement('div');
    modal.id = 'lbBookModal';
    modal.className = 'lb-modal';
    modal.innerHTML = `
      <div class="lb-card">
        <button class="lb-close" id="lbClose">&times;</button>
        <h2 class="lb-title">New booking</h2>
        <div class="lb-when">${esc(humanDate)} at ${esc(fmtHumanTime(startTime))}</div>

        <div class="lb-field">
          <label>Client</label>
          <div class="lb-suggest">
            <input class="lb-input" id="lbClient" type="text" placeholder="Search by name or phone…" autocomplete="off">
            <div class="lb-suggest-list" id="lbSuggest"></div>
          </div>
          <div class="lb-hint">Or type a new name — we'll add them.</div>
        </div>

        <div class="lb-field">
          <label>Phone</label>
          <input class="lb-input" id="lbPhone" type="tel" placeholder="+1 305 555 1234">
        </div>

        <div class="lb-field">
          <label>Service</label>
          <select class="lb-select" id="lbService">
            ${services.length ? services.map(s => `<option value="${esc(s.id)}" data-dur="${s.duration_minutes}" data-price="${s.price_cents}">${esc(s.name)} · ${s.duration_minutes} min${s.price_cents ? ' · ' + fmt$(s.price_cents) : ''}</option>`).join('') : '<option value="">(No services configured)</option>'}
          </select>
        </div>

        <div class="lb-row">
          <div class="lb-field">
            <label>Stylist</label>
            <select class="lb-select" id="lbStaff">
              <option value="">Any</option>
              ${staff.map(s => `<option value="${esc(s.id)}"${(opts.stylist && s.name === opts.stylist) ? ' selected' : ''}>${esc(s.name)}</option>`).join('')}
            </select>
          </div>
          <div class="lb-field">
            <label>Duration</label>
            <select class="lb-select" id="lbDuration">
              <option>15</option><option>30</option><option selected>60</option><option>75</option><option>90</option><option>120</option><option>150</option><option>180</option>
            </select>
          </div>
        </div>

        <div class="lb-field">
          <label>Notes</label>
          <input class="lb-input" id="lbNotes" type="text" placeholder="Any preferences, formulas, etc.">
        </div>

        <div class="lb-actions">
          <button id="lbCancel">Cancel</button>
          <button id="lbSave" class="lb-primary">Book</button>
        </div>
        <div id="lbStatus"></div>
      </div>
    `;
    document.body.appendChild(modal);

    // Live search
    const clientInput = document.getElementById('lbClient');
    const phoneInput = document.getElementById('lbPhone');
    const suggest = document.getElementById('lbSuggest');
    let selectedClientId = null;
    let searchTimer = null;

    clientInput.addEventListener('input', () => {
      selectedClientId = null;
      const q = clientInput.value.trim();
      if (searchTimer) clearTimeout(searchTimer);
      if (!q || q.length < 2) { suggest.classList.remove('on'); return; }
      searchTimer = setTimeout(async () => {
        const rows = await searchClients(q);
        if (!rows.length) { suggest.classList.remove('on'); return; }
        suggest.innerHTML = rows.map(r => `
          <div class="lb-sg-row" data-id="${esc(r.id)}" data-name="${esc(r.name)}" data-phone="${esc(r.phone)}">
            <div class="lb-sg-name">${esc(r.name || '—')}</div>
            <div class="lb-sg-sub">${esc(r.phone || '')}</div>
          </div>
        `).join('');
        suggest.classList.add('on');
        suggest.querySelectorAll('.lb-sg-row').forEach(row => {
          row.addEventListener('click', () => {
            clientInput.value = row.dataset.name;
            phoneInput.value = row.dataset.phone;
            selectedClientId = row.dataset.id;
            suggest.classList.remove('on');
          });
        });
      }, 250);
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.lb-suggest')) suggest.classList.remove('on');
    });

    // Service change auto-updates duration
    const svcSel = document.getElementById('lbService');
    const durSel = document.getElementById('lbDuration');
    svcSel.addEventListener('change', () => {
      const opt = svcSel.selectedOptions[0];
      const dur = opt?.dataset?.dur;
      if (dur) durSel.value = dur;
    });
    // Prime duration from initially-selected service
    if (svcSel.selectedOptions[0]?.dataset?.dur) durSel.value = svcSel.selectedOptions[0].dataset.dur;

    // Close handlers
    const close = () => modal.remove();
    document.getElementById('lbClose').addEventListener('click', close);
    document.getElementById('lbCancel').addEventListener('click', close);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
    });

    // Save
    document.getElementById('lbSave').addEventListener('click', async () => {
      const btn = document.getElementById('lbSave');
      const status = document.getElementById('lbStatus');
      status.className = ''; status.textContent = '';
      const name = clientInput.value.trim();
      const phone = phoneInput.value.trim();
      const svcOpt = svcSel.selectedOptions[0];
      const stylistOpt = document.getElementById('lbStaff').selectedOptions[0];
      const durationMin = parseInt(durSel.value, 10) || 60;
      const notes = document.getElementById('lbNotes').value.trim();

      if (!name) { status.className = 'lb-status err'; status.textContent = 'Client name required'; return; }

      btn.disabled = true; btn.textContent = 'Booking…';

      const payload = {
        date: dateStr,
        start_time: startTime,
        duration_minutes: durationMin,
        service_id: svcOpt?.value || null,
        service_name: svcOpt ? svcOpt.textContent.split('·')[0].trim() : '',
        price_cents: parseInt(svcOpt?.dataset?.price || '0', 10) || 0,
        stylist_id: stylistOpt?.value || null,
        stylist_name: stylistOpt?.textContent || opts.stylist || '',
        client_id: selectedClientId,
        client_name: name,
        client_phone: phone,
        notes,
        source: 'owner_walk_in',
      };

      let saved = null;
      for (const ep of ['/api/appointments/create', '/api/appointments', '/api/calendar/create']) {
        try {
          const r = await fetch(ep, {
            method: 'POST', headers: {'Content-Type':'application/json'}, credentials: 'include',
            body: JSON.stringify(payload)
          });
          if (r.ok) { const d = await r.json(); saved = d.data || d.appointment || d; break; }
          if (r.status === 404) continue;
          const d = await r.json().catch(() => ({}));
          status.className = 'lb-status err'; status.textContent = 'Booking failed: ' + (d.error || r.status);
          btn.disabled = false; btn.textContent = 'Book';
          return;
        } catch (err) {
          status.className = 'lb-status err'; status.textContent = 'Error: ' + err.message;
          btn.disabled = false; btn.textContent = 'Book';
          return;
        }
      }

      if (!saved) {
        status.className = 'lb-status err';
        status.textContent = 'No booking endpoint responded. Add api/appointments/create.js (the installer ships one).';
        btn.disabled = false; btn.textContent = 'Retry';
        return;
      }

      status.className = 'lb-status ok';
      status.textContent = 'Booked. SMS confirmation on the way.';
      setTimeout(() => {
        close();
        if (typeof opts.onBooked === 'function') opts.onBooked(saved);
      }, 900);
    });

    // Prefill client from URL (client.html "Book" jumps here)
    const preClient = new URLSearchParams(location.search).get('book_client');
    if (preClient && opts.prefill_client) {
      clientInput.value = opts.prefill_client.name || '';
      phoneInput.value = opts.prefill_client.phone || '';
      selectedClientId = opts.prefill_client.id;
    }

    // Focus
    setTimeout(() => clientInput.focus(), 60);
  }

  global.LolaBookDialog = { open };
})(window);

// ── Auto-wire on calendar-like pages ─────────────────────
// Watches the document for clicks on empty regions of .grid-col-body
// and opens the dialog itself. Capturing listener so we intercept before
// calendar.js's own inner handler (which just nudges) runs.
(function autowire() {
  if (window.__lbAutowired) return;
  window.__lbAutowired = true;
  document.addEventListener('click', (e) => {
    const body = e.target.closest('.grid-col-body');
    if (!body) return;
    if (e.target.closest('.blk')) return; // clicked an existing appointment
    // Only capture from calendar pages that have our expected data attr.
    const dateStr = body.dataset.colDate;
    if (!dateStr) return;
    e.stopPropagation();
    e.preventDefault();
    const rect = body.getBoundingClientRect();
    const y = e.clientY - rect.top;
    // Match calendar.js constants — 8am start, 60px/hour
    const OPEN_HOUR = 8;
    const HOUR_PX = 60;
    const hour = OPEN_HOUR + Math.floor(y / HOUR_PX);
    const min = Math.round((y % HOUR_PX) / 15) * 15 % 60;
    const hh = String(hour).padStart(2, '0');
    const mm = String(min).padStart(2, '0');
    const stylist = body.parentElement?.querySelector('.grid-col-head div:last-child')?.textContent || '';
    window.LolaBookDialog.open({
      date: dateStr,
      start_time: `${hh}:${mm}`,
      stylist,
      onBooked: () => { location.reload(); }
    });
  }, /* capture */ true);
})();
