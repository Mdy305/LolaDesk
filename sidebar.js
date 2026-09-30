/* ═══════════════════════════════════════════════════════════════
   LolaDesk — the ONE navigation.
   ════════════════════════════════════════════════════════════════
   Four places, nothing else:

     Now       what's happening — today, inbox, calls, operations, Lola Brain
     Calendar  the book — schedule, services, checkout, inventory
     Growth    filling the chairs — campaigns, marketer, opportunities,
               revenue, reviews, banking
     Clients   the people

   Settings, Teach Lola, Activate Lola, launch checklist, team, billing
   and phone numbers live behind the owner's name at the bottom.

   Desktop: a quiet sidebar. The active place shows its pages beneath
   it; the others stay closed.
   Phone:   a bottom bar — Now · Calendar · Lola · Growth · Clients —
   and a slim top strip with the current place's pages and the owner.

   This file replaced three navigations that disagreed with each other
   (sidebar.js, dashboard.html's own sidebar, and two different mobile
   bars) plus tenant-workspace's mobile hamburger. It renders its own
   DOM and its own scoped styles, so it looks identical on every page
   regardless of which page stylesheet is loaded.

   <script src="/sidebar.js"></script>                 app pages
   <script src="/sidebar.js" data-shell="bare"></script> pages that
     must not pick up product-reset.css / ux-runtime (dashboard,
     revenue).
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.LolaNav) return;

  const script = document.currentScript;
  const bare = !!(script && script.dataset && script.dataset.shell === 'bare');

  // Page runtime the app pages have always loaded through this file.
  if (!bare) {
    const has = (sel) => !!document.querySelector(sel);
    if (!has('link[href$="ux-runtime.css"]')) { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '/ux-runtime.css'; document.head.appendChild(l); }
    if (!has('link[href$="product-reset.css"]')) { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '/product-reset.css'; document.head.appendChild(l); }
    if (!has('script[src$="ux-runtime.js"]')) { const s = document.createElement('script'); s.src = '/ux-runtime.js'; s.defer = true; document.head.appendChild(s); }
  }

  // ── The map ─────────────────────────────────────────────────
  const I = {
    now: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
    calendar: '<rect x="3" y="4.5" width="18" height="16.5" rx="2.5"/><path d="M3 9.5h18M8 3v3M16 3v3"/>',
    growth: '<path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/>',
    clients: '<circle cx="9" cy="7.5" r="3.2"/><path d="M3 20.5v-.5a5.5 5.5 0 015.5-5.5h1a5.5 5.5 0 015.5 5.5v.5M16 4a3.2 3.2 0 010 6.4M21 20.5V20a5 5 0 00-3-4.6"/>',
    chevron: '<path d="M7 10l5 5 5-5"/>',
  };

  const TABS = [
    { id: 'now', label: 'Now', href: '/dashboard',
      subs: [{ label: 'Today', href: '/dashboard', pages: ['dashboard', ''] },
             { label: 'Inbox', href: '/inbox', pages: ['inbox'] },
             { label: 'Calls', href: '/calls', pages: ['calls', 'call-center', 'lola-live'] },
             { label: 'Operations', href: '/operations-os', pages: ['operations-os', 'operator'] },
             { label: 'Lola Brain', href: '/brain-os', pages: ['brain-os'], manager: true }],
      pages: [] },
    { id: 'calendar', label: 'Calendar', href: '/bookings',
      subs: [{ label: 'Schedule', href: '/bookings', pages: ['bookings', 'calendar', 'booking-settings', 'booking-integrity'] },
             { label: 'Services', href: '/services', pages: ['services'] },
             { label: 'Checkout', href: '/pos', pages: ['pos'] },
             { label: 'Inventory', href: '/inventory', pages: ['inventory'] }],
      pages: [] },
    { id: 'growth', label: 'Growth', href: '/campaigns', manager: true,
      subs: [{ label: 'Campaigns', href: '/campaigns', pages: ['campaigns', 'marketing'] },
             { label: 'Marketer', href: '/marketer', pages: ['marketer'], manager: true },
             { label: 'Opportunities', href: '/growth-os', pages: ['growth-os'], manager: true },
             { label: 'Revenue', href: '/revenue', pages: ['revenue'], manager: true },
             { label: 'Reviews', href: '/reviews', pages: ['reviews'] },
             { label: 'Banking', href: '/banking', pages: ['banking', 'banking-payments', 'banking-policies'], owner: true }],
      pages: [] },
    { id: 'clients', label: 'Clients', href: '/clients', subs: [], pages: ['clients', 'client'] },
  ];

  // Everything about the account and Lola's setup lives behind the owner's name.
  const ACCOUNT = [
    { label: 'Settings', href: '/settings', owner: true, pages: ['settings'] },
    { label: 'Teach Lola your salon', href: '/onboarding?learn=1', owner: true, pages: [] },
    { label: 'Activate Lola', href: '/activation-studio', owner: true, pages: ['activation-studio'] },
    { label: 'Launch checklist', href: '/launch', owner: true, pages: ['launch'] },
    { label: 'Team', href: '/team', manager: true, pages: ['team'] },
    { label: 'Billing', href: '/subscription', owner: true, pages: ['subscription'] },
    { label: 'Phone numbers', href: '/numbers', owner: true, pages: ['numbers', 'telecom'] },
  ];
  const ACCOUNT_PAGES = ['settings', 'team', 'subscription', 'numbers', 'telecom', 'activation-studio', 'launch'];

  const page = (location.pathname.split('/').pop() || '').replace(/\.html$/, '') || 'dashboard';
  const DATA_PAGE_ALIAS = { overview: 'dashboard', marketing: 'campaigns', brain: 'brain-os', operations: 'operations-os', growth: 'growth-os' };
  const dataPage = document.body ? (document.body.getAttribute('data-page') || '') : '';

  function tabFor(p) {
    for (const t of TABS) {
      if (t.pages.includes(p)) return t;
      if (t.subs.some((s) => s.pages.includes(p))) return t;
    }
    return null;
  }
  const activeTab = tabFor(page) || tabFor(DATA_PAGE_ALIAS[dataPage] || dataPage) || null;
  const onAccountPage = !activeTab && ACCOUNT_PAGES.includes(page);
  const isSub = (s) => s.pages.includes(page) || s.pages.includes(DATA_PAGE_ALIAS[dataPage] || dataPage);

  // ── Role ─────────────────────────────────────────────────────
  // Render with the last known role so staff never see a flash of
  // owner-only places; confirm against the live session below.
  let role = 'owner';
  try { role = sessionStorage.getItem('lolaNavRole') || 'owner'; } catch (_) {}
  const canManage = () => ['owner', 'admin', 'manager'].includes(role);
  const canOwn = () => ['owner', 'admin'].includes(role);
  const allowed = (x) => (!x.owner || canOwn()) && (!x.manager || canManage());

  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const svg = (d, cls) => `<svg class="${cls || 'ln-ico'}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

  // ── Styles (scoped, self-contained) ─────────────────────────
  const CSS = `
.ln-side{--ln-bg:#0b0b0d;--ln-line:rgba(255,255,255,.06);--ln-ink:#f2f2f5;--ln-ink2:#9a9aa3;--ln-ink3:#5c5c64;--ln-acc:#ccff00;
  position:fixed;left:0;top:0;bottom:0;width:236px;height:auto;overflow-y:auto;box-sizing:border-box;display:flex;flex-direction:column;
  background:var(--ln-bg);border-right:1px solid var(--ln-line);padding:26px 14px 16px;z-index:40;
  font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue',Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
.ln-side *{box-sizing:border-box}
/* Pinned, not sticky: pages set overflow on html AND body, which turns body
   into a scroll box and silently breaks position:sticky (the sidebar used
   to scroll away with the page). The content makes room for it instead. */
