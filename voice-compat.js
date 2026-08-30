/* P0 dashboard voice compatibility and production orchestration bridge. */
(function(){
  if(window.LolaVoiceCompat) return;

  let pendingAction=null;

  function ensure(id,parent,styles){
    let el=document.getElementById(id);
    if(el) return el;
    el=document.createElement('div');
    el.id=id;
    el.setAttribute('aria-live','polite');
    el.style.cssText=styles||'';
    (parent||document.body).appendChild(el);
    return el;
  }

  function injectPending(init){
    if(!pendingAction||!init?.body||typeof init.body!=='string') return init;
    try{
      const body=JSON.parse(init.body);
      if(!body.pending) body.pending=pendingAction;
      return {...init,body:JSON.stringify(body)};
    }catch{return init;}
  }

  function installOrchestraBridge(){
    if(window.__lolaOrchestraFetchInstalled) return;
    window.__lolaOrchestraFetchInstalled=true;
    const nativeFetch=window.fetch.bind(window);
    window.fetch=async function(input,init){
      let target=input;
      let options=init;
      const url=typeof input==='string'?input:(input&&input.url)||'';
      const isLola=url==='/api/lola'||/\/api\/lola(?:\?|$)/.test(url);
      if(isLola){
        target=typeof input==='string'?'/api/lola-orchestra':new Request('/api/lola-orchestra',input);
        options=injectPending(init);
      }
      const response=await nativeFetch(target,options);
      if(isLola&&response.headers.get('content-type')?.includes('application/json')){
        try{
          const data=await response.clone().json();
          if(data?.orchestration){
            window.dispatchEvent(new CustomEvent('lola:orchestration',{detail:data.orchestration}));
            document.body.dataset.lolaAgents=(data.orchestration.agents||[]).map(a=>a.id).join(',');
          }
          if(data?.needs_confirmation&&data?.pending){
            pendingAction=data.pending;
            window.dispatchEvent(new CustomEvent('lola:confirmation-required',{detail:{pending:data.pending,plan:data.orchestration}}));
          }else if(data?.executed||data?.pending===null){
            pendingAction=null;
          }
          if(data?.executed){
            const ok=data.execution_ok!==false;
            window.dispatchEvent(new CustomEvent('lola:execution',{detail:{ok,result:data.result,plan:data.orchestration}}));
          }
          if(data?.degraded) window.dispatchEvent(new CustomEvent('lola:degraded',{detail:{error:data.error,plan:data.orchestration}}));
        }catch{}
      }
      return response;
    };
  }

  function mount(){
    installOrchestraBridge();
    const zone=document.querySelector('.lola-orb-zone')||document.querySelector('.lola-panel')||document.body;
    const prompt=document.querySelector('.lola-prompt')||zone;
    const transcript=ensure('orbTranscript',prompt,'min-height:18px;margin-top:8px;text-align:center;font:500 12px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#dcff66;opacity:.9');
    const wave=ensure('orbWave',prompt,'display:none;align-items:center;justify-content:center;gap:4px;height:18px;margin-top:8px');
    if(!wave.children.length){
      for(let i=0;i<7;i++){
        const bar=document.createElement('i');
        bar.style.cssText=`display:block;width:3px;height:${5+(i%4)*3}px;border-radius:999px;background:#ccff00;box-shadow:0 0 8px rgba(204,255,0,.35);animation:lolaVoiceBar .7s ease-in-out ${i*.07}s infinite alternate`;
        wave.appendChild(bar);
      }
    }
    if(!document.getElementById('lolaVoiceCompatStyle')){
      const style=document.createElement('style'); style.id='lolaVoiceCompatStyle';
      style.textContent='@keyframes lolaVoiceBar{from{transform:scaleY(.45);opacity:.45}to{transform:scaleY(1.35);opacity:1}} body[data-lola-voice-error="1"] #orbSub{color:#ffb340!important}';
      document.head.appendChild(style);
    }
    window.addEventListener('error',event=>{
      const message=String(event?.error?.message||event?.message||'');
      if(!/speech|microphone|audio|orbTranscript|orbWave|orchestra/i.test(message)) return;
      document.body.dataset.lolaVoiceError='1';
      const sub=document.getElementById('orbSub');
      if(sub) sub.textContent='Voice needs attention — tap Lola to retry';
      console.error('[Lola runtime]',event.error||event.message);
    });
    return {transcript,wave};
  }

  window.LolaVoiceCompat={mount,installOrchestraBridge,getPending:()=>pendingAction,clearPending:()=>{pendingAction=null;}};
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',mount,{once:true}); else mount();
})();
