/* P0 dashboard voice compatibility guard.
   app.js is the single owner of microphone, wake word, ElevenLabs playback,
   and orb state. This shim restores DOM hooks expected by that runtime and
   exposes visible diagnostics instead of allowing silent TypeErrors. */
(function(){
  if(window.LolaVoiceCompat) return;

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

  function mount(){
    const zone=document.querySelector('.lola-orb-zone')||document.querySelector('.lola-panel')||document.body;
    const prompt=document.querySelector('.lola-prompt')||zone;

    /* app.js previously dereferenced both elements without checking them.
       Their absence stopped SpeechRecognition on the first transcript/state. */
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
      if(!/speech|microphone|audio|orbTranscript|orbWave/i.test(message)) return;
      document.body.dataset.lolaVoiceError='1';
      const sub=document.getElementById('orbSub');
      if(sub) sub.textContent='Voice needs attention — tap Lola to retry';
      console.error('[Lola voice runtime]',event.error||event.message);
    });

    return {transcript,wave};
  }

  window.LolaVoiceCompat={mount};
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',mount,{once:true}); else mount();
})();