/* ═══════════════════════════════════════════════════════════════
   LolaDesk — shared tenant data layer
   Every request is authenticated and resolves only the signed-in tenant.
   Production failures return safe empty datasets, never demo salon records.
   ═══════════════════════════════════════════════════════════════ */
window.LolaData = (function(){
  function token(){ try{ return localStorage.getItem('loladesk_token')||''; }catch(e){ return ''; } }

  async function load(resource){
    const t=token();
    if(!t) throw new Error('Not authenticated');
    const r=await fetch('/api/data-safe?resource='+encodeURIComponent(resource),{
      headers:{Authorization:'Bearer '+t},
      credentials:'same-origin'
    });
    let data={};
    try{data=await r.json();}catch{}
    if(!r.ok) throw new Error(data.error||('data '+r.status));
    return data;
  }

  function el(tag, cls, html){ const e=document.createElement(tag); if(cls)e.className=cls; if(html!=null)e.innerHTML=html; return e; }
  function initials(name){ return (name||'?').trim().split(/\s+/).map(w=>w[0]).slice(0,2).join('').toUpperCase(); }
  function money(n){ return '$'+Number(n||0).toLocaleString('en-US',{maximumFractionDigits:0}); }
  function emptyState(title,body,href,label){
    const box=el('div','tenant-empty');
    box.innerHTML='<strong>'+String(title||'Nothing here yet')+'</strong><span>'+String(body||'Connect your tools to begin seeing live data.')+'</span>'+(href?'<br><a href="'+href+'">'+String(label||'Continue setup')+'</a>':'');
    return box;
  }

  return { load, el, initials, money, emptyState };
})();