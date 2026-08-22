/* ═══════════════════════════════════════════════════════════════
   LolaDesk — auth guard
   Validates the stored Supabase session before tenant data renders.
   Loads the shared tenant workspace on every authenticated app page.
   ═══════════════════════════════════════════════════════════════ */
(function(){
  function getToken(){ try{ return localStorage.getItem('loladesk_token')||''; }catch(e){ return ''; } }
  function getRefreshToken(){ try{ return localStorage.getItem('loladesk_refresh')||''; }catch(e){ return ''; } }
  function saveSession(session){ try{ if(session?.access_token) localStorage.setItem('loladesk_token',session.access_token); if(session?.refresh_token) localStorage.setItem('loladesk_refresh',session.refresh_token); }catch(e){} }
  function clearToken(){ try{ localStorage.removeItem('loladesk_token'); localStorage.removeItem('loladesk_refresh'); }catch(e){} }
  async function renewSession(){
    const refreshToken=getRefreshToken();
    if(!refreshToken) throw new Error('no refresh token');
    const r=await fetch('/api/auth/refresh',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({refresh_token:refreshToken})});
    const data=await r.json().catch(()=>({}));
    if(!r.ok||!data.session?.access_token) throw new Error(data.error||('refresh '+r.status));
    saveSession(data.session);
    return data.session.access_token;
  }
  async function loadSession(){
    let token=getToken();
    let r=token?await fetch('/api/auth/session',{headers:{Authorization:'Bearer '+token}}):null;
    if(!r||r.status===401){ token=await renewSession(); r=await fetch('/api/auth/session',{headers:{Authorization:'Bearer '+token}}); }
    if(!r.ok) throw new Error('session invalid: '+r.status);
    return {data:await r.json(),token};
  }
  function redirectToLogin(){ const here=encodeURIComponent(location.pathname+location.search); location.replace('login.html?next='+here); }
  function redirectToOnboarding(){ const here=encodeURIComponent(location.pathname+location.search); location.replace('onboarding.html?next='+here); }
  function isDashboard(){ return /(^|\/)dashboard\.html$/.test(location.pathname)||location.pathname==='/dashboard'; }
  function isMarketing(){ return /(^|\/)marketing(?:\.html)?$/.test(location.pathname); }
  function isSettings(){ return /(^|\/)settings(?:\.html)?$/.test(location.pathname); }
  function loadScript(src,key){
    if(document.querySelector(`script[data-${key}]`)) return;
    const script=document.createElement('script'); script.src=src; script.async=false; script.dataset[key]='true'; document.head.appendChild(script);
  }
  function loadAppRuntime(){
    loadScript('/tenant-workspace.js','tenantWorkspace');
    loadScript('/tenant-notifications.js','tenantNotifications');
    if(isMarketing()) loadScript('/tenant-campaign-approval.js','tenantCampaignApproval');
    if(isSettings()) loadScript('/integration-command-center.js','integrationCommandCenter');
    if(!isDashboard()) return;
    loadScript('/voice-compat.js','voiceCompat');
    loadScript('/tenant-dashboard.js','tenantDashboard');
    loadScript('/tenant-opportunities.js','tenantOpportunities');
    loadScript('/tenant-action-center.js','tenantActionCenter');
    // Luxury home surface — injected last so its styles win every tie.
    loadScript('/front-desk-os.js','frontDeskOs');
  }
  function actionFor(){ return {label:'Open Activation Studio',href:'activation-studio.html'}; }
  async function loadReadiness(token){
    const r=await fetch('/api/launch-readiness',{headers:{Authorization:'Bearer '+token}}); const data=await r.json().catch(()=>({}));
    if(!r.ok) throw new Error(data.error||('readiness '+r.status)); return data;
  }
  function startDashboardVoice(){
    if(typeof window.toggleVoice==='function') return window.toggleVoice();
    const mic=document.getElementById('orbMic');
    if(mic) return mic.click();
    setTimeout(()=>{ if(typeof window.toggleVoice==='function') window.toggleVoice(); },500);
  }
  function renderReadiness(token,role){
    if(!isDashboard()||!['owner','admin','manager'].includes(role)) return;
    loadReadiness(token).then(data=>{
      const main=document.querySelector('.main'); if(!main||document.getElementById('launchReadinessBanner')) return;
      const score=Number(data.score||0),next=Array.isArray(data.next_actions)?data.next_actions[0]:'',ready=!!data.can_go_live;
      const action=ready?{label:'Talk to Lola',kind:'talk'}:actionFor();
      const banner=document.createElement('button'); banner.id='launchReadinessBanner';
      banner.type='button';
      banner.title=ready?'Lola is live':(next||'Finish connecting Lola');
      banner.setAttribute('aria-label',ready?'Lola is live. Talk to Lola.':`Setup ${score}% complete. ${next||'Open Activation Studio.'}`);
      banner.style.cssText=['display:flex','align-items:center','gap:8px','height:40px','padding:0 12px','border:1px solid '+(ready?'rgba(204,255,0,.22)':'rgba(255,179,64,.3)'),'border-radius:12px','background:'+(ready?'rgba(204,255,0,.07)':'rgba(255,179,64,.08)'),'color:#f2f2f5','font:inherit','cursor:pointer','white-space:nowrap'].join(';');
      banner.innerHTML=`<span style="width:8px;height:8px;border-radius:50%;background:${ready?'#ccff00':'#ffb340'};box-shadow:0 0 10px ${ready?'rgba(204,255,0,.55)':'rgba(255,179,64,.5)'}"></span><span style="font-size:12px;font-weight:650">${ready?'Lola live':`Setup ${score}%`}</span>`;
      const actions=main.querySelector('.topbar-actions'); if(actions) actions.prepend(banner); else main.prepend(banner);
      banner.onclick=()=>{ if(action.kind==='talk') startDashboardVoice(); else location.href=action.href; };
    }).catch(err=>console.warn('[auth-guard] launch readiness unavailable:',err));
  }
  if(!getToken()&&!getRefreshToken()){redirectToLogin();throw new Error('LolaDesk auth-guard: no session, redirecting to login');}
  const ready=loadSession().then(({data,token})=>{
    if(!data?.tenant){redirectToOnboarding();throw new Error('session valid but tenant not provisioned yet');}
    const role=String(data.role||'staff').toLowerCase();
    window.LolaAuth={user:data.user,tenant:data.tenant,role,token,ready}; loadAppRuntime(); setTimeout(()=>renderReadiness(token,role),0); return window.LolaAuth;
  }).catch(err=>{if(String(err?.message||'').includes('tenant not provisioned'))return Promise.reject(err);console.warn('[auth-guard] session renewal failed, redirecting to login:',err);clearToken();redirectToLogin();throw err;});
  window.LolaAuth={ready};
})();
