/* Lola living presence — premium visual state layer. */
(function(){
  if(window.LolaPresence) return;
  const copy={idle:'Tap to talk',ambient:'Say “Hey Lola”',listening:'I’m listening',thinking:'Thinking',speaking:'Lola is speaking'};
  let root,status,pulseTimer;
  function ensureStyles(){
    if(document.querySelector('link[data-lola-presence]')) return;
    const link=document.createElement('link');
    link.rel='stylesheet'; link.href='/lola-resonance.css'; link.dataset.lolaPresence='true';
    document.head.appendChild(link);
  }
  function mount(){
    if(root) return root;
    ensureStyles();
    root=document.createElement('div'); root.id='lolaPresence'; root.setAttribute('role','button'); root.setAttribute('tabindex','0'); root.setAttribute('aria-label','Talk to Lola');
    root.innerHTML='<div class="lp-stage" data-lola-voice><span class="lp-aura"></span><span class="lp-wave"></span><span class="lp-wave"></span><span class="lp-wave"></span><span class="lp-ring"></span><span class="lp-core"></span></div><div class="lp-label">LOLA</div><div class="lp-status" aria-live="polite">Tap to talk</div>';
    document.body.appendChild(root); status=root.querySelector('.lp-status');
    root.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();root.querySelector('[data-lola-voice]').click();}});
    return root;
  }
  function pulse(){
    if(!root) return;
    root.classList.remove('lp-pulse'); void root.offsetWidth; root.classList.add('lp-pulse');
    clearTimeout(pulseTimer); pulseTimer=setTimeout(()=>root&&root.classList.remove('lp-pulse'),180);
  }
  function set(mode,detail){
    mount();
    const text=(detail&&detail.text)||copy[mode]||'Lola';
    status.textContent=text;
    root.dataset.state=mode;
    root.setAttribute('aria-label',text);
    if(mode==='speaking') pulse();
  }
  window.addEventListener('lola:state',e=>set(e.detail&&e.detail.mode,e.detail));
  window.addEventListener('lola:voice-boundary',pulse);
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',()=>set(document.body.dataset.lolaState||'idle'),{once:true}); else set(document.body.dataset.lolaState||'idle');
  window.LolaPresence={set,pulse,mount};
})();
