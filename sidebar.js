/* LolaDesk — shared sidebar / mobile navigation.
   Reconciled to a canonical 8-item primary nav (post-audit): the
   day-to-day surfaces an owner actually uses. Secondary pages
   (Team, Growth, Reviews, Inventory, etc.) are still reachable via
   Settings and direct URL — they were nav-clutter, not gone.
   Also fixes the double-mobile-bar bug: many pages ship their own
   inline mobile-bar; this file now only injects one if the page
   doesn't already have one. */
(function(){
  if(!document.querySelector('link[href="ux-runtime.css"]')){const css=document.createElement('link');css.rel='stylesheet';css.href='ux-runtime.css';document.head.appendChild(css)}
  if(!document.querySelector('link[href="product-reset.css"]')){const css=document.createElement('link');css.rel='stylesheet';css.href='product-reset.css';document.head.appendChild(css)}
  if(!document.querySelector('script[src="ux-runtime.js"]')){const js=document.createElement('script');js.src='ux-runtime.js';js.defer=true;document.head.appendChild(js)}
  const page=document.body.getAttribute('data-page')||'overview';
  const icons={
    overview:'<path d="M3 9.5L12 3l9 6.5V20a1 1 0 01-1 1h-5v-7h-6v7H4a1 1 0 01-1-1V9.5z"/>',
    bookings:'<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 3v3M16 3v3"/>',
    calls:'<path d="M5 4h4l2 5-3 2a11 11 0 005 5l2-3 5 2v4a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2z"/>',
    inbox:'<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
    clients:'<circle cx="9" cy="7" r="3"/><path d="M3 21v-1a5 5 0 015-5h2a5 5 0 015 5v1M16 3.5a3 3 0 010 6M21 21v-1a5 5 0 00-3-4.5"/>',
    revenue:'<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    banking:'<rect x="3" y="6" width="18" height="14" rx="2"/><path d="M3 10h18M7 15h3M14 15h3"/>',
    settings:'<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-2.7.7 2 2 0 11-3.8 0 1.6 1.6 0 00-2.7-.7l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.6 1.6 0 00-1.3-2.7 2 2 0 010-3.8 1.6 1.6 0 001.3-2.7l-.1-.1a2 2 0 112.8-2.8l.1.1a1.6 1.6 0 002.7-.7 2 2 0 013.8 0 1.6 1.6 0 002.7.7l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 001.3 2.7 2 2 0 010 3.8 1.6 1.6 0 00-1.3 1z"/>'
  };
  /* Canonical 8 — the day-to-day surfaces. Order matters: this is the
     reading order for a returning owner. */
  const items=[
    {id:'overview',label:'Home',href:'dashboard.html'},
    {id:'bookings',label:'Calendar',href:'bookings.html'},
    {id:'calls',label:'Calls',href:'calls.html'},
    {id:'inbox',label:'Inbox',href:'inbox.html'},
    {id:'clients',label:'Clients',href:'clients.html'},
    {id:'revenue',label:'Revenue',href:'revenue.html'},
    {id:'banking',label:'Banking',href:'banking.html'},
    {id:'settings',label:'Settings',href:'settings.html'}
  ];
  const navHTML=items.map(it=>`<a class="nav-item ${it.id===page?'active':''}" href="${it.href}" ${it.id===page?'aria-current="page"':''}><svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">${icons[it.id]||''}</svg>${it.label}</a>`).join('');
  const sidebar=document.createElement('aside');sidebar.className='sidebar';
  sidebar.innerHTML=`<div class="logo"><div class="logo-mark">LOLA</div><div class="logo-sub">DESK</div></div><nav class="nav" aria-label="Primary">${navHTML}</nav><button data-ux-action onclick="location.href='brain-os.html'" style="margin:0 16px 10px;padding:12px;border:1px solid var(--accent-glow);border-radius:12px;display:flex;justify-content:space-between;color:var(--accent);background:var(--accent-dim)"><span>Talk to Lola</span><kbd style="font:11px var(--ff)">⌘ K</kbd></button><a class="nav-user" href="settings.html"><div class="nav-user-av" id="sbInitial">W</div><div class="nav-user-info"><div class="nav-user-name" id="sbBusiness">Workspace</div><div class="nav-user-role">Signed-in tenant</div></div></a>`;

  /* Mobile bar — only inject if the page doesn't already ship one.
     Newer surfaces (calls.html, inbox.html) render their own inline
     mobile-bar with aria-current on the active tab; older pages
     (dashboard.html, bookings.html, ...) rely on this injected one. */
  const canonicalMobile=[
    {id:'overview',href:'dashboard.html',label:'Home',icon:icons.overview},
    {id:'bookings',href:'bookings.html',label:'Calendar',icon:icons.bookings},
    {id:'calls',href:'calls.html',label:'Calls',icon:icons.calls},
    {id:'inbox',href:'inbox.html',label:'Inbox',icon:icons.inbox},
    {id:'settings',href:'settings.html',label:'Settings',icon:icons.settings}
  ];
  const app=document.querySelector('.app');if(app)app.insertBefore(sidebar,app.firstChild);
  if(!document.querySelector('nav.mobile-bar')){
    const mobile=document.createElement('nav');
    mobile.className='mobile-bar';
    mobile.setAttribute('aria-label','Primary');
    mobile.innerHTML=canonicalMobile.map(m=>`<a class="mb-item ${m.id===page?'active':''}" href="${m.href}" ${m.id===page?'aria-current="page"':''}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor">${m.icon}</svg>${m.label}</a>`).join('');
    document.body.appendChild(mobile);
  }
  if(window.LolaData?.load){Promise.resolve(window.LolaData.load('overview')).then(d=>{const name=d?.tenant||'Workspace';const n=document.getElementById('sbBusiness');const i=document.getElementById('sbInitial');if(n)n.textContent=name;if(i)i.textContent=String(name).trim().charAt(0).toUpperCase()||'W'}).catch(()=>{})}
})();
