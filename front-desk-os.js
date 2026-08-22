/* ═══════════════════════════════════════════════════════════════
   Front Desk OS — the luxury design language for ALL of LolaDesk.
   ════════════════════════════════════════════════════════════════
   Injected by auth-guard on every authenticated page, LAST, so its
   styles win every tie. One OS, not a template:

     · Page headers become quiet strips — small-caps eyebrow, light
       serif title, hairline rule
     · Every KPI reads as hairline-separated numerals — no boxes
     · Cards, buttons, inputs, pills, rows, and empty states share
       one glass language (gradient, hairline, 20px radius)
     · The sidebar's active state is a single lime hairline
     · On sub-pages, Lola is present as a quiet glass pill — she
       pulses when the ONE notification (LolaNotify) fires, and one
       tap returns you to her front desk
     · The dashboard home stays the hero surface: orb first, then
       the day's work

   Self-contained, idempotent, reduced-motion aware.
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.LolaFrontDeskOS) return;

  function isDashboard() {
    const page = document.body && document.body.dataset ? document.body.dataset.page : '';
    return !page || page === 'dashboard' || !!document.querySelector('.lola-orb-zone, .lola-panel');
  }

  function injectStyles() {
    if (document.getElementById('frontDeskOsStyles')) return;
    const s = document.createElement('style');
    s.id = 'frontDeskOsStyles';
    s.textContent = `
/* ══════════ 1 · PAGE HEADER — one quiet strip ══════════ */
.topbar{
  display:flex!important;
  align-items:flex-end!important;
  justify-content:space-between!important;
  gap:24px;
  padding:8px 2px 20px;
  margin:0 0 12px!important;
  border-bottom:1px solid rgba(255,255,255,.055);
}
.fdo-eyebrow{
  font-size:9.5px;
  letter-spacing:.26em;
  text-transform:uppercase;
  color:rgba(204,255,0,.75);
  margin-bottom:8px;
  font-weight:500;
}
.page-title, .head h1, .head-title{
  font-size:clamp(24px,3vw,34px)!important;
  font-weight:300!important;
  font-style:italic;
  letter-spacing:-.015em;
  color:#f6f6f8;
  line-height:1.1;
}
.page-sub, .head-sub{
  font-size:12.5px;
  color:rgba(255,255,255,.42);
  margin-top:7px;
  letter-spacing:.01em;
}
.head-tag{color:rgba(204,255,0,.75)!important;letter-spacing:.22em!important}
.topbar-actions .btn{border-radius:999px!important}

