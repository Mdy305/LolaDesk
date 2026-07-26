/* LolaDesk dashboard experience reset — Lola first, no feature pile */
(function(){
  'use strict';
  if(!/\/?dashboard\.html$|\/$/.test(location.pathname)) return;

  // Prevent the legacy speech cleanup from throwing when playback ends.
  // The old implementation referenced an unbound `url` identifier.
  if(typeof window.url === 'undefined') window.url = '';

  function addResetCss(){
    if(document.querySelector('link[href="product-reset.css"]')) return;
    const css=document.createElement('link');
    css.rel='stylesheet';
    css.href='product-reset.css';
    document.head.appendChild(css);
  }

  function buildPresence(){
    const stage=document.getElementById('orbStage')||document.querySelector('.lola-orb-stage');
    if(!stage||stage.querySelector('.lola-presence-field')) return;
    const field=document.createElement('div');
    field.className='lola-presence-field';
    for(let i=0;i<42;i++){
      const p=document.createElement('i');
      p.className='lola-presence-particle';
      const a=(i/42)*Math.PI*2+(Math.random()*.22);
      const r=34+Math.random()*44;
      p.style.left=(50+Math.cos(a)*r)+'%';
      p.style.top=(50+Math.sin(a)*r)+'%';
      p.style.setProperty('--x',((Math.random()-.5)*34)+'px');
      p.style.setProperty('--y',((Math.random()-.5)*34)+'px');
      p.style.setProperty('--d',(4.5+Math.random()*5)+'s');
      p.style.setProperty('--delay',(-Math.random()*7)+'s');
      field.appendChild(p);
    }
    stage.prepend(field);

    // Reflect state changes into CSS without coupling to the particle engine.
    const title=document.getElementById('orbTitle');
    if(title){
      const sync=()=>{
        const t=(title.textContent||'').toLowerCase();
        const state=t.includes('listen')?'listening':t.includes('think')?'thinking':t.includes('lola')&&t.includes('speak')?'speaking':'idle';
        stage.dataset.lolaState=state;
      };
      new MutationObserver(sync).observe(title,{childList:true,characterData:true,subtree:true});
      sync();
    }
  }

  function makeLolaMoreJarvis(){
    const originalFetch=window.fetch.bind(window);
    window.fetch=async function(input,init){
      try{
        const url=typeof input==='string'?input:(input&&input.url)||'';
        if(/\/api\/(?:lola|lola-orchestra)$/.test(url) && init && typeof init.body==='string'){
          const body=JSON.parse(init.body);
          const directive=[
            'LOLA VOICE AND BEHAVIOR OVERRIDE:',
            'Speak like an elite operating intelligence: calm, precise, anticipatory, emotionally aware, and decisive.',
            'Never sound bubbly, salesy, childish, generic, or like a chatbot.',
            'Lead with the answer. Use one or two concise sentences unless detail is required.',
            'Do not invent metrics, appointments, client names, actions, or completed work.',
            'State what you know, what you recommend, and what you can execute next.',
            'When speaking to the owner, sound like a trusted chief of staff—not a customer-service script.'
          ].join('\n');
          body.system=directive+'\n\n'+String(body.system||'');
          init=Object.assign({},init,{body:JSON.stringify(body)});
        }
      }catch(e){}
      return originalFetch(input,init);
    };
  }

  function removeNoise(){
    const old=document.getElementById('revenueCommandCenter');
    if(old) old.remove();
    document.querySelectorAll('.roi-panel,.away-panel,.res-panel,.quick-grid').forEach(el=>{
      el.setAttribute('aria-hidden','true');
    });
    const prompt=document.querySelector('.lola-prompt-sub');
    if(prompt) prompt.textContent='Speak naturally. Lola listens, understands, and acts.';
  }

  addResetCss();
  makeLolaMoreJarvis();
  const ready=()=>{removeNoise();buildPresence();};
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',ready,{once:true});
  else ready();
})();