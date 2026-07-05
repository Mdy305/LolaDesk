/* ═══════════════════════════════════════════════════════════════
   LolaDesk — shared sidebar / nav
   Each page sets <body data-page="clients"> etc. This injects the
   sidebar with the right active item and the mobile bottom bar.
   ═══════════════════════════════════════════════════════════════ */
(function(){
  const page = document.body.getAttribute('data-page') || 'overview';

  const icons = {
    overview:'<path d="M3 9.5L12 3l9 6.5V20a1 1 0 01-1 1h-5v-7h-6v7H4a1 1 0 01-1-1V9.5z"/>',
    agents:'<circle cx="12" cy="12" r="3"/><circle cx="5" cy="5" r="2"/><circle cx="19" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><path d="M7 6L10 10M17 6L14 10M7 18L10 14M17 18L14 14"/>',
    clients:'<circle cx="9" cy="7" r="3"/><path d="M3 21v-1a5 5 0 015-5h2a5 5 0 015 5v1M16 3.5a3 3 0 010 6M21 21v-1a5 5 0 00-3-4.5"/>',
    calls:'<path d="M5 4h4l2 5-3 2a11 11 0 005 5l2-3 5 2v4a1 1 0 01-1 1A16 16 0 014 5a1 1 0 011-1z"/>',
    inbox:'<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
    numbers:'<rect x="5" y="2" width="14" height="20" rx="3"/><path d="M11 18h2"/>',
    bookings:'<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 3v3M16 3v3"/>',
    revenue:'<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    team:'<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0116 0v1"/>',
    marketing:'<path d="M3 11l18-5v12L3 13v-2zM11.6 16.8a3 3 0 11-5.8-1.6"/>',
    marketer:'<path d="M12 2a4 4 0 014 4v1a5 5 0 013 4.6V14a5 5 0 01-3 4.6V20a4 4 0 11-8 0v-1.4A5 5 0 015 14v-2.4A5 5 0 018 7V6a4 4 0 014-4z"/><path d="M9 11h.01M15 11h.01"/>',
    settings:'<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-2.7.7 2 2 0 11-3.8 0 1.6 1.6 0 00-2.7-.7l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.6 1.6 0 00-1.3-2.7 2 2 0 010-3.8 1.6 1.6 0 001.3-2.7l-.1-.1a2 2 0 112.8-2.8l.1.1a1.6 1.6 0 002.7-.7 2 2 0 013.8 0 1.6 1.6 0 002.7.7l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 001.3 2.7 2 2 0 010 3.8 1.6 1.6 0 00-1.3 1z"/>'
  };

  const items = [
    { id:'overview', label:'Overview', href:'lola-atom.html' },
    { id:'clients',  label:'Clients',  href:'clients.html' },
    { id:'calls',    label:'Calls',    href:'calls.html', badge:'12' },
    { id:'inbox',    label:'Inbox',    href:'inbox.html', badge:'8' },
    { id:'numbers',  label:'Numbers',  href:'numbers.html', badge:'New', mono:true },
    { id:'bookings', label:'Bookings', href:'bookings.html' },
    { id:'revenue',  label:'Revenue',  href:'revenue.html' },
    { id:'team',     label:'Team',     href:'team.html' },
    { id:'marketing',label:'Email',href:'marketing.html' },
    { id:'marketer', label:'Control Plane', href:'marketer.html#control', badge:'AI', pink:true },
    { id:'settings', label:'Settings', href:'settings.html' }
  ];

  const navHTML = items.map(it => `
    <a class="nav-item ${it.id===page?'active':''}" href="${it.href}">
      <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">${icons[it.id]||''}</svg>
      ${it.label}
      ${it.badge?`<span class="nav-badge ${it.green?'mono':''} ${it.pink?'pink':''}">${it.badge}</span>`:''}
    </a>`).join('');

  const sidebar = document.createElement('aside');
  sidebar.className = 'sidebar';
  sidebar.innerHTML = `
    <div class="logo">
      <div class="logo-mark">LOLA</div>
      <div class="logo-sub">DESK</div>
    </div>
    <nav class="nav">${navHTML}</nav>
    <div style="margin: 0 16px 20px; padding: 12px; background: linear-gradient(135deg, rgba(255,45,142,0.08), rgba(176,30,108,0.04)); border: 0.5px solid var(--pink-dim); border-radius: 8px; display: flex; align-items: center; gap: 10px;">
      <div style="font-size: 20px; filter: drop-shadow(0 0 6px var(--pink));">🔥</div>
      <div>
        <div style="font-size: 12px; font-weight: 600; color: var(--pink2);">12-Day Streak</div>
        <div style="font-size: 10px; color: var(--text2);">Top 15% of salons</div>
      </div>
    </div>
    <a class="nav-user" href="settings.html">
      <div class="nav-user-av">M</div>
      <div class="nav-user-info">
        <div class="nav-user-name">Meddy</div>
        <div class="nav-user-role">Owner · MMΛ Salon</div>
      </div>
    </a>`;

  // mobile bar
  const mobile = document.createElement('nav');
  mobile.className = 'mobile-bar';
  const mb = [
    { id:'overview', href:'lola-atom.html', label:'Home', icon:icons.overview },
    { id:'clients', href:'clients.html', label:'Clients', icon:icons.clients },
    { id:'lola', href:'lola-atom.html', label:'', orb:true },
    { id:'inbox', href:'inbox.html', label:'Inbox', icon:icons.inbox },
    { id:'revenue', href:'revenue.html', label:'More', icon:icons.revenue }
  ];
  mobile.innerHTML = mb.map(m => m.orb
    ? `<a class="mb-item" href="${m.href}"><div class="mb-orb">L</div></a>`
    : `<a class="mb-item ${m.id===page?'active':''}" href="${m.href}"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor">${m.icon}</svg>${m.label}</a>`
  ).join('');

  // mount: sidebar first child of .app, mobile at end of body
  const app = document.querySelector('.app');
  if(app) app.insertBefore(sidebar, app.firstChild);
  document.body.appendChild(mobile);
})();