body.ln-shell{padding-left:236px}
@media (min-width:1101px){ .app.ln-app{display:block!important;padding-left:236px;box-sizing:border-box} .app.ln-app>.main,.app.ln-app>main{width:auto;max-width:none} }
.ln-brand{display:block;padding:0 12px 26px;text-decoration:none;color:var(--ln-ink)}
.ln-mark{display:block;font-size:19px;font-weight:650;letter-spacing:.2em;line-height:1}
.ln-salon{display:block;margin-top:7px;font-size:11.5px;color:var(--ln-ink3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-height:14px}
.ln-tabs{display:flex;flex-direction:column;gap:2px}
.ln-tab{position:relative;display:flex;align-items:center;gap:13px;height:42px;padding:0 12px;border-radius:11px;
  color:var(--ln-ink2);font-size:14px;font-weight:500;text-decoration:none;transition:background .18s,color .18s}
.ln-tab:hover{background:rgba(255,255,255,.035);color:var(--ln-ink)}
.ln-tab.is-active{color:var(--ln-ink);background:rgba(204,255,0,.055)}
.ln-tab.is-active::before{content:'';position:absolute;left:-14px;top:11px;bottom:11px;width:2px;border-radius:2px;background:var(--ln-acc);box-shadow:0 0 12px rgba(204,255,0,.55)}
.ln-ico{width:19px;height:19px;flex:0 0 auto}
.ln-tab.is-active .ln-ico{color:var(--ln-acc)}
.ln-subs{display:flex;flex-direction:column;margin:2px 0 8px;padding-left:44px}
.ln-sub{display:block;padding:6px 0;font-size:13px;color:var(--ln-ink3);text-decoration:none;transition:color .15s}
.ln-sub:hover{color:var(--ln-ink2)}
.ln-sub.is-active{color:var(--ln-ink)}
.ln-spacer{flex:1}
.ln-lola{display:flex;align-items:center;justify-content:space-between;width:100%;height:44px;margin:0 0 10px;padding:0 14px;
  border:1px solid rgba(204,255,0,.22);border-radius:12px;background:rgba(204,255,0,.06);color:var(--ln-acc);
  font-family:inherit;font-size:13px;font-weight:600;line-height:1;cursor:pointer;transition:background .18s,border-color .18s}
.ln-lola:hover{background:rgba(204,255,0,.1);border-color:rgba(204,255,0,.4)}
.ln-lola kbd{font-family:inherit;font-size:11px;font-weight:500;line-height:1;color:rgba(204,255,0,.6);background:none;border:0;padding:0}
.ln-acct{position:relative}
.ln-me{display:flex;align-items:center;gap:11px;width:100%;padding:10px;border:0;border-radius:12px;background:transparent;
  color:var(--ln-ink);text-align:left;cursor:pointer;font-family:inherit;transition:background .18s}
.ln-me:hover,.ln-me[aria-expanded="true"],.ln-me.is-active{background:rgba(255,255,255,.04)}
.ln-av{width:34px;height:34px;flex:0 0 34px;border-radius:50%;display:flex;align-items:center;justify-content:center;
  background:linear-gradient(135deg,#ccff00,#7fb300);color:#0b0b0d;font-weight:700;font-size:13px}
.ln-who{min-width:0;flex:1;line-height:1.25}
.ln-who b{display:block;font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ln-who small{display:block;font-size:11px;color:var(--ln-ink3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ln-me .ln-chev{width:16px;height:16px;color:var(--ln-ink3);transform:rotate(180deg);transition:transform .2s}
.ln-me[aria-expanded="true"] .ln-chev{transform:rotate(0deg)}
.ln-menu{position:absolute;left:0;right:0;bottom:calc(100% + 6px);padding:6px;border-radius:14px;
  background:#141417;border:1px solid rgba(255,255,255,.08);box-shadow:0 18px 50px rgba(0,0,0,.55);z-index:60;
  opacity:0;transform:translateY(4px);pointer-events:none;transition:opacity .16s,transform .16s}
.ln-menu.is-open{opacity:1;transform:none;pointer-events:auto}
.ln-menu a,.ln-menu button{display:block;width:100%;padding:10px 12px;border:0;border-radius:9px;background:transparent;
  color:#e6e6ea;font-family:inherit;font-size:13px;font-weight:500;line-height:1.2;text-align:left;text-decoration:none;cursor:pointer}
.ln-menu a:hover,.ln-menu button:hover,.ln-menu a:focus-visible,.ln-menu button:focus-visible{background:rgba(255,255,255,.06);outline:none}
.ln-menu a.is-active{color:#ccff00}
.ln-menu hr{border:0;height:1px;background:rgba(255,255,255,.07);margin:5px 6px}
.ln-menu .ln-out{color:#9a9aa3}
.ln-side a:focus-visible,.ln-side button:focus-visible,.ln-bar a:focus-visible,.ln-bar button:focus-visible,.ln-top a:focus-visible,.ln-top button:focus-visible{outline:2px solid rgba(204,255,0,.7);outline-offset:2px}

/* Phone and tablet */
.ln-top,.ln-bar{display:none}
@media (max-width:1100px){
  .ln-side{display:none!important}
  body.ln-shell{padding-left:0}
  #tenantMobileHeader{display:none!important}
  .ln-top{display:flex;align-items:center;gap:10px;position:sticky;top:0;z-index:120;height:52px;padding:0 12px 0 16px;min-width:0;max-width:100vw;box-sizing:border-box;
    background:rgba(8,8,10,.86);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border-bottom:1px solid rgba(255,255,255,.06);
    font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue',Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
  .ln-top-l{flex:1;min-width:0;display:flex;align-items:center;gap:4px;overflow-x:auto;scrollbar-width:none}
  .ln-top-l::-webkit-scrollbar{display:none}
  .ln-top-l.fade-r{-webkit-mask-image:linear-gradient(to right,#000 82%,transparent);mask-image:linear-gradient(to right,#000 82%,transparent)}
  .ln-top-l.fade-l{-webkit-mask-image:linear-gradient(to left,#000 82%,transparent);mask-image:linear-gradient(to left,#000 82%,transparent)}
  .ln-top-l.fade-l.fade-r{-webkit-mask-image:linear-gradient(to right,transparent,#000 14%,#000 86%,transparent);mask-image:linear-gradient(to right,transparent,#000 14%,#000 86%,transparent)}
  .ln-top-name{font-size:14px;font-weight:650;color:#f2f2f5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ln-pill{flex:0 0 auto;padding:7px 12px;border-radius:999px;font-size:13px;font-weight:500;color:#8a8a92;text-decoration:none}
  .ln-pill.is-active{background:rgba(255,255,255,.08);color:#f2f2f5}
  .ln-top .ln-acct{flex:0 0 auto}
  .ln-top .ln-me{padding:0;width:auto;background:transparent!important}
  .ln-top .ln-av{width:32px;height:32px;flex-basis:32px;font-size:12px}
  .ln-top .ln-menu{left:auto;right:0;bottom:auto;top:calc(100% + 8px);width:220px;transform:translateY(-4px)}
  .ln-top .ln-menu.is-open{transform:none}
  .ln-bar{display:flex;position:fixed;left:0;right:0;bottom:0;z-index:130;height:calc(62px + env(safe-area-inset-bottom,0px));
    padding:0 6px env(safe-area-inset-bottom,0px);align-items:stretch;justify-content:space-around;
    background:rgba(8,8,10,.9);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border-top:1px solid rgba(255,255,255,.06);
    font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue',Helvetica,Arial,sans-serif}
  .ln-bi{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;border:0;background:transparent;
    color:#6a6a72;font-size:10.5px;font-weight:500;font-family:inherit;text-decoration:none;cursor:pointer;-webkit-tap-highlight-color:transparent}
  .ln-bi .ln-ico{width:22px;height:22px}
  .ln-bi.is-active{color:#ccff00}
  .ln-bi.is-active span{color:#f2f2f5}
  .ln-orb{width:46px;height:46px;border-radius:50%;margin-top:-18px;
    background:radial-gradient(circle at 38% 34%,#f1ffa6 0%,#ccff00 38%,#6f9a00 100%);
    box-shadow:0 0 0 4px #08080a,0 6px 22px rgba(204,255,0,.35);animation:lnBreath 4.2s ease-in-out infinite}
  .ln-bi-lola span{color:#ccff00}
  @keyframes lnBreath{0%,100%{box-shadow:0 0 0 4px #08080a,0 6px 22px rgba(204,255,0,.28)}50%{box-shadow:0 0 0 4px #08080a,0 6px 30px rgba(204,255,0,.5)}}
  body.ln-has-bar{padding-bottom:calc(62px + env(safe-area-inset-bottom,0px))}
  .app>.main,.app>main{min-width:0}
  .ln-pill{min-height:36px;display:inline-flex;align-items:center}
  body.ln-has-bar .lp-root:not(.lp-staged) .lp-orb{display:none!important}
  body.ln-has-bar .lp-panel{bottom:calc(74px + env(safe-area-inset-bottom,0px))!important}
  body.ln-has-bar .lp-nudge{right:12px!important;left:12px!important;bottom:calc(74px + env(safe-area-inset-bottom,0px))!important;max-width:none!important}
}
@media (prefers-reduced-motion:reduce){.ln-orb{animation:none}.ln-menu,.ln-tab,.ln-me .ln-chev{transition:none}}
`;

  // ── Build ────────────────────────────────────────────────────
  function tabsHTML() {
    return TABS.filter(allowed).map((t) => {
      const on = activeTab && activeTab.id === t.id;
      const subs = on ? t.subs.filter(allowed) : [];
      const tabIsPage = on && !subs.length && t.pages.concat(...t.subs.map((s) => s.pages)).includes(page);
      const subHTML = subs.length > 1
        ? `<div class="ln-subs">${subs.map((s) => `<a class="ln-sub${isSub(s) ? ' is-active' : ''}" href="${s.href}"${isSub(s) ? ' aria-current="page"' : ''}>${esc(s.label)}</a>`).join('')}</div>`
        : '';
      return `<a class="ln-tab${on ? ' is-active' : ''}" href="${t.href}" data-tab="${t.id}"${tabIsPage ? ' aria-current="page"' : ''}>${svg(I[t.id])}<span>${esc(t.label)}</span></a>${subHTML}`;
    }).join('');
  }
  function menuHTML() {
    const items = ACCOUNT.filter(allowed).map((a) => {
      const on = a.pages.includes(page);
      return `<a role="menuitem" href="${a.href}"${on ? ' class="is-active" aria-current="page"' : ''}>${esc(a.label)}</a>`;
    }).join('');
    return `${items}${items ? '<hr>' : ''}<button type="button" role="menuitem" class="ln-out" data-ln-signout>Sign out</button>`;
  }
  function meHTML(compact) {
    return `<button type="button" class="ln-me${onAccountPage ? ' is-active' : ''}" aria-haspopup="menu" aria-expanded="false" aria-label="Account">
      <span class="ln-av" data-ln-initial>·</span>
      ${compact ? '' : `<span class="ln-who"><b data-ln-name>&nbsp;</b><small data-ln-role>&nbsp;</small></span>${svg(I.chevron, 'ln-chev')}`}
    </button>
    <div class="ln-menu" role="menu">${menuHTML()}</div>`;
  }

  const style = document.createElement('style');
  style.id = 'lolaNavStyles';
  style.textContent = CSS;
  document.head.appendChild(style);

  // Retire every other navigation still in the page.
  document.querySelectorAll('nav.mobile-bar, aside.sidebar, #tenantMobileHeader').forEach((n) => n.remove());

  const side = document.createElement('aside');
  side.className = 'ln-side';
  side.setAttribute('data-lola-nav', '');
  side.setAttribute('aria-label', 'LolaDesk');
  side.innerHTML = `
    <a class="ln-brand" href="/dashboard" aria-label="LolaDesk home"><span class="ln-mark">LOLA</span><span class="ln-salon" data-ln-salon></span></a>
    <nav class="ln-tabs" aria-label="Primary">${tabsHTML()}</nav>
    <div class="ln-spacer"></div>
    <button type="button" class="ln-lola" data-ln-lola>Talk to Lola <kbd>⌘J</kbd></button>
    <div class="ln-acct">${meHTML(false)}</div>`;

  const app = document.querySelector('.app');
  if (app) { app.classList.add('ln-app'); app.insertBefore(side, app.firstChild); }
  else { document.body.classList.add('ln-shell'); document.body.insertBefore(side, document.body.firstChild); }

  // Phone: top strip (this place's pages + the owner) and the bottom bar.
  const subsNow = activeTab ? activeTab.subs.filter(allowed) : [];
  const top = document.createElement('div');
  top.className = 'ln-top';
  top.setAttribute('data-lola-nav', '');
  top.innerHTML = `
    <div class="ln-top-l">${subsNow.length > 1
      ? subsNow.map((s) => `<a class="ln-pill${isSub(s) ? ' is-active' : ''}" href="${s.href}"${isSub(s) ? ' aria-current="page"' : ''}>${esc(s.label)}</a>`).join('')
      : '<span class="ln-top-name" data-ln-salon></span>'}</div>
    <div class="ln-acct">${meHTML(true)}</div>`;
  // A full-width row of its own (never inset by the page's padding).
  side.parentNode.insertBefore(top, side.nextSibling);

  // Phone strip: the current page is always in view, and a soft edge shows
  // when there are more pages to scroll to.
  (function () {
    const l = top.querySelector('.ln-top-l');
    if (!l) return;
    const edges = () => {
      l.classList.toggle('fade-r', l.scrollLeft + l.clientWidth < l.scrollWidth - 4);
      l.classList.toggle('fade-l', l.scrollLeft > 4);
    };
    const center = () => {
      const act = l.querySelector('.is-active');
      if (act) l.scrollLeft = Math.max(0, act.offsetLeft - (l.clientWidth - act.offsetWidth) / 2);
      edges();
    };
    l.addEventListener('scroll', edges, { passive: true });
    window.addEventListener('resize', center);
    requestAnimationFrame(center);
  })();

  const bar = document.createElement('nav');
  bar.className = 'ln-bar';
  bar.setAttribute('data-lola-nav', '');
  bar.setAttribute('aria-label', 'Primary');
  const barTab = (t) => {
    const on = activeTab && activeTab.id === t.id;
    return `<a class="ln-bi${on ? ' is-active' : ''}" href="${t.href}" data-tab="${t.id}"${on ? ' aria-current="page"' : ''}>${svg(I[t.id])}<span>${esc(t.label)}</span></a>`;
  };
  const visible = TABS.filter(allowed);
  const left = visible.slice(0, 2), right = visible.slice(2);
  bar.innerHTML = left.map(barTab).join('')
    + '<button type="button" class="ln-bi ln-bi-lola" data-ln-lola aria-label="Talk to Lola"><span class="ln-orb"></span><span>Lola</span></button>'
    + right.map(barTab).join('');
  document.body.appendChild(bar);
  document.body.classList.add('ln-has-bar');

  // ── Behaviour ────────────────────────────────────────────────
  function talkToLola() {
    if (document.getElementById('orbMic') && typeof window.openChat === 'function') return window.openChat();
    if (window.LolaEverywhere && typeof window.LolaEverywhere.open === 'function' && document.querySelector('.lp-root')) return window.LolaEverywhere.open();
    location.href = '/dashboard';
  }
  document.querySelectorAll('[data-ln-lola]').forEach((b) => b.addEventListener('click', talkToLola));

  function closeMenus(except) {
    document.querySelectorAll('.ln-acct').forEach((a) => {
      if (a === except) return;
      const m = a.querySelector('.ln-menu'), t = a.querySelector('.ln-me');
      if (m) m.classList.remove('is-open');
      if (t) t.setAttribute('aria-expanded', 'false');
    });
  }
  document.querySelectorAll('.ln-acct').forEach((acct) => {
    const btn = acct.querySelector('.ln-me'), menu = acct.querySelector('.ln-menu');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = !menu.classList.contains('is-open');
      closeMenus(acct);
      menu.classList.toggle('is-open', open);
      btn.setAttribute('aria-expanded', String(open));
      if (open) { const first = menu.querySelector('a,button'); if (first) setTimeout(() => first.focus(), 30); }
    });
  });
  document.addEventListener('click', (e) => { if (!e.target.closest || !e.target.closest('.ln-acct')) closeMenus(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });
  document.addEventListener('click', (e) => {
    const out = e.target.closest && e.target.closest('[data-ln-signout]');
    if (!out) return;
    e.preventDefault();
    try { localStorage.removeItem('loladesk_token'); localStorage.removeItem('loladesk_refresh'); sessionStorage.removeItem('loladesk_tenant'); sessionStorage.removeItem('lolaNavRole'); } catch (_) {}
    location.replace('/login');
  });

  // ── Identity + role, from the live session ──────────────────
  const ROLE_LABEL = { owner: 'Owner', admin: 'Administrator', manager: 'Manager', front_desk: 'Front Desk', frontdesk: 'Front Desk', stylist: 'Stylist', staff: 'Team Member' };
  function applyIdentity(auth) {
    if (!auth) return;
    const t = auth.tenant || {}, u = auth.user || {};
    const business = t.name || t.business_name || '';
    const r = String(auth.role || role || 'staff').toLowerCase();
    const person = ((r === 'owner' && t.owner_name) || (u.user_metadata && u.user_metadata.full_name) || t.owner_name || u.email || '').trim();
    const first = person.split(/[\s@]+/)[0] || 'You';
    document.querySelectorAll('[data-ln-salon]').forEach((el) => { el.textContent = business; });
    document.querySelectorAll('[data-ln-name]').forEach((el) => { el.textContent = first; });
    document.querySelectorAll('[data-ln-role]').forEach((el) => { el.textContent = (ROLE_LABEL[r] || r.replace(/_/g, ' ')) + (business ? ' · ' + business : ''); });
    document.querySelectorAll('[data-ln-initial]').forEach((el) => { el.textContent = (first[0] || '·').toUpperCase(); });
    if (r !== role) {
      role = r;
      try { sessionStorage.setItem('lolaNavRole', r); } catch (_) {}
      rerenderGated();
    }
  }
  function rerenderGated() {
    const tabs = side.querySelector('.ln-tabs');
    if (tabs) tabs.innerHTML = tabsHTML();
    document.querySelectorAll('.ln-menu').forEach((m) => { m.innerHTML = menuHTML(); });
    const vis = TABS.filter(allowed);
    bar.innerHTML = vis.slice(0, 2).map(barTab).join('')
      + '<button type="button" class="ln-bi ln-bi-lola" data-ln-lola aria-label="Talk to Lola"><span class="ln-orb"></span><span>Lola</span></button>'
      + vis.slice(2).map(barTab).join('');
    bar.querySelectorAll('[data-ln-lola]').forEach((b) => b.addEventListener('click', talkToLola));
  }
  window.addEventListener('lola:tenant-ready', (e) => applyIdentity(e.detail));
  if (window.LolaAuth && window.LolaAuth.ready) {
    Promise.resolve(window.LolaAuth.ready).then(applyIdentity).catch(() => {});
  } else {
    // Pages without auth-guard (e.g. Revenue) still know who's signed in.
    let token = '';
    try { token = localStorage.getItem('loladesk_token') || ''; } catch (_) {}
    if (token) {
      fetch('/api/auth/session', { headers: { Authorization: 'Bearer ' + token } })
        .then((r) => (r.ok ? r.json() : null)).then((d) => d && applyIdentity(d)).catch(() => {});
    }
  }

  window.LolaNav = { tab: activeTab ? activeTab.id : null, page, talk: talkToLola };
})();
