/* Tenant dashboard UX — real business identity, honest empty states, no demo leakage. */
(function(){
  if(window.LolaTenantDashboard) return;
  const $=(s,r=document)=>r.querySelector(s);
  const $$=(s,r=document)=>Array.from(r.querySelectorAll(s));
  const text=(id,v)=>{const e=document.getElementById(id);if(e)e.textContent=v;};
  const money=n=>'$'+Number(n||0).toLocaleString('en-US',{maximumFractionDigits:0});
  function token(){try{return localStorage.getItem('loladesk_token')||'';}catch{return '';}}
  async function load(resource){
    const r=await fetch('/api/data?resource='+encodeURIComponent(resource),{headers:{Authorization:'Bearer '+token()}});
    const d=await r.json().catch(()=>({}));
    if(!r.ok) throw new Error(d.error||('data '+r.status));
    return d;
  }
  function personalize(tenant,owner){
    const business=tenant.name||tenant.business_name||'Your business';
    document.title=business+' — LolaDesk';
    text('navUserName',owner); text('navUserInitial',(owner[0]||'O').toUpperCase()); text('navUserRole','Owner · '+business);
    const chips=$$('.cmd-chip');
    const actions=[
      ['Review today','Give me a concise briefing for today using only my real dashboard data.'],
      ['Fill openings','Find my next open appointment gaps and recommend the best clients to contact.'],
      ['Follow up leads','Show me which real leads or unread conversations need a response first.']
    ];
    chips.forEach((chip,i)=>{const a=actions[i];if(!a)return;chip.textContent=a[0];chip.onclick=()=>window.askLola&&window.askLola(a[1]);});
    const input=$('#cmdInput'); if(input) input.placeholder='Ask Lola about '+business+'…';
    const chat=$('#chatInput'); if(chat) chat.placeholder='Message Lola about '+business+'…';
  }
  function honestState(overview,bookings){
    const k=overview?.kpis||{};
    const total=Number(k.clients||0)+Number(k.calls30||0)+Number(k.bookings30||0)+Number(k.revenue30||0);
    document.body.dataset.tenantData=total>0?'live':'empty';
    if(total>0) return;
    const banner=$('#briefingBanner'); if(banner) banner.style.display='none';
    const roi=$('#roiPanel'); if(roi) roi.style.display='none';
    const schedule=$('#scheduleList');
    if(schedule && !(bookings?.bookings||[]).length){
      schedule.innerHTML='<div class="tenant-empty"><strong>Your calendar is ready.</strong><span>Connect your booking provider or add the first appointment to activate live schedule intelligence.</span><a href="settings.html#booking">Connect booking</a></div>';
    }
    const insights=$('#insightsList');
    if(insights) insights.innerHTML='<div class="tenant-empty"><strong>Lola is learning your business.</strong><span>Real insights appear as calls, bookings and client conversations arrive.</span><a href="onboarding.html?resume=1">Complete business setup</a></div>';
  }
  function addStyles(){
    if($('#tenantDashboardStyles'))return;
    const s=document.createElement('style');s.id='tenantDashboardStyles';s.textContent=`
      .tenant-empty{display:grid;gap:7px;padding:24px;color:var(--text2);font-size:12px;line-height:1.45}
      .tenant-empty strong{color:var(--text);font-size:13px;font-weight:600}
      .tenant-empty a{width:max-content;margin-top:5px;color:var(--accent2);font-weight:600}
      body[data-tenant-data="empty"] .kpi-val{color:var(--text)!important;text-shadow:none!important}
      body[data-tenant-data="empty"] .kpi-sub{opacity:.75}
      @media(max-width:1050px){.dash-header{align-items:flex-start;flex-direction:column}.dash-header .kpi-row{min-width:0;width:100%}.grid-main{grid-template-columns:1fr 1fr}.lola-panel{grid-column:1/-1}}
      @media(max-width:720px){.main{padding:16px 14px 110px}.kpi-row{grid-template-columns:1fr 1fr}.grid-main{grid-template-columns:1fr}.lola-panel{min-height:390px}.cmd-chips{display:none}.cmd-dock{left:12px;right:12px;width:auto;transform:none}}
    `;document.head.appendChild(s);
  }
  async function boot(){
    addStyles();
    let auth;try{auth=await window.LolaAuth.ready;}catch{return;}
    const tenant=auth?.tenant||{};
    const owner=(tenant.owner_name||auth?.user?.user_metadata?.full_name||'Owner').split(' ')[0];
    personalize(tenant,owner);
    try{
      const [overview,bookings]=await Promise.all([load('overview'),load('bookings')]);
      honestState(overview,bookings);
      window.dispatchEvent(new CustomEvent('lola:tenant-dashboard-ready',{detail:{tenant,overview,bookings}}));
    }catch(e){
      document.body.dataset.tenantData='error';
      console.warn('[tenant-dashboard] real data unavailable',e);
    }
  }
  window.LolaTenantDashboard={boot};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();