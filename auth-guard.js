/* ═══════════════════════════════════════════════════════════════
   LolaDesk — auth guard
   Validates the stored Supabase session before tenant data renders.
   Loads the shared tenant workspace on every authenticated app page.
   ═══════════════════════════════════════════════════════════════ */
(function(){
  function getToken(){ try{ return localStorage.getItem('loladesk_token')||''; }catch(e){ return ''; } }
  function clearToken(){ try{ localStorage.removeItem('loladesk_token'); localStorage.removeItem('loladesk_refresh'); }catch(e){} }
  function redirectToLogin(){ const here=encodeURIComponent(location.pathname+location.search); location.replace('login.html?next='+here); }
  function redirectToOnboarding(){ const here=encodeURIComponent(location.pathname+location.search); location.replace('onboarding.html?next='+here); }
  function isDashboard(){ return /(^|\/)dashboard\.html$/.test(location.pathname)||location.pathname==='/dashboard'; }
  function loadScript(src,key){
    if(document.querySelector(`script[data-${key}]`)) return;
    const script=document.createElement('script'); script.src=src; script.async=false; script.dataset[key]='true'; document.head.appendChild(script);
  }
  function loadAppRuntime(){
    loadScript('/tenant-workspace.js','tenantWorkspace');
    if(!isDashboard()) return;
    loadScript('/lola-presence.js','lolaPresence');
    loadScript('/lola-resonance.js','lolaResonance');
    loadScript('/tenant-dashboard.js','tenantDashboard');
  }
  function actionFor(next){
    const value=String(next||'').toLowerCase();
    if(value.includes('phone')||value.includes('telnyx')||value.includes('voice')) return {label:'Connect voice',href:'settings.html#voice'};
    if(value.includes('booking')||value.includes('calendar')) return {label:'Connect booking',href:'settings.html#booking'};
    return {label:'Finish setup',href:'onboarding.html?resume=1'};
  }
  async function loadReadiness(token){
    const r=await fetch('/api/launch-readiness',{headers:{Authorization:'Bearer '+token}}); const data=await r.json().catch(()=>({}));
    if(!r.ok) throw new Error(data.error||('readiness '+r.status)); return data;
  }
  function renderReadiness(token,role){
    if(!isDashboard()||!['owner','admin','manager'].includes(role)) return;
    loadReadiness(token).then(data=>{
      const main=document.querySelector('.main'); if(!main||document.getElementById('launchReadinessBanner')) return;
      const score=Number(data.score||0),next=Array.isArray(data.next_actions)?data.next_actions[0]:'',ready=!!data.can_go_live;
      const action=ready?{label:'Talk to Lola',kind:'talk'}:actionFor(next);
      const banner=document.createElement('div'); banner.id='launchReadinessBanner';
      banner.style.cssText=['display:flex','align-items:center','gap:14px','padding:14px 18px','margin:0 0 18px','border:1px solid rgba(204,255,0,.25)','border-radius:14px','background:rgba(204,255,0,.07)','flex-wrap:wrap'].join(';');
      banner.innerHTML=`<div style="width:42px;height:42px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:#ccff00;color:#070708;font-weight:750;flex:0 0 auto">${score}</div><div style="flex:1;min-width:220px"><div style="font-size:13px;font-weight:650">${ready?'Lola is ready to work with you':'Finish connecting Lola'}</div><div style="font-size:12px;color:#8a8a92;margin-top:2px">${ready?'Say “Hey Lola” or tap the living presence to speak.':(next||'Complete the remaining launch checklist.')}</div></div><button id="launchReadinessAction" style="border:0;border-radius:10px;padding:9px 12px;background:#ccff00;color:#070708;font-weight:650;cursor:pointer">${action.label}</button>`;
      const topbar=main.querySelector('.topbar'); if(topbar&&topbar.nextSibling) main.insertBefore(banner,topbar.nextSibling); else main.prepend(banner);
      banner.querySelector('#launchReadinessAction').onclick=()=>{ if(action.kind==='talk'){ if(window.LolaResonance) window.LolaResonance.enable(); else setTimeout(()=>window.LolaResonance?.enable(),500); } else location.href=action.href; };
    }).catch(err=>console.warn('[auth-guard] launch readiness unavailable:',err));
  }
  const token=getToken(); if(!token){redirectToLogin();throw new Error('LolaDesk auth-guard: no token, redirecting to login');}
  const ready=fetch('/api/auth/session',{headers:{Authorization:'Bearer '+token}}).then(r=>{if(!r.ok)throw new Error('session invalid: '+r.status);return r.json();}).then(data=>{
    if(!data?.tenant){redirectToOnboarding();throw new Error('session valid but tenant not provisioned yet');}
    const role=String(data.role||'staff').toLowerCase();
    window.LolaAuth={user:data.user,tenant:data.tenant,role,token,ready}; loadAppRuntime(); setTimeout(()=>renderReadiness(token,role),0); return window.LolaAuth;
  }).catch(err=>{if(String(err?.message||'').includes('tenant not provisioned'))return Promise.reject(err);console.warn('[auth-guard] session check failed, redirecting to login:',err);clearToken();redirectToLogin();throw err;});
  window.LolaAuth={ready};
})();
