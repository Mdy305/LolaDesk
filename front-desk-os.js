/* ═══════════════════════════════════════════════════════════════
   Front Desk OS — the luxury home surface for LolaDesk.
   ════════════════════════════════════════════════════════════════
   Injected LAST by auth-guard on the dashboard so its styles win
   every tie. Turns the home into a calm, expensive front-desk
   console instead of a stack of SaaS boxes:

     · Header becomes an elegant strip — light serif greeting, and
       the KPIs as hairline-separated numerals (no cards)
     · The injected panels (revenue engine, today-with-Lola) share
       one unified luxe card language
     · Everything that competes with Lola for attention on Home is
       hidden — she is the surface; Calendar, Revenue, Clients, and
       the rest live in the sidebar
     · Live activity arrives as ONE floating notification
       (LolaNotify) — never stacked toasts

   Loaded only on the dashboard. Self-contained, idempotent.
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.LolaFrontDeskOS) return;

  function injectStyles() {
    if (document.getElementById('frontDeskOsStyles')) return;
    const s = document.createElement('style');
    s.id = 'frontDeskOsStyles';
    s.textContent = `
/* ── The header: one quiet strip, not a box grid ── */
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
.dash-greeting p{font-size:12.5px;color:rgba(255,255,255,.42);margin-top:7px;letter-spacing:.01em}
.kpi-row{
  display:flex!important;
  gap:0!important;
  grid-template-columns:none!important;
  min-width:0!important;
  width:auto!important;
  margin:0!important;
}
.kpi{
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
.kpi-val{font-size:23px;font-weight:300;letter-spacing:-.01em;margin-bottom:4px}
.kpi.accent .kpi-val{color:#ccff00;text-shadow:0 0 18px rgba(204,255,0,.35)}
.kpi-label{font-size:9.5px;text-transform:uppercase;letter-spacing:.16em;color:rgba(255,255,255,.48);font-weight:500}
.kpi-sub{display:none!important}
.kpi:hover{background:transparent!important;border-color:transparent!important}

/* ── Injected panels share one luxe card language ── */
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

/* ── Home stays about Lola; the rest lives in the sidebar ── */
.res-panel, .quick-grid, .briefing-banner, .away-panel{display:none!important}
.grid-main>.col-stack{display:none!important}

/* ── The orb hero breathes ── */
.lola-panel{
  padding:38px 28px 44px!important;
  border-color:rgba(255,255,255,.05)!important;
}
.lola-orb-stage{width:340px;height:340px}
.lola-prompt{margin-top:26px}
.lola-prompt-title{font-size:27px}

/* ── Command dock: the spotlight bar, not a box ── */
.cmd-dock{
  border-radius:999px!important;
  border:1px solid rgba(255,255,255,.08)!important;
  background:rgba(12,13,15,.82)!important;
  backdrop-filter:blur(20px);
  -webkit-backdrop-filter:blur(20px);
  box-shadow:0 18px 50px rgba(0,0,0,.45)!important;
}

/* ── Mobile: greeting only, no stat clutter ── */
@media(max-width:720px){
  .dash-header{flex-direction:column;align-items:flex-start!important;gap:6px;padding:2px 2px 14px;border-bottom:0}
  .kpi-row{display:none!important}
  .lola-orb-stage{width:min(78vw,300px);height:min(78vw,300px)}
}
@media(prefers-reduced-motion:reduce){
  .dash-header,.kpi,.lola-panel,.cmd-dock{transition:none!important;animation:none!important}
}
`;
    document.head.appendChild(s);
  }

  function boot() {
    injectStyles();
  }

  window.LolaFrontDeskOS = { boot };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
