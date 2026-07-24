/* LolaDesk tenant activity drawer — authenticated, role-aware, and tenant-scoped. */
(function(){
  if(window.LolaTenantNotifications) return;
  const q=(s,r=document)=>r.querySelector(s), qa=(s,r=document)=>Array.from(r.querySelectorAll(s));
  const esc=v=>String(v||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let drawer,backdrop,loaded=false;
  function styles(){
    if(q('#tenantNotificationStyles'))return;
    const s=document.createElement('style');s.id='tenantNotificationStyles';s.textContent=`
      #tenantNotifyBackdrop{position:fixed;inset:0;background:rgba(0,0,0,.38);backdrop-filter:blur(2px);z-index:99970;opacity:0;pointer-events:none;transition:opacity .22s ease}
      #tenantNotifyDrawer{position:fixed;top:0;right:0;width:min(390px,94vw);height:100dvh;background:#0d0d0f;border-left:1px solid rgba(255,255,255,.08);z-index:99971;transform:translateX(102%);transition:transform .34s cubic-bezier(.22,1,.36,1);display:flex;flex-direction:column;box-shadow:-24px 0 70px rgba(0,0,0,.35);font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Segoe UI",sans-serif}
      body.tenant-notify-open #tenantNotifyBackdrop{opacity:1;pointer-events:auto} body.tenant-notify-open #tenantNotifyDrawer{transform:translateX(0)}
      .tn-head{display:flex;align-items:center;justify-content:space-between;padding:22px 20px;border-bottom:1px solid rgba(255,255,255,.07)}.tn-head strong{font-size:16px}.tn-close{width:34px;height:34px;border:0;border-radius:10px;background:#17171a;color:#f5f5f5;font-size:18px}
      .tn-summary{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding:16px 18px}.tn-stat{padding:12px;border-radius:12px;background:#151518;text-align:center}.tn-stat b{display:block;font-size:18px;color:#dcff66}.tn-stat span{font-size:10px;color:#777780}
      .tn-body{overflow:auto;padding:0 18px 28px}.tn-section{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#6f6f77;margin:14px 0 8px}.tn-item{display:flex;gap:11px;padding:13px 0;border-bottom:1px solid rgba(255,255,255,.055)}.tn-icon{width:32px;height:32px;border-radius:10px;background:rgba(204,255,0,.09);display:grid;place-items:center;color:#dfff6f;flex:0 0 auto}.tn-copy{min-width:0;flex:1}.tn-title{font-size:13px;color:#f2f2f5}.tn-when{font-size:11px;color:#65656d;margin-top:3px}.tn-insight{padding:13px 14px;border-radius:12px;background:rgba(204,255,0,.055);border:1px solid rgba(204,255,0,.12);font-size:12px;color:#c9c9ce;margin-bottom:9px;line-height:1.45}.tn-empty{padding:36px 12px;text-align:center;color:#707078;font-size:12px}.tn-error{color:#ff9f96}.tn-badge{position:absolute!important;top:7px!important;right:7px!important;min-width:17px!important;height:17px!important;border-radius:9px!important;background:#ccff00!important;color:#080808!important;font-size:10px!important;font-weight:800!important;display:grid!important;place-items:center!important;padding:0 4px!important;box-shadow:0 0 12px rgba(204,255,0,.35)!important}
    `;document.head.appendChild(s);
  }
  function mount(){
    if(drawer)return;
    styles();backdrop=document.createElement('div');backdrop.id='tenantNotifyBackdrop';drawer=document.createElement('aside');drawer.id='tenantNotifyDrawer';drawer.setAttribute('aria-label','Business activity');drawer.innerHTML='<div class="tn-head"><strong>Activity</strong><button class="tn-close" aria-label="Close">×</button></div><div id="tenantNotifyContent" class="tn-body"><div class="tn-empty">Loading activity…</div></div>';
    document.body.append(backdrop,drawer);backdrop.onclick=close;drawer.querySelector('.tn-close').onclick=close;document.addEventListener('keydown',e=>{if(e.key==='Escape')close()});
  }
  function icon(type){return type==='booking'?'▣':type==='call'?'⌕':type==='lead'?'＋':'•'}
  function render(data){
    const c=q('#tenantNotifyContent');if(!c)return;
    if(data?.dataUnavailable){c.innerHTML='<div class="tn-empty tn-error">Activity is temporarily unavailable. Your tenant data remains protected.</div>';return;}
    const counts=data?.counts||{},events=Array.isArray(data?.events)?data.events:[],insights=Array.isArray(data?.insights)?data.insights:[];
    c.innerHTML=`<div class="tn-summary"><div class="tn-stat"><b>${Number(counts.bookings||0)}</b><span>Bookings</span></div><div class="tn-stat"><b>${Number(counts.leads||0)}</b><span>Leads</span></div><div class="tn-stat"><b>${Number(counts.calls||0)}</b><span>Calls</span></div></div>${insights.length?'<div class="tn-section">Lola noticed</div>'+insights.map(i=>`<div class="tn-insight">${esc(i.text)}</div>`).join(''):''}<div class="tn-section">Recent activity</div>${events.length?events.map(e=>`<div class="tn-item"><div class="tn-icon">${icon(e.type)}</div><div class="tn-copy"><div class="tn-title">${esc(e.title)}</div><div class="tn-when">${esc(e.when)}</div></div></div>`).join(''):'<div class="tn-empty">No new activity in the last 24 hours.</div>'}`;
  }
  async function load(force){
    if(loaded&&!force)return;loaded=true;
    const token=window.LolaAuth?.token||localStorage.getItem('loladesk_token')||'';
    try{const r=await fetch('/api/notifications',{headers:{Authorization:'Bearer '+token}});const data=await r.json().catch(()=>({}));if(!r.ok)throw new Error(data.error||'Activity unavailable');render(data);updateBadge(data);}catch(e){render({dataUnavailable:true});}
  }
  function updateBadge(data){
    const count=(data?.events||[]).length;qa('[data-tenant-notifications]').forEach(btn=>{let b=q('.tn-badge',btn);if(count){if(!b){b=document.createElement('span');b.className='tn-badge';btn.style.position='relative';btn.appendChild(b)}b.textContent=count>9?'9+':count;}else b?.remove();});
  }
  function open(){mount();document.body.classList.add('tenant-notify-open');load(true)} function close(){document.body.classList.remove('tenant-notify-open')}
  function bind(){
    const candidates=qa('.topbar .icon-btn,button[aria-label*="notification" i],button[title*="notification" i]');
    const target=candidates.find(b=>q('.dot',b)||/notif|activity/i.test((b.getAttribute('aria-label')||'')+(b.getAttribute('title')||'')))||candidates[0];
    if(target){target.dataset.tenantNotifications='true';target.setAttribute('aria-label','Open business activity');target.addEventListener('click',e=>{e.preventDefault();open()});}
    load(false);
  }
  async function boot(){try{await window.LolaAuth.ready;}catch{return;}mount();bind()}
  window.LolaTenantNotifications={open,close,load};if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();