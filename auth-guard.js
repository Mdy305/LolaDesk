/* ═══════════════════════════════════════════════════════════════
   LolaDesk — auth guard
   Validates the stored Supabase session before tenant data renders.
   Dashboard pages also surface live launch readiness and direct actions.
   ═══════════════════════════════════════════════════════════════ */
(function(){
  function getToken(){ try{ return localStorage.getItem('loladesk_token')||''; }catch(e){ return ''; } }
  function clearToken(){ try{ localStorage.removeItem('loladesk_token'); localStorage.removeItem('loladesk_refresh'); }catch(e){} }
  function redirectToLogin(){
    const here = encodeURIComponent(location.pathname + location.search);
    location.replace('login.html?next=' + here);
  }
  function redirectToOnboarding(){
    const here = encodeURIComponent(location.pathname + location.search);
    location.replace('onboarding.html?next=' + here);
  }
  function isDashboard(){
    return /(^|\/)dashboard\.html$/.test(location.pathname) || location.pathname === '/dashboard';
  }
  function actionFor(next){
    const value = String(next||'').toLowerCase();
    if(value.includes('phone') || value.includes('telnyx') || value.includes('voice')) return { label:'Provision Lola', kind:'provision' };
    if(value.includes('booking') || value.includes('calendar')) return { label:'Connect booking', href:'settings.html#booking' };
    if(value.includes('service') || value.includes('team') || value.includes('hours') || value.includes('business')) return { label:'Finish setup', href:'onboarding.html?resume=1' };
    return { label:'Finish setup', href:'onboarding.html?resume=1' };
  }
  async function loadReadiness(token){
    const r = await fetch('/api/launch-readiness', { headers:{ Authorization:'Bearer ' + token } });
    const data = await r.json().catch(()=>({}));
    if(!r.ok) throw new Error(data.error || ('readiness ' + r.status));
    return data;
  }
  async function provision(token, button, detail){
    const old = button.textContent;
    button.disabled = true;
    button.textContent = 'Provisioning…';
    try{
      const r = await fetch('/api/provision-tenant', {
        method:'POST',
        headers:{ 'Content-Type':'application/json', Authorization:'Bearer ' + token }
      });
      const data = await r.json().catch(()=>({}));
      if(!r.ok || data.ok === false) throw new Error(data.error || 'Provisioning failed');
      detail.textContent = 'Lola provisioning completed. Rechecking launch status…';
      setTimeout(()=>{ document.getElementById('launchReadinessBanner')?.remove(); renderReadiness(token); }, 1200);
    }catch(err){
      detail.textContent = 'Provisioning needs attention: ' + String(err?.message || err);
      button.disabled = false;
      button.textContent = 'Retry provisioning';
    }
  }
  function renderReadiness(token){
    if(!isDashboard()) return;
    loadReadiness(token).then(data => {
      const main = document.querySelector('.main');
      if(!main || document.getElementById('launchReadinessBanner')) return;
      const score = Number(data.score || 0);
      const next = Array.isArray(data.next_actions) ? data.next_actions[0] : '';
      const ready = !!data.can_go_live;
      const action = ready ? { label:'View status', href:'settings.html' } : actionFor(next);
      const banner = document.createElement('div');
      banner.id = 'launchReadinessBanner';
      banner.style.cssText = [
        'display:flex','align-items:center','gap:14px','padding:14px 18px',
        'margin:0 0 18px','border:1px solid rgba(204,255,0,.25)',
        'border-radius:14px','background:rgba(204,255,0,.07)','flex-wrap:wrap'
      ].join(';');
      banner.innerHTML = `
        <div style="width:42px;height:42px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:#ccff00;color:#070708;font-weight:750;flex:0 0 auto">${score}</div>
        <div style="flex:1;min-width:220px">
          <div style="font-size:13px;font-weight:650">${ready ? 'Lola is launch-ready' : 'Finish setting up Lola'}</div>
          <div id="launchReadinessDetail" style="font-size:12px;color:#8a8a92;margin-top:2px">${ready ? 'Voice, booking and tenant configuration passed the readiness check.' : (next || 'Complete the remaining launch checklist.')}</div>
        </div>
        <button id="launchReadinessAction" style="border:0;border-radius:10px;padding:9px 12px;background:${ready ? 'rgba(204,255,0,.14)' : '#ccff00'};color:${ready ? '#dcff66' : '#070708'};font-weight:650;cursor:pointer">${action.label}</button>`;
      const topbar = main.querySelector('.topbar');
      if(topbar && topbar.nextSibling) main.insertBefore(banner, topbar.nextSibling);
      else main.prepend(banner);
      const button = banner.querySelector('#launchReadinessAction');
      const detail = banner.querySelector('#launchReadinessDetail');
      button.onclick = () => action.kind === 'provision' ? provision(token, button, detail) : (location.href = action.href);
    }).catch(err => console.warn('[auth-guard] launch readiness unavailable:', err));
  }

  const token = getToken();
  if(!token){ redirectToLogin(); throw new Error('LolaDesk auth-guard: no token, redirecting to login'); }

  const ready = fetch('/api/auth/session', { headers:{ Authorization:'Bearer ' + token } })
    .then(r => { if(!r.ok) throw new Error('session invalid: ' + r.status); return r.json(); })
    .then(data => {
      if(!data?.tenant){ redirectToOnboarding(); throw new Error('session valid but tenant not provisioned yet'); }
      window.LolaAuth = { user:data.user, tenant:data.tenant, token, ready };
      setTimeout(() => renderReadiness(token), 0);
      return window.LolaAuth;
    })
    .catch(err => {
      if(String(err?.message || '').includes('tenant not provisioned')) return Promise.reject(err);
      console.warn('[auth-guard] session check failed, redirecting to login:', err);
      clearToken();
      redirectToLogin();
      throw err;
    });

  window.LolaAuth = { ready };
})();
