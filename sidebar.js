/* ═══════════════════════════════════════════════════════════════
   LolaDesk — shared sidebar / nav (Neon Green Pro)
   ═══════════════════════════════════════════════════════════════ */
(function(){
  const page = document.body.getAttribute('data-page') || 'overview';

  const icons = {
    overview:'<path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
    clients:'<path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/>',
    calls:'<path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 16.92z"/>',
    inbox:'<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>',
    bookings:'<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
    revenue:'<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/>',
    team:'<path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    marketing:'<path d="M3 11l18-5v12L3 13v-2zM11.6 16.8a3 3 0 11-5.8-1.6"/>',
    settings:'<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-2.7.7 2 2 0 11-3.8 0 1.6 1.6 0 00-2.7-.7l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.6 1.6 0 00-1.3-2.7 2 2 0 010-3.8 1.6 1.6 0 001.3-2.7l-.1-.1a2 2 0 112.8-2.8l.1.1a1.6 1.6 0 002.7-.7 2 2 0 013.8 0 1.6 1.6 0 002.7.7l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 001.3 2.7 2 2 0 010 3.8 1.6 1.6 0 00-1.3 1z"/>'
  };

  const items = [
    { id:'overview', label:'Overview', href:'dashboard.html' },
    { id:'clients',  label:'Clients', href:'clients.html' },
    { id:'calls',    label:'Calls', href:'calls.html', badge:'12' },
    { id:'inbox',    label:'Inbox', href:'inbox.html', badge:'8' },
    { id:'bookings', label:'Bookings', href:'bookings.html' },
    { id:'revenue',  label:'Revenue', href:'revenue.html' },
    { id:'team',     label:'Team', href:'team.html' },
    { id:'settings', label:'Settings', href:'settings.html' }
  ];

  const navHTML = items.map(it => `
    <a class="nav-item ${it.id===page?'active':''}" href="${it.href}">
      <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">${icons[it.id]||''}</svg>
      ${it.label}
      ${it.badge?`<span class="nav-badge ${it.pink?'pink':''}">${it.badge}</span>`:''}
    </a>`).join('');

  const sidebar = document.createElement('aside');
  sidebar.className = 'sidebar';
  sidebar.innerHTML = `
    <div class="logo">
      <div class="logo-mark">LOLA<br>DESK</div>
      <div class="logo-sub">Command</div>
    </div>
    <nav class="nav">${navHTML}</nav>
    <div style="margin-top:auto"></div>
    <div class="nav-user" onclick="location.href='settings.html'">
      <div class="nav-user-av">M</div>
      <div class="nav-user-info">
        <div class="nav-user-name" id="sbOwnerName">Meddy</div>
        <div class="nav-user-role">Owner</div>
      </div>
    </div>`;

  // mobile bar
  const mobile = document.createElement('nav');
  mobile.className = 'mobile-bar';
  const mb = [
    { id:'overview', href:'dashboard.html', label:'Home', icon:icons.overview },
    { id:'bookings', href:'bookings.html', label:'Calendar', icon:icons.bookings },
    { id:'lola', href:'javascript:toggleDashboardVoice&&toggleDashboardVoice()', label:'', orb:true },
    { id:'inbox', href:'inbox.html', label:'Inbox', icon:icons.inbox },
    { id:'settings', href:'settings.html', label:'More', icon:icons.settings }
  ];
  mobile.innerHTML = mb.map(m => m.orb
    ? `<a class="mb-item" onclick="if(window.toggleChatVoice) window.toggleChatVoice();"><div class="mb-orb">L</div></a>`
    : `<a class="mb-item ${m.id===page?'active':''}" href="${m.href}"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor">${m.icon}</svg>${m.label}</a>`
  ).join('');

  const app = document.querySelector('.app');
  if(app) app.insertBefore(sidebar, app.firstChild);
  document.body.appendChild(mobile);

  // CHAT OVERLAY
  if(!document.getElementById('chatOverlay')) {
    const chatOverlay = document.createElement('div');
    chatOverlay.className = 'chat-overlay';
    chatOverlay.id = 'chatOverlay';
    chatOverlay.innerHTML = `
      <div class="chat-modal">
        <div class="chat-modal-head">
          <div class="chat-modal-title">
            <div class="chat-modal-orb">L</div>
            <div>
              <div class="chat-modal-name">Lola</div>
              <div class="chat-modal-status">Online · Your AI front desk</div>
            </div>
          </div>
          <button class="chat-close" onclick="closeChat()" aria-label="Close"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
        </div>
        <div class="chat-msgs" id="chatMsgs" role="log" aria-live="polite"></div>
        <div class="chat-input-row">
          <button class="chat-mic" id="chatMic" onclick="toggleChatVoice()" aria-label="Voice"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M19 10v2a7 7 0 01-14 0v-2M12 19v3M8 22h8"/></svg></button>
          <input class="chat-input" id="chatInput" placeholder="Ask Lola anything…" aria-label="Message Lola"/>
          <button class="chat-send" onclick="sendChat()" aria-label="Send"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M12 19V5M5 12l7-7 7 7"/></svg></button>
        </div>
      </div>
    `;
    document.body.appendChild(chatOverlay);
  }

})();
