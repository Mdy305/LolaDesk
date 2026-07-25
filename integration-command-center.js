(function(){
  'use strict';
  const LABEL={healthy:'Healthy',attention:'Needs attention',blocked:'Blocked',not_connected:'Not connected',link_only:'Link only'};
  const TONE={healthy:'#ccff00',attention:'#ffcc66',blocked:'#ff7a6d',not_connected:'#8a8a92',link_only:'#8fd3ff'};
  const GLYPH={voice:'T',whatsapp:'W',square:'□',boulevard:'B',fresha:'F',vagaro:'V',mindbody:'M',shopify:'S',google_calendar:'G',website:'↗'};

  function token(){try{return window.LolaAuth?.token||localStorage.getItem('loladesk_token')||'';}catch{return '';}}
  function escapeHtml(v){return String(v||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
  function actionLabel(item){
    if(item.action==='test') return 'Test';
    if(item.action==='reconnect') return 'Reconnect';
    if(item.action==='connect') return 'Connect';
    if(item.action==='open_numbers') return 'Open numbers';
    if(item.action==='open_activation') return 'Fix setup';
    if(item.action==='refresh') return 'Refresh';
    return 'Review';
  }
  function route(item){
    if(item.action==='open_numbers') return location.href='numbers.html';
    if(item.action==='open_activation') return location.href='activation-studio.html';
    if(['connect','reconnect'].includes(item.action)&&!['voice','website','whatsapp'].includes(item.id)){
      return location.href=`/api/oauth/connect?provider=${encodeURIComponent(item.id)}`;
    }
    runHealth(item.id);
  }
  async function runHealth(id){
    const button=document.querySelector(`[data-int-action="${CSS.escape(id)}"]`);
    if(button){button.disabled=true;button.textContent='Checking…';}
    try{
      const r=await fetch('/api/integration-health',{headers:{Authorization:'Bearer '+token()}});
      const d=await r.json();
      if(!r.ok) throw new Error(d.error||'Health check failed');
      render(d);
      window.showToast?.('Connection health refreshed.','ok');
    }catch(error){
      window.showToast?.(error.message||'Could not check connection','err');
      if(button){button.disabled=false;button.textContent='Retry';}
    }
  }
  function render(data){
    const list=document.getElementById('integrationsList');
    if(!list) return;
    const header=`<div style="padding:14px 0 16px;border-bottom:.5px solid var(--border);display:flex;align-items:center;gap:14px">
      <div style="width:46px;height:46px;border-radius:50%;display:grid;place-items:center;background:rgba(204,255,0,.1);border:1px solid rgba(204,255,0,.3);font-weight:750">${Number(data.score||0)}</div>
      <div style="flex:1"><div style="font-size:14px;font-weight:650">Integration health</div><div style="font-size:11px;color:var(--text3)">${data.healthy||0} of ${data.total||0} systems verified · ${data.blockers?.length||0} launch blockers</div></div>
      <button class="connect-btn connect" id="refreshIntegrationHealth">Run diagnostics</button>
    </div>`;
    const rows=(data.integrations||[]).map(item=>{
      const color=TONE[item.status]||'#8a8a92';
      const canAct=item.action!=='none';
      return `<div class="integration" data-integration="${escapeHtml(item.id)}">
        <div class="int-logo" style="background:${color}18;color:${color};border:1px solid ${color}42">${GLYPH[item.id]||'•'}</div>
        <div class="int-info"><div class="int-name" style="display:flex;align-items:center;gap:7px">${escapeHtml(item.name)}<span style="width:7px;height:7px;border-radius:50%;background:${color};box-shadow:0 0 10px ${color}66"></span></div><div class="int-status">${escapeHtml(item.detail)} · ${LABEL[item.status]||item.status}</div></div>
        ${canAct?`<button class="connect-btn ${item.status==='healthy'?'connected':'connect'}" data-int-action="${escapeHtml(item.id)}">${actionLabel(item)}</button>`:''}
      </div>`;
    }).join('');
    list.innerHTML=header+rows;
    document.getElementById('refreshIntegrationHealth')?.addEventListener('click',()=>runHealth('all'));
    list.querySelectorAll('[data-int-action]').forEach(btn=>btn.addEventListener('click',()=>{
      const item=(data.integrations||[]).find(x=>x.id===btn.dataset.intAction);
      if(item) route(item);
    }));
  }
  function secureTelecomActions(){
    window.orderTelnyxSim=function(){
      window.showToast?.('Complete shipping and carrier verification in Phone Numbers.','ok');
      setTimeout(()=>{location.href='numbers.html#connectivity';},350);
    };
    window.portTelnyxNumber=function(){
      const input=document.getElementById('fPortNumber');
      const number=input?.value?.trim()||'';
      try{if(number) sessionStorage.setItem('loladesk_port_number',number);}catch{}
      window.showToast?.('Continue securely in Phone Numbers.','ok');
      setTimeout(()=>{location.href='numbers.html#port';},350);
    };
  }
  async function init(){
    const list=document.getElementById('integrationsList');
    if(!list) return;
    secureTelecomActions();
    list.innerHTML='<div style="padding:28px 4px;color:var(--text3);font-size:12px">Verifying every connection…</div>';
    try{
      if(window.LolaAuth?.ready) await window.LolaAuth.ready;
      const r=await fetch('/api/integration-health',{headers:{Authorization:'Bearer '+token()}});
      const d=await r.json();
      if(!r.ok) throw new Error(d.error||'Health check failed');
      render(d);
    }catch(error){
      list.innerHTML=`<div style="padding:20px 0"><div style="font-size:13px;font-weight:600;color:#ff7a6d">Integration health unavailable</div><div style="font-size:12px;color:var(--text3);margin-top:5px">${escapeHtml(error.message)}</div><button class="connect-btn connect" style="margin-top:12px" id="retryIntegrationHealth">Retry</button></div>`;
      document.getElementById('retryIntegrationHealth')?.addEventListener('click',init);
    }
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init,{once:true}); else init();
})();