/* ══════════ 2 · KPI — hairline numerals, no boxes ══════════ */
.kpis, .kpi-row{
  display:flex!important;
  gap:0!important;
  grid-template-columns:none!important;
  width:100%!important;
  min-width:0!important;
  margin:0 0 22px!important;
}
.kpis .kpi, .kpi-row .kpi, .kpi{
  background:transparent!important;
  border:0!important;
  border-left:1px solid rgba(255,255,255,.08)!important;
  border-radius:0!important;
  box-shadow:none!important;
  padding:2px 22px!important;
  min-width:0!important;
  text-align:right;
  cursor:default;
}
.kpi:first-child{border-left:0!important}
.kpi-val{
  font-size:23px;
  font-weight:300;
  letter-spacing:-.01em;
  margin-bottom:4px;
  text-shadow:none!important;
}
.kpi-label{
  font-size:9.5px!important;
  text-transform:uppercase;
  letter-spacing:.16em;
  color:rgba(255,255,255,.48);
  font-weight:500;
}
.kpi-sub{
  font-size:10.5px!important;
  color:rgba(255,255,255,.3)!important;
  margin-top:3px;
}
.kpi-val.pink, .kpi.accent .kpi-val{color:#ccff00!important;text-shadow:0 0 18px rgba(204,255,0,.35)!important}
.kpi:hover{background:transparent!important;border-color:transparent!important;transform:none!important}

/* ══════════ 3 · CARD LANGUAGE ══════════ */
.card{
  background:linear-gradient(180deg,rgba(255,255,255,.03),rgba(204,255,0,.02))!important;
  border:1px solid rgba(255,255,255,.07)!important;
  border-radius:20px!important;
  box-shadow:0 22px 60px rgba(0,0,0,.28)!important;
}
.card-head{border-bottom:1px solid rgba(255,255,255,.06)!important}
.card-title{
  font-size:10.5px!important;
  letter-spacing:.16em!important;
  text-transform:uppercase!important;
  color:rgba(255,255,255,.5)!important;
  font-weight:600;
}

/* ══════════ 4 · CONTROLS ══════════ */
.btn{border-radius:999px!important;font-weight:600}
.btn-primary{background:#ccff00!important;color:#070708!important;border:0!important}
.btn-primary:hover{background:#dcff66!important}
.btn-ghost{background:transparent!important;border:1px solid rgba(255,255,255,.12)!important;color:rgba(255,255,255,.75)!important}
.btn-ghost:hover{background:rgba(255,255,255,.05)!important}
input[type="text"],input[type="tel"],input[type="email"],input[type="number"],input[type="search"],input[type="password"],input[type="date"],select,textarea{
  background:rgba(255,255,255,.04)!important;
  border:1px solid rgba(255,255,255,.09)!important;
  border-radius:12px!important;
  color:#f4f4f5!important;
  font:inherit!important;
  padding:10px 13px!important;
  outline:none!important;
}
input:focus,select:focus,textarea:focus{
  border-color:rgba(204,255,0,.45)!important;
  box-shadow:0 0 0 3px rgba(204,255,0,.07)!important;
}
.fld label{font-size:9.5px!important;letter-spacing:.16em!important;text-transform:uppercase!important;color:rgba(255,255,255,.45)!important}
.switch,.toggle-row{border-radius:14px!important;background:rgba(255,255,255,.03)!important;border:1px solid rgba(255,255,255,.07)!important}

/* pills / tags / chips */
.pill,.tag,.desk-tag,.num-feat,.status-pill,span[class*="pill"]{
  border-radius:999px!important;
  background:rgba(255,255,255,.06)!important;
  border:1px solid rgba(255,255,255,.07)!important;
  color:rgba(255,255,255,.65)!important;
}

/* ══════════ 5 · ROWS & LISTS ══════════ */
.call-row,.thread,.svc-row,.row-item,.num-card,.review-item,.inbox-row{
  border-color:rgba(255,255,255,.06)!important;
}
.call-row:hover,.thread:hover,.thread.active{background:rgba(255,255,255,.035)!important}

/* ══════════ 6 · EMPTY STATES ══════════ */
.empty,.empty-cal,.tenant-empty{
  padding:34px 22px!important;
  text-align:center;
  color:rgba(255,255,255,.45)!important;
  font-size:12.5px;
  border:1px dashed rgba(255,255,255,.1);
  border-radius:16px;
  background:rgba(255,255,255,.015);
}

/* ══════════ 7 · SIDEBAR — one lime hairline ══════════ */
.nav-item.active{background:rgba(204,255,0,.06)!important;color:#fff!important}
.nav-item.active::before{background:#ccff00!important;box-shadow:0 0 14px rgba(204,255,0,.6)!important}
.nav-user-av,.chat-modal-orb,.mb-orb,.detail-orb{background:linear-gradient(135deg,#ccff00,#7fb300)!important}

/* ══════════ 8 · MOBILE SHELL ══════════ */
#tenantMobileHeader{
  backdrop-filter:blur(20px)!important;
  -webkit-backdrop-filter:blur(20px)!important;
  background:rgba(8,9,10,.85)!important;
  border-bottom:1px solid rgba(255,255,255,.06)!important;
}
.mobile-bar{backdrop-filter:blur(20px)!important;-webkit-backdrop-filter:blur(20px)!important;background:rgba(8,9,10,.88)!important;border-top:1px solid rgba(255,255,255,.06)!important}

/* ══════════ 9 · LOLA PRESENCE PILL (sub-pages) ══════════ */
#lolaPresencePill{
  position:fixed;
  left:18px;
  bottom:18px;
  z-index:99990;
  display:flex;
  align-items:center;
  gap:9px;
  padding:10px 16px 10px 13px;
  border-radius:999px;
  border:1px solid rgba(204,255,0,.2);
  background:linear-gradient(180deg,rgba(16,17,20,.92),rgba(10,11,13,.95));
  backdrop-filter:blur(20px);
  -webkit-backdrop-filter:blur(20px);
  color:#f2f2f5;
  font:600 12px -apple-system,BlinkMacSystemFont,"SF Pro Display",sans-serif;
  letter-spacing:.02em;
  cursor:pointer;
  box-shadow:0 14px 44px rgba(0,0,0,.45),0 0 24px rgba(204,255,0,.06);
  transition:transform .18s cubic-bezier(.22,1,.36,1),box-shadow .18s;
}
#lolaPresencePill:hover{transform:translateY(-2px);box-shadow:0 18px 50px rgba(0,0,0,.5),0 0 30px rgba(204,255,0,.12)}
#lolaPresencePill .lpp-dot{
  width:8px;height:8px;border-radius:50%;
  background:#ccff00;
  box-shadow:0 0 12px rgba(204,255,0,.8);
  animation:lolaPillBreathe 2.2s ease-in-out infinite;
}
#lolaPresencePill.active .lpp-dot{animation:lolaPillPulse .6s ease-in-out 3}
#lolaPresencePill .lpp-name{color:#fff}
#lolaPresencePill .lpp-hint{color:rgba(255,255,255,.4);font-weight:400;font-size:10.5px}
@keyframes lolaPillBreathe{0%,100%{transform:scale(1);opacity:.85}50%{transform:scale(1.35);opacity:1}}
@keyframes lolaPillPulse{0%,100%{transform:scale(1)}50%{transform:scale(1.8);opacity:.7}}

/* ══════════ 10 · DASHBOARD HOME (hero surface) ══════════ */
.dash-header{
  display:flex!important;
  align-items:flex-end!important;
  justify-content:space-between!important;
  gap:28px;
  padding:6px 2px 20px;
  margin:0 0 6px!important;
  border-bottom:1px solid rgba(255,255,255,.055);
}
.dash-greeting h1{
  font-size:clamp(24px,3.2vw,36px);
  font-weight:300;
  font-style:italic;
  letter-spacing:-.015em;
  color:#f6f6f8;
  line-height:1.12;
}
.dash-greeting p{font-size:12.5px;color:rgba(255,255,255,.42);margin-top:7px}
#revenueOpportunityPanel, #dailyActionCenter{
  background:linear-gradient(180deg,rgba(255,255,255,.03),rgba(204,255,0,.022))!important;
  border:1px solid rgba(255,255,255,.07)!important;
  border-radius:22px!important;
  box-shadow:0 22px 60px rgba(0,0,0,.32)!important;
  max-width:820px!important;
  margin-left:auto!important;
  margin-right:auto!important;
  overflow:hidden;
}
#revenueOpportunityPanel{margin-bottom:14px!important}
#dailyActionCenter{margin-bottom:20px!important}
.res-panel, .quick-grid, .briefing-banner, .away-panel{display:none!important}
.grid-main>.col-stack{display:none!important}
.lola-panel{
  padding:38px 28px 44px!important;
  border-color:rgba(255,255,255,.05)!important;
}
.lola-orb-stage{width:340px;height:340px}
.lola-prompt{margin-top:26px}
.lola-prompt-title{font-size:27px}
.cmd-dock{
  border-radius:999px!important;
  border:1px solid rgba(255,255,255,.08)!important;
  background:rgba(12,13,15,.82)!important;
  backdrop-filter:blur(20px);
  -webkit-backdrop-filter:blur(20px);
  box-shadow:0 18px 50px rgba(0,0,0,.45)!important;
}

/* ══════════ 11 · RESPONSIVE ══════════ */
@media(max-width:720px){
  .topbar{flex-direction:column;align-items:flex-start!important;gap:4px;padding:2px 2px 14px;border-bottom:0}
  .kpis,.kpi-row{display:none!important}
  .dash-header{flex-direction:column;align-items:flex-start!important;gap:6px;padding:2px 2px 14px;border-bottom:0}
  .kpi-row{display:none!important}
  .lola-orb-stage{width:min(78vw,300px);height:min(78vw,300px)}
  #lolaPresencePill{left:14px;bottom:86px}
}
@media(prefers-reduced-motion:reduce){
  #lolaPresencePill,.lola-presence-particle,.kpi,.card,.topbar,.lola-orb-stage,.cmd-dock,.lola-name{
    transition:none!important;animation:none!important;
  }
}
`;
    document.head.appendChild(s);
  }

  function injectEyebrow() {
    if (isDashboard()) return;
    document.querySelectorAll('.page-head').forEach((head) => {
      const title = head.querySelector('.page-title, h1');
      if (!title || head.querySelector('.fdo-eyebrow')) return;
      const raw = document.body.dataset.page || '';
      const label = (raw.replace(/[-_]/g, ' ') || 'LolaDesk').toUpperCase();
      const eyebrow = document.createElement('div');
      eyebrow.className = 'fdo-eyebrow';
      eyebrow.textContent = label + ' · TODAY WITH LOLA';
      head.insertBefore(eyebrow, title);
    });
  }

  function mountLolaPill() {
    if (isDashboard() || document.getElementById('lolaPresencePill')) return;
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.id = 'lolaPresencePill';
    pill.setAttribute('aria-label', 'Lola — open your front desk');
    pill.innerHTML = '<span class="lpp-dot"></span><span class="lpp-name">Lola</span><span class="lpp-hint">Front desk is on</span>';
    pill.addEventListener('click', () => { location.href = 'dashboard.html'; });
    document.body.appendChild(pill);
  }

  function wireNotificationPulse() {
    if (isDashboard() || !window.LolaNotify || window.LolaNotify.__pulseWired) return;
    const original = window.LolaNotify.show.bind(window.LolaNotify);
    window.LolaNotify.__pulseWired = true;
    window.LolaNotify.show = function (opts) {
      const pill = document.getElementById('lolaPresencePill');
      if (pill) {
        pill.classList.remove('active');
        void pill.offsetWidth; // restart animation
        pill.classList.add('active');
        setTimeout(() => pill.classList.remove('active'), 2200);
      }
      return original(opts);
    };
  }

  function boot() {
    injectStyles();
    if (isDashboard()) return;
    injectEyebrow();
    mountLolaPill();
    wireNotificationPulse();
  }

  window.LolaFrontDeskOS = { boot };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
