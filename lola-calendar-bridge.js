/* LolaDesk — connects the Calendar (bookings.html) to Lola.
 *
 *  · After every render, tells Lola's stage which bookings are new, so her
 *    particles fly out and frame them (a booking Lola made on the phone, one
 *    from the widget, or yours).
 *  · Keeps the calendar live: a quiet check every 30s (and when you come back
 *    to the tab) that only redraws when something actually changed.
 *  · window.LolaCalendar.reload() lets Lola refresh the calendar in place
 *    after she books, moves or cancels — no page reload.
 *  · Say "Lola" (after your first tap on the page) to open her and talk.
 * Reads the page's own globals (load, render, STATE, VIEW, cursor, isoDay).
 */
(function () {
  if (window.LolaCalendar) return;
  if (typeof load !== 'function' || typeof render !== 'function' || typeof STATE === 'undefined') return;

  // The view switch always started on "Week" even when the saved view was Day or Agenda.
  try { document.querySelectorAll('#viewSwitch button').forEach(b => b.classList.toggle('on', b.dataset.v === VIEW)); } catch (_) {}

  // ── new-booking detection ──
  const seen = new Set();
  let primed = false;
  function afterRender() {
    let list = [];
    try { list = (STATE.bookings || []).filter(b => b && b.id && b.status !== 'cancelled'); } catch (_) { return; }
    const now = Date.now();
    const fresh = list.filter(b => primed ? !seen.has(String(b.id)) : Date.parse(b.created_at || '') > now - 3 * 60e3).map(b => String(b.id));
    list.forEach(b => seen.add(String(b.id)));
    primed = true;
    window.dispatchEvent(new CustomEvent('lola:agenda', { detail: { rows: list, fresh } }));
  }
  const origRender = window.render;
  window.render = function () { const out = origRender.apply(this, arguments); try { afterRender(); } catch (_) {} return out; };
  try { if (STATE.bookings && STATE.bookings.length) afterRender(); } catch (_) {}

  // ── quiet live refresh ──
  const sig = (arr) => JSON.stringify((arr || []).map(b => [b.id, b.start_time, b.end_time, b.status, b.staff_id, b.service_id]));
  function currentUrl() {
    try {
      if (VIEW === 'week') {
        const start = new Date(cursor); start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); start.setHours(0, 0, 0, 0);
        return '/api/calendar?action=week&date=' + isoDay(start) + '&days=7';
      }
      return '/api/calendar?action=day&date=' + isoDay(cursor);
    } catch (_) { return null; }
  }
  let busy = false;
  async function quietCheck() {
    if (busy || document.hidden || document.querySelector('.mw.open')) return;
    const url = currentUrl(); if (!url) return;
    busy = true;
    try {
      const tok = (window.LolaAuth && window.LolaAuth.token) || localStorage.getItem('loladesk_token') || '';
      const r = await fetch(url, { headers: { Authorization: 'Bearer ' + tok } });
      if (!r.ok) return;
      const d = await r.json();
      if (d && d.ok && url === currentUrl() && sig(d.bookings) !== sig(STATE.bookings)) await load();
    } catch (_) { /* offline: try again next tick */ } finally { busy = false; }
  }
  setInterval(quietCheck, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) quietCheck(); });

  window.LolaCalendar = { reload: () => load() };

  // ── say "Lola" to talk ──
  let wake = null, panelOpen = false;
  function armWake() {
    const R = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!R || wake || panelOpen || document.hidden) return;
    try {
      wake = new R(); wake.lang = 'en-US'; wake.continuous = true; wake.interimResults = true;
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
      wake.onerror = (e) => { const w = wake; wake = null; if (!(e && /not-allowed|service-not-allowed/.test(e.error)) && w && !panelOpen) setTimeout(armWake, 2000); };
      wake.start();
    } catch (_) { wake = null; }
  }
  function stopWake() { const w = wake; wake = null; if (w) { try { w.onend = null; w.stop(); } catch (_) {} } }
  addEventListener('lola:panel-open', () => { panelOpen = true; stopWake(); });
  addEventListener('lola:panel-close', () => { panelOpen = false; setTimeout(armWake, 1200); });
  document.addEventListener('click', armWake, { once: true });
})();
