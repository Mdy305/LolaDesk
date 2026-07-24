/* LolaDesk shared tenant workspace shell. Runs on every authenticated app page. */
(function(){
  if(window.LolaTenantWorkspace) return;
  const APP_PAGES=['dashboard','clients','bookings','calls','inbox','marketing','revenue','team','settings','numbers','subscription','marketer','lola-live'];
  const path=location.pathname.split('/').pop().replace(/\.html$/,'')||'dashboard';
  const q=(s,r=document)=>r.querySelector(s), qa=(s,r=document)=>Array.from(r.querySelectorAll(s));
  const text=(el,v)=>{if(el&&v!=null)el.textContent=String(v)};
  function esc(v){return String(v||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
  function tenantName(t){return t?.name||t?.business_name||'Your business';}
  function ownerName(t,u){return (t?.owner_name||u?.user_metadata?.full_name||u?.email||'Owner').trim();}
  function setIdentity(auth){
    const t=auth.tenant||{}, u=auth.user||{}, business=tenantName(t), owner=ownerName(t,u), first=owner.split(/\s+/)[0]||'Owner';
    document.documentElement.dataset.tenantId=t.id||'';
    document.documentElement.dataset.tenantSlug=t.slug||'';
    document.title=(path==='dashboard'?'Dashboard':path.replace(/(^|-)(\w)/g,(_,a,b)=>' '+b.toUpperCase()).trim())+' · '+business+' · LolaDesk';
    qa('[data-tenant-name]').forEach(el=>text(el,business));
    qa('[data-owner-name]').forEach(el=>text(el,first));
    qa('.nav-user-name,#navUserName').forEach(el=>text(el,first));
    qa('.nav-user-role,#navUserRole').forEach(el=>text(el,'Owner · '+business));
    qa('.nav-user-av,#navUserInitial').forEach(el=>text(el,(first[0]||'O').toUpperCase()));
    qa('input[placeholder*="Ask Lola"]').forEach(el=>el.placeholder='Ask Lola about '+business+'…');
    qa('.logo-sub').forEach(el=>{if(!el.textContent.trim()||/front desk|ai/i.test(el.textContent))text(el,business)});
  }
  function markNavigation(){
    qa('a[href]').forEach(a=>{
      const href=(a.getAttribute('href')||'').split('?')[0].split('#')[0];
      const p=href.split('/').pop().replace(/\.html$/,'');
      if(APP_PAGES.includes(p)){
        const active=p===path || (path==='dashboard'&&p==='dashboard');
        a.classList.toggle('active',active);
        if(active)a.setAttribute('aria-current','page'); else a.removeAttribute('aria-current');
      }
    });
  }
  function addMobileHeader(auth){
    if(q('#tenantMobileHeader')||innerWidth>820)return;
    const business=tenantName(auth.tenant);
    const bar=document.createElement('header');bar.id='tenantMobileHeader';
    bar.innerHTML=`<button type="button" aria-label="Open navigation" data-workspace-menu>☰</button><strong>${esc(business)}</strong><button type="button" aria-label="Talk to Lola" data-lola-voice>L</button>`;
    bar.style.cssText='position:sticky;top:0;z-index:9000;height:54px;display:flex;align-items:center;justify-content:space-between;padding:0 16px;background:rgba(7,7,8,.92);backdrop-filter:blur(18px);border-bottom:1px solid rgba(255,255,255,.07);font:600 13px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif';
    qa('button',bar).forEach(b=>b.style.cssText='width:34px;height:34px;border:0;border-radius:10px;background:#151518;color:#f5f5f5');
    document.body.prepend(bar);
    q('[data-workspace-menu]',bar).onclick=()=>{const side=q('.sidebar,.side-nav,aside');if(side){side.classList.toggle('workspace-open');side.style.display=side.classList.contains('workspace-open')?'flex':'';}};
  }
  function addGlobalStyles(){
    if(q('#tenantWorkspaceStyles'))return;
    const s=document.createElement('style');s.id='tenantWorkspaceStyles';s.textContent=`
      .tenant-empty{padding:34px 22px;text-align:center;border:1px dashed rgba(255,255,255,.1);border-radius:14px;color:#85858d;background:rgba(255,255,255,.018)}
      .tenant-empty strong{display:block;color:#f2f2f5;font-size:14px;margin-bottom:6px}.tenant-empty a{display:inline-flex;margin-top:14px;padding:9px 12px;border-radius:9px;background:#ccff00;color:#070708;font-weight:650;text-decoration:none}
      @media(max-width:820px){body{padding-top:0!important}.main,main{padding-left:16px!important;padding-right:16px!important}.sidebar.workspace-open,.side-nav.workspace-open,aside.workspace-open{position:fixed!important;inset:54px auto 0 0!important;z-index:8999!important;width:min(82vw,280px)!important;height:auto!important;background:#0c0c0e!important}.grid-main,.content-grid,.page-grid{grid-template-columns:1fr!important}.kpi-row{grid-template-columns:repeat(2,minmax(0,1fr))!important}}
      @media(max-width:480px){.kpi-row{grid-template-columns:1fr!important}}
    `;document.head.appendChild(s);
  }
  function installLogout(){
    qa('[data-logout],a[href*="logout"],button[onclick*="logout"]').forEach(el=>el.addEventListener('click',e=>{e.preventDefault();try{localStorage.removeItem('loladesk_token');localStorage.removeItem('loladesk_refresh');sessionStorage.removeItem('loladesk_tenant');}catch{}location.replace('login.html');}));
  }
  async function boot(){
    let auth;try{auth=await window.LolaAuth.ready;}catch{return;}
    addGlobalStyles();setIdentity(auth);markNavigation();addMobileHeader(auth);installLogout();
    window.dispatchEvent(new CustomEvent('lola:tenant-ready',{detail:auth}));
  }
  window.LolaTenantWorkspace={boot};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();