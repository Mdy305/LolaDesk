/* ═══════════════════════════════════════════════════════════════
   LolaDesk — booking-ready.js: "Your booking page", one calm card.
   ════════════════════════════════════════════════════════════════
   For a salon with no booking software: the five things clients (and
   Lola) need before real times show up — hours, services, team, team
   hours, online booking on. One line each, a check when done, one tap to
   the page that fixes it. When everything is done: the salon's booking
   link with Copy + Open.

   Reads GET /api/booking-settings?action=readiness (owner session).
   Mounts into every [data-booking-ready]:
     data-mode="setup"  → shown only while NOT ready (dashboard); gone when ready
     (default)          → always shown (settings → Booking)
   Colors come from app.css tokens, so it follows the page's theme.
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.__bookingReady) return; window.__bookingReady = true;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  async function token() {
    try { const a = window.LolaAuth && window.LolaAuth.ready ? await window.LolaAuth.ready : null; if (a && a.token) return a.token; } catch (_) {}
    try { return localStorage.getItem('loladesk_token') || ''; } catch (_) { return ''; }
  }
  async function role() {
    try { const a = window.LolaAuth && window.LolaAuth.ready ? await window.LolaAuth.ready : null; return String((a && a.role) || 'owner').toLowerCase(); } catch (_) { return 'owner'; }
  }

  function css() {
    if (document.getElementById('bkr-css')) return;
    const s = document.createElement('style'); s.id = 'bkr-css';
    s.textContent = `
.bkr{background:var(--surface);border:.5px solid var(--border);border-radius:var(--r-lg,20px);padding:20px 20px 8px;margin:0 0 16px;color:var(--text);min-width:0}
.bkr.bare{background:transparent;border:0;padding:0;margin:0}
.bkr-h{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.bkr-h b{font-size:16px;font-weight:600;letter-spacing:-.01em}
.bkr-h span{font-size:12px;color:var(--text3);font-variant-numeric:tabular-nums;white-space:nowrap}
.bkr-sub{font-size:12.5px;color:var(--text2);margin:4px 0 10px;line-height:1.5}
.bkr-row{display:grid;grid-template-columns:22px minmax(0,1fr) auto;gap:12px;align-items:center;padding:12px 0;border-top:.5px solid var(--border);color:inherit;text-decoration:none;min-height:44px}
.bkr-row:hover .bkr-go{color:var(--text)}
.bkr-dot{width:20px;height:20px;border-radius:50%;border:1.5px solid var(--border2,var(--border));display:grid;place-items:center;font-size:11px;line-height:1}
.bkr-row.done .bkr-dot{background:var(--text);border-color:var(--text);color:var(--bg)}
.bkr-t{font-size:13.5px;font-weight:500;min-width:0;overflow-wrap:anywhere}
.bkr-row.done .bkr-t{color:var(--text2);font-weight:400}
.bkr-d{display:block;font-size:12px;color:var(--text3);font-weight:400;margin-top:1px}
.bkr-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.bkr-go{color:var(--text3);font-size:12.5px;white-space:nowrap}
.bkr-live{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text2);margin:6px 0 12px}
.bkr-live i{width:8px;height:8px;border-radius:50%;background:var(--accent);flex:0 0 8px}
.bkr-link{display:flex;gap:8px;align-items:center;flex-wrap:wrap;background:var(--bg2);border:.5px solid var(--border);border-radius:var(--r-sm,10px);padding:10px 12px;margin-bottom:12px}
.bkr-url{flex:1 1 180px;min-width:0;font-family:ui-monospace,monospace;font-size:12px;color:var(--text2);overflow-wrap:anywhere}
.bkr-btn{background:transparent;border:.5px solid var(--border);border-radius:8px;padding:7px 12px;color:var(--text2);font:inherit;font-size:12px;cursor:pointer;text-decoration:none;white-space:nowrap}
.bkr-btn:hover{color:var(--text);border-color:var(--text3)}
@media (max-width:480px){.bkr{padding:16px 16px 6px}}`;
    document.head.appendChild(s);
  }

  function view(d) {
    const steps = Array.isArray(d.steps) ? d.steps : [];
    const done = steps.filter((s) => s.done).length;
    const head = `<div class="bkr-h"><b>Your booking page</b><span>${d.ready ? 'Live' : `${done} of ${steps.length}`}</span></div>`;
    if (d.live_system) {
      return `<div class="bkr-h"><b>Your booking page</b><span>Live</span></div>
        <div class="bkr-live"><i aria-hidden="true"></i>Lola checks and books in ${esc(d.live_system)} — every booking lands there and on your LolaDesk calendar.</div>`;
    }
    if (d.ready) {
      return `${head}
        <div class="bkr-live"><i aria-hidden="true"></i>Clients can book you online — Lola offers the same times.</div>
        <div class="bkr-link"><span class="bkr-url" data-bkr-url>${esc(d.booking_url)}</span>
          <button type="button" class="bkr-btn" data-bkr-copy>Copy</button>
          <a class="bkr-btn" href="${esc(d.booking_url)}" target="_blank" rel="noopener">Open</a></div>`;
    }
    return `${head}
      <p class="bkr-sub">A few things and clients can book you online — Lola books the same times.</p>
      ${steps.map((s) => `<a class="bkr-row${s.done ? ' done' : ''}" href="${esc(s.href)}">
        <span class="bkr-dot" aria-hidden="true">${s.done ? '✓' : ''}</span>
        <span class="bkr-t">${esc(s.label)}${s.detail ? `<span class="bkr-d">${esc(s.detail)}</span>` : ''}<span class="bkr-sr">${s.done ? ' — done' : ' — to do'}</span></span>
        <span class="bkr-go" aria-hidden="true">${s.done ? '' : 'Set up ›'}</span></a>`).join('')}`;
  }

  async function render(host) {
    const setupOnly = host.getAttribute('data-mode') === 'setup';
    if (setupOnly && !['owner', 'admin', 'manager'].includes(await role())) { host.innerHTML = ''; return; }
    let d = null;
    try {
      const t = await token();
      const r = await fetch('/api/booking-settings?action=readiness', { headers: t ? { Authorization: 'Bearer ' + t } : {}, cache: 'no-store' });
      d = r.ok ? await r.json() : null;
    } catch (_) { d = null; }
    if (!d || d.ok === false) { if (setupOnly) { host.innerHTML = ''; host.hidden = true; } return; }   // settings keeps its plain link
    if (setupOnly && d.ready) { host.innerHTML = ''; host.hidden = true; return; }
    css();
    host.hidden = false;
    const bare = host.hasAttribute('data-bare');
    host.innerHTML = `<section class="bkr${bare ? ' bare' : ''}" aria-label="Your booking page">${view(d)}</section>`;
    const btn = host.querySelector('[data-bkr-copy]');
    if (btn) btn.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(d.booking_url); btn.textContent = 'Copied'; }
      catch (_) { const u = host.querySelector('[data-bkr-url]'); if (u) { const sel = getSelection(); const rg = document.createRange(); rg.selectNodeContents(u); sel.removeAllRanges(); sel.addRange(rg); } btn.textContent = 'Press ⌘C'; }
      setTimeout(() => { btn.textContent = 'Copy'; }, 1600);
    });
  }

  function mount() {
    const hosts = document.querySelectorAll('[data-booking-ready]');
    hosts.forEach((h) => render(h));
    // Coming back from Services / Team / hours in another tab → fresh state.
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') hosts.forEach((h) => render(h)); });
  }
  window.refreshBookingReady = () => document.querySelectorAll('[data-booking-ready]').forEach((h) => render(h));
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
