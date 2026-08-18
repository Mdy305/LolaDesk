/* LolaDesk — shared sidebar / mobile navigation */
(function(){
  if(!document.querySelector('link[href="ux-runtime.css"]')){const css=document.createElement('link');css.rel='stylesheet';css.href='ux-runtime.css';document.head.appendChild(css)}
  if(!document.querySelector('link[href="product-reset.css"]')){const css=document.createElement('link');css.rel='stylesheet';css.href='product-reset.css';document.head.appendChild(css)}
  if(!document.querySelector('script[src="ux-runtime.js"]')){const js=document.createElement('script');js.src='ux-runtime.js';js.defer=true;document.head.appendChild(js)}
  const page=document.body.getAttribute('data-page')||'overview';
  const icons={
    brain:'<circle cx="12" cy="12" r="8"/><path d="M8 12h8M12 8v8M5.5 7.5l13 9M18.5 7.5l-13 9"/>',
    overview:'<path d="M3 9.5L12 3l9 6.5V20a1 1 0 01-1 1h-5v-7h-6v7H4a1 1 0 01-1-1V9.5z"/>',
    operations:'<path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"/>',
    bookings:'<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 3v3M16 3v3"/>',
    team:'<circle cx="9" cy="8" r="3"/><path d="M3 20v-1a5 5 0 015-5h2a5 5 0 015 5v1M16 5a3 3 0 010 6M21 20v-1a5 5 0 00-4-4.8"/>',
    inbox:'<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
    clients:'<circle cx="9" cy="7" r="3"/><path d="M3 21v-1a5 5 0 015-5h2a5 5 0 015 5v1M16 3.5a3 3 0 010 6M21 21v-1a5 5 0 00-3-4.5"/>',
    growth:'<path d="M4 19V9M10 19V5M16 19v-7M22 19H2"/><path d="M4 8l6-4 6 5 5-6"/>',
    revenue:'<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    settings:'<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-2.7.7 2 2 0 11-3.8 0 1.6 1.6 0 00-2.7-.7l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.6 1.6 0 00-1.3-2.7 2 2 0 010-3.8 1.6 1.6 0 001.3-2.7l-.1-.1a2 2 0 112.8-2.8l.1.1a1.6 1.6 0 002.7-.7 2 2 0 013.8 0 1.6 1.6 0 002.7.7l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 001.3 2.7 2 2 0 010 3.8 1.6 1.6 0 00-1.3 1z"/>'
  };icons.settings=icons.settings.slice(0,-1);
  const items=[
    {id:'brain',label:'Lola',href:'brain-os.html'},{id:'overview',label:'Home',href:'dashboard.html'},{id:'operations',label:'Operate',href:'operations-os.html'},
    {id:'bookings',label:'Calendar',href:'bookings.html'},{id:'team',label:'Team',href:'team.html'},{id:'inbox',label:'Inbox',href:'inbox.html'},
    {id:'clients',label:'Clients',href:'clients.html'},{id:'growth',label:'Grow',href:'growth-os.html'},{id:'revenue',label:'Revenue',href:'revenue.html'},
    {id:'telecom',label:'Telecom',href:'telecom.html'},{id:'settings',label:'Settings',href:'settings.html'}
  ];
  icons.telecom='<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>';
  const navHTML=items.map(it=>`<a class="nav-item ${it.id===page?'active':''}" href="${it.href}"><svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">${icons[it.id]||''}</svg>${it.label}</a>`).join('');
  const sidebar=document.createElement('aside');sidebar.className='sidebar';
  sidebar.innerHTML=`<div class="logo"><div class="logo-mark">LOLA</div><div class="logo-sub">DESK</div></div><nav class="nav">${navHTML}</nav><button data-ux-action onclick="location.href='brain-os.html'" style="margin:0 16px 10px;padding:12px;border:1px solid rgba(204,255,0,.25);border-radius:12px;display:flex;justify-content:space-between;color:#ccff00;background:rgba(204,255,0,.06)"><span>Talk to Lola</span><kbd style="font:11px var(--ff)">⌘ K</kbd></button><a class="nav-user" href="settings.html"><div class="nav-user-av" id="sbInitial">W</div><div class="nav-user-info"><div class="nav-user-name" id="sbBusiness">Workspace</div><div class="nav-user-role">Signed-in tenant</div></div></a>`;
  const mobile=document.createElement('nav');mobile.className='mobile-bar';
  const mb=[{id:'overview',href:'dashboard.html',label:'Home',icon:icons.overview},{id:'bookings',href:'bookings.html',label:'Calendar',icon:icons.bookings},{id:'brain',href:'brain-os.html',label:'',orb:true},{id:'team',href:'team.html',label:'Team',icon:icons.team},{id:'settings',href:'settings.html',label:'More',icon:icons.settings}];
  mobile.innerHTML=mb.map(m=>m.orb?`<a class="mb-item ${page==='brain'?'active':''}" href="${m.href}"><div class="mb-orb">L</div></a>`:`<a class="mb-item ${m.id===page?'active':''}" href="${m.href}"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor">${m.icon}</svg>${m.label}</a>`).join('');
  const app=document.querySelector('.app');if(app)app.insertBefore(sidebar,app.firstChild);document.body.appendChild(mobile);
  if(window.LolaData?.load){Promise.resolve(window.LolaData.load('overview')).then(d=>{const name=d?.tenant||'Workspace';const n=document.getElementById('sbBusiness');const i=document.getElementById('sbInitial');if(n)n.textContent=name;if(i)i.textContent=String(name).trim().charAt(0).toUpperCase()||'W'}).catch(()=>{})}
})();