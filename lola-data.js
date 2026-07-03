/* ═══════════════════════════════════════════════════════════════
   LolaDesk — shared data layer
   Pages call LolaData.load('clients') to get their tenant's REAL data.
   Sends the auth token automatically. Returns a promise.
   Usage:
     const { clients } = await LolaData.load('clients');
   ═══════════════════════════════════════════════════════════════ */
window.LolaData = (function(){
  function token(){ try{ return localStorage.getItem('loladesk_token')||''; }catch(e){ return ''; } }

  async function load(resource){
    const headers={};
    const t=token(); if(t) headers['Authorization']='Bearer '+t;
    // also allow ?tenant= fallback for local/demo
    const tslug = new URLSearchParams(location.search).get('tenant');
    const url='/api/data?resource='+encodeURIComponent(resource)+(tslug?'&tenant='+encodeURIComponent(tslug):'');
    try{
      const r=await fetch(url,{headers});
      if(!r.ok) throw new Error('data '+r.status);
      return await r.json();
    }catch(e){
      console.warn('LolaData.load failed:',e);
      return null;
    }
  }

  // tiny render helpers shared across pages
  function el(tag, cls, html){ const e=document.createElement(tag); if(cls)e.className=cls; if(html!=null)e.innerHTML=html; return e; }
  function initials(name){ return (name||'?').trim().split(/\s+/).map(w=>w[0]).slice(0,2).join('').toUpperCase(); }
  function money(n){ return '$'+Number(n||0).toLocaleString('en-US',{maximumFractionDigits:0}); }

  return { load, el, initials, money };
})();
