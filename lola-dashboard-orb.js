/* ═══════════════════════════════════════════════════════════════
   Dashboard Living Atom bridge — mounts LolaOrb on #orbCanvas and
   connects it to LolaResonance's wake-word / voice state machine,
   including the full-screen wake-burst particle convergence.
   ═══════════════════════════════════════════════════════════════ */
(function(){
  'use strict';

  function boot(){
    const canvas = document.getElementById('orbCanvas');
    const stage = document.getElementById('orbStage');
    if(!canvas || !window.LolaOrb) return;

    const orb = LolaOrb.mount(canvas, { size: 240 });
    let lastMode = 'idle';

    // Map LolaResonance's richer mode set onto the orb's 5 visual states.
    const MODE_MAP = {
      idle:'idle', waking:'ambient', ambient:'ambient',
      listening:'listening', thinking:'thinking', speaking:'speaking',
      degraded:'idle', error:'idle'
    };

    window.addEventListener('lola:state', (e)=>{
      const mode = (e.detail && e.detail.mode) || 'idle';
      orb.setState(MODE_MAP[mode] || 'idle');

      // The wake moment: any transition INTO listening (voice wake-word
      // or a manual tap) is when Lola "comes alive" on screen.
      if(mode === 'listening' && lastMode !== 'listening'){
        orb.flare();
        if(window.LolaWakeBurst) window.LolaWakeBurst.trigger(stage || canvas);
      }
      lastMode = mode;
    });

    window.addEventListener('lola:amplitude', (e)=>{
      orb.setLevel((e.detail && e.detail.value) || 0);
    });

    // dashboard.html's markup calls toggleVoice() directly on click.
    window.toggleVoice = function(){
      if(!window.LolaResonance) return;
      if(window.LolaResonance.state.enabled) window.LolaResonance.disable();
      else window.LolaResonance.enable();
    };

    // Suggestion chips and command shortcuts call askLola(text) directly.
    window.askLola = function(text){
      if(!window.LolaResonance) return;
      if(!window.LolaResonance.state.enabled) window.LolaResonance.enable();
      window.LolaResonance.ask(text);
    };
  }

  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once:true });
  else boot();
})();
