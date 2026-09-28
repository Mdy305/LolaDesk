/* ============================================================
   CALENDAR — day agenda, with Lola alive in the corner
   Lola's body is lola-stage.js; her conversation is lola-everywhere.js.
   This file renders the day, keeps it live (quiet refresh), tells
   Lola which bookings are new, and lets you say "Lola" to talk.
   ============================================================ */

(function () {
  'use strict';

  // ── Date helpers ─────────────────────────────────────────
  const state = { offset: 0 }; // days from today

  function activeDate() {
    const d = new Date();
    d.setDate(d.getDate() + state.offset);
    return d;
  }
  function isoDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  function fmtLong(d) {
    return d.toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric'
    });
  }
  function labelFor(d) {
    const today = new Date(); today.setHours(0,0,0,0);
    const tgt = new Date(d); tgt.setHours(0,0,0,0);
    const diff = Math.round((tgt - today) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Tomorrow';
    if (diff === -1) return 'Yesterday';
    return d.toLocaleDateString('en-US', { weekday: 'long' });
  }

  function mountNewBooking() {
    const nav = document.querySelector('.day-nav');
    if (!nav || document.getElementById('navNewBooking')) return;
    const b = document.createElement('button');
    b.id = 'navNewBooking'; b.className = 'day-nav-btn day-nav-new'; b.textContent = '+ New booking';
    b.style.marginLeft = 'auto';
    b.onclick = () => {
      if (!window.LolaBookDialog) { alert('Booking dialog is still loading — try again in a second.'); return; }
      window.LolaBookDialog.open({ date: isoDate(activeDate()), onBooked: () => loadAgenda() });
    };
    nav.appendChild(b);
  }
  document.addEventListener('DOMContentLoaded', mountNewBooking);
  setTimeout(mountNewBooking, 0);

  function renderHead() {
    const d = activeDate();
    document.querySelector('.day-label').textContent = labelFor(d);
    document.getElementById('dayDate').textContent = fmtLong(d);
    document.getElementById('navToday').style.display = state.offset === 0 ? 'none' : '';
  }

  // ── Agenda fetch ─────────────────────────────────────────
  const seen = new Map();          // date -> Set of booking ids already on screen
  let lastSig = '';
  async function loadAgenda(opts = {}) {
    const el = document.getElementById('dayAgenda');
    const quiet = !!opts.quiet;
    if (!quiet) { el.innerHTML = '<div class="day-loading">Loading&hellip;</div>'; lastSig = ''; }
    const dateStr = isoDate(activeDate());
    try {
      const r = await fetch(`/api/calendar?date=${dateStr}`, { credentials: 'include' });
      if (!r.ok) {
        if (r.status === 401) { location.href = '/login?next=%2Fcalendar.html'; return; }
        throw new Error('load');
      }
      const data = await r.json();
      state.tz = data.timezone || state.tz || undefined;
      const rows = (Array.isArray(data) ? data
        : (data.bookings || data.appointments || data.rows || data.data || []))
        .filter(b => !/^cancel/i.test(String(b.status || '')));
      if (dateStr !== isoDate(activeDate())) return;          // the owner moved to another day meanwhile
      const sig = JSON.stringify(rows.map(r => [r.id, r.start_time || r.starts_at, r.status, r.client_id, r.service_id, r.staff_id]));
      if (quiet && sig === lastSig) return;                    // nothing changed: don't touch the page
      lastSig = sig;
      if (!rows.length) renderEmpty(el, dateStr); else renderAgenda(el, rows);
      // Tell Lola which bookings are new, so she can greet them.
      const had = seen.get(dateStr);
      const now = Date.now();
      const fresh = rows.filter(r => r.id && (had ? !had.has(String(r.id))
        : (Date.parse(r.created_at || '') > now - 3 * 60e3))).map(r => String(r.id));
      seen.set(dateStr, new Set(rows.map(r => String(r.id))));
      window.dispatchEvent(new CustomEvent('lola:agenda', { detail: { date: dateStr, rows, fresh } }));
    } catch {
      if (!quiet) renderEmpty(el, dateStr);
    }
  }

  function renderEmpty(el, dateStr) {
    const isToday = dateStr === isoDate(new Date());
    el.innerHTML = `<div class="day-empty">${
      isToday ? 'Nothing on today. Lola is watching the phones.'
              : 'Nothing on this day yet.'
    }</div>`;
  }

  function renderAgenda(el, rows) {
    const sorted = rows.slice().sort((a, b) => timeVal(a) - timeVal(b));
    el.innerHTML = sorted.map(r => {
      const t = fmtLocal(r.start_time || r.starts_at || r.time || '');
      const name = (r.client && (r.client.name || [r.client.first_name, r.client.last_name].filter(Boolean).join(' ')))
        || r.client_name || 'Client';
      const svc = (r.service && typeof r.service === 'object' ? r.service.name : r.service) || r.service_name || '';
      const sty = (r.staff && typeof r.staff === 'object' ? r.staff.name : r.stylist) || r.stylist_name || '';
      const st = String(r.status || '').toLowerCase();
      return `
        <div class="appt${st === 'no-show' || st === 'no_show' ? ' appt-noshow' : ''}" data-booking-id="${escapeHtml(r.id || '')}" data-start="${escapeHtml(r.start_time || r.starts_at || '')}">
          <div class="appt-time">${escapeHtml(t)}</div>
          <div class="appt-body">
            <div class="appt-name">${escapeHtml(name)}</div>
            <div class="appt-service">${escapeHtml(svc)}</div>
          </div>
          <div class="appt-stylist">${escapeHtml(sty)}</div>
        </div>
      `;
    }).join('');
  }

  function timeVal(r) {
    const iso = r.start_time || r.starts_at;
    if (iso && !isNaN(new Date(iso))) return new Date(iso).getTime();
    const t = String(r.time || '');
    const m = /(\d{1,2}):(\d{2})/.exec(t);
    return m ? parseInt(m[1],10) * 60 + parseInt(m[2],10) : 9999;
  }
  function fmtLocal(v) {
    const d = new Date(v);
    if (!v || isNaN(d)) return fmtTime(v);
    try { return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: state.tz }); }
    catch (_) { return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); }
  }
  function fmtTime(v) {
    const m = /(\d{1,2}):(\d{2})/.exec(String(v || ''));
    if (!m) return '';
    let h = parseInt(m[1], 10);
    const mm = m[2];
    const ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${mm} ${ap}`;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

  // ── Nav ───────────────────────────────────────────────────
  document.getElementById('navPrev').addEventListener('click', () => {
    state.offset -= 1; renderHead(); loadAgenda();
  });
  document.getElementById('navNext').addEventListener('click', () => {
    state.offset += 1; renderHead(); loadAgenda();
  });
  document.getElementById('navToday').addEventListener('click', () => {
    state.offset = 0; renderHead(); loadAgenda();
  });

  renderHead();
  loadAgenda();

  // ── Keep the day live: quiet refresh while the page is visible ──
  setInterval(() => {
    if (document.hidden || document.querySelector('.lb-modal')) return;
    loadAgenda({ quiet: true });
  }, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadAgenda({ quiet: true }); });

  // Lola (lola-everywhere.js) refreshes the day in place after she books,
  // moves or cancels — no page reload, the conversation stays open.
  window.LolaCalendar = {
    reload: () => loadAgenda({ quiet: true }),
    get date() { return isoDate(activeDate()); },
  };

  // ── Say "Lola" to talk (armed after your first tap; browsers require it) ──
  let wake = null, panelOpen = false;
  function armWake() {
    const R = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!R || wake || panelOpen || document.hidden) return;
    try {
      wake = new R();
      wake.lang = 'en-US'; wake.continuous = true; wake.interimResults = true;
      wake.onresult = (e) => {
        for (let i = e.resultIndex; i < e.results.length; i++) {
          if (/\blola\b/i.test(e.results[i][0].transcript) && window.LolaEverywhere && window.LolaEverywhere.listen) {
            const w = wake; wake = null; try { w.onend = null; w.stop(); } catch (_) {}
            setTimeout(() => window.LolaEverywhere.listen(), 250);
            return;
          }
        }
      };
      wake.onend = () => { wake = null; if (!panelOpen) setTimeout(armWake, 800); };
      wake.onerror = (e) => { const w = wake; wake = null; if (e && /not-allowed|service-not-allowed/.test(e.error)) { document.removeEventListener('click', armWake); } else if (w && !panelOpen) setTimeout(armWake, 2000); };
      wake.start();
    } catch (_) { wake = null; }
  }
  function stopWake() { const w = wake; wake = null; if (w) { try { w.onend = null; w.stop(); } catch (_) {} } }
  addEventListener('lola:panel-open', () => { panelOpen = true; stopWake(); });
  addEventListener('lola:panel-close', () => { panelOpen = false; setTimeout(armWake, 1200); });
  document.addEventListener('click', armWake, { once: true });
})();
