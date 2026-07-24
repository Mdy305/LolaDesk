/* Lola presence bridge — one Lola, using the dashboard's existing neural orb. */
(function(){
  if(window.LolaPresence) return;

  const copy={
    idle:['Hey Lola…','Tap to speak or type a command'],
    ambient:['Hey Lola…','Listening for her name'],
    listening:['I’m listening','Speak naturally'],
    thinking:['Thinking','Working on it'],
    speaking:['Lola','Speaking…']
  };

  function central(){
    const canvas=document.getElementById('orbCanvas');
    return canvas ? (document.getElementById('orbStage') || canvas.parentElement) : null;
  }

  function removeDuplicate(){
    const duplicate=document.getElementById('lolaPresence');
    if(duplicate) duplicate.remove();
  }

  function set(mode,detail){
    removeDuplicate();
    const stage=central();
    if(!stage) return;
    const labels=copy[mode]||copy.idle;
    const title=document.getElementById('orbTitle');
    const sub=document.getElementById('orbSub');
    const mic=document.getElementById('orbMic');
    const wave=document.getElementById('orbWave');

    stage.dataset.state=mode;
    stage.setAttribute('data-lola-voice','');
    stage.setAttribute('role','button');
    stage.setAttribute('tabindex','0');
    stage.setAttribute('aria-label',(detail&&detail.text)||labels[0]);

    if(title) title.textContent=(detail&&detail.title)||labels[0];
    if(sub) sub.textContent=(detail&&detail.text)||labels[1];
    if(mic) mic.classList.toggle('on',mode==='listening');
    if(wave) wave.style.display=(mode==='listening'||mode==='speaking')?'flex':'none';

    stage.classList.toggle('ambient',mode==='ambient');
    stage.classList.toggle('is-listening',mode==='listening');
    stage.classList.toggle('is-thinking',mode==='thinking');
    stage.classList.toggle('is-speaking',mode==='speaking');
  }

  function bind(){
    removeDuplicate();
    const stage=central();
    if(!stage) return;
    stage.setAttribute('data-lola-voice','');
    stage.addEventListener('keydown',e=>{
      if(e.key==='Enter'||e.key===' '){e.preventDefault();stage.click();}
    });
  }

  window.addEventListener('lola:state',e=>set(e.detail&&e.detail.mode,e.detail));
  window.addEventListener('load',bind,{once:true});
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',()=>{bind();set(document.body.dataset.lolaState||'idle');},{once:true});
  else {bind();set(document.body.dataset.lolaState||'idle');}

  window.LolaPresence={set,mount:bind,pulse:function(){}};
})();