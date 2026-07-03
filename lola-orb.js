/* ═══════════════════════════════════════════════════════════════
   LolaOrb — Lola's neural particle resonance engine
   ════════════════════════════════════════════════════════════════
   One Lola, everywhere. This is the single visual identity for Lola
   across the dashboard, onboarding, and login — a living network of
   neurons and synapses that breathes, listens, thinks, and speaks.

   Design language (the "resonance" model):
   · idle       — slow breath. Dim rose. She's present, at rest.
   · ambient    — soft rhythmic pulse + faint halo. Passively waiting
                  to hear her name (wake word armed).
   · listening  — the network leans IN: particles pull toward center,
                  violet palette, and the live mic amplitude ripples
                  inward toward her core (sound flowing into her).
   · thinking   — orbital swirl accelerates and synapses FIRE: bright
                  pulses travel neuron-to-neuron along connections.
   · speaking   — resonance rings radiate OUTWARD from the core in
                  sync with the actual amplitude of her real
                  ElevenLabs voice (sound flowing out of her).

   API:
     const orb = LolaOrb.mount(canvas, { size, particles });
     orb.setState('idle'|'ambient'|'listening'|'thinking'|'speaking');
     orb.setLevel(0..1);     // audio resonance amplitude
     orb.flare();            // one-shot burst (wake word hit, go-live)
     orb.destroy();

   Audio helpers (both best-effort; never throw):
     LolaOrb.attachAudioElement(orb, audioEl)  // Lola's voice → orb
     LolaOrb.attachMic(orb)                    // owner's mic → orb
       → returns { stop() } to release the mic track.

   Respects prefers-reduced-motion: renders a calm static glow with
   no particle animation and no pulses.
   ═══════════════════════════════════════════════════════════════ */
(function(global){
  'use strict';

  const REDUCED = typeof matchMedia === 'function'
    && matchMedia('(prefers-reduced-motion: reduce)').matches;

  const PALETTES = {
    idle:      { a:[255,45,142],  b:[120,25,90],   core:[255,80,140],  glow:.30 },
    ambient:   { a:[255,45,142],  b:[140,30,100],  core:[255,100,160], glow:.38 },
    listening: { a:[255,107,176], b:[166,75,255],  core:[240,200,255], glow:.55 },
    thinking:  { a:[255,150,120], b:[255,45,142],  core:[255,220,180], glow:.50 },
    speaking:  { a:[255,158,201], b:[200,80,255],  core:[255,255,255], glow:.62 }
  };

  function lerp(a,b,t){ return a+(b-a)*t; }
  function mix(c1,c2,t){ return [lerp(c1[0],c2[0],t)|0, lerp(c1[1],c2[1],t)|0, lerp(c1[2],c2[2],t)|0]; }
  function rgba(c,a){ return `rgba(${c[0]},${c[1]},${c[2]},${Math.max(0,Math.min(1,a))})`; }

  function mount(canvas, opts={}){
    if(!canvas || !canvas.getContext) return nullOrb();
    const ctx = canvas.getContext('2d');
    const cssSize = opts.size || canvas.clientWidth || canvas.width || 240;
    const dpr = Math.min(global.devicePixelRatio || 1, 2);
    canvas.width = cssSize * dpr;
    canvas.height = cssSize * dpr;
    ctx.scale(dpr, dpr);
    const S = cssSize, C = S/2;
    const baseR = S * 0.30;

    const N = opts.particles || Math.round(S/3.2);          // neuron count scales with size
    const LINK = baseR * 0.62;                              // synapse connect distance
    const neurons = [];
    for(let i=0;i<N;i++){
      const a = Math.random()*Math.PI*2;
      // bias toward a shell with a soft-filled interior — reads as a 3D nucleus
      const r = baseR * (0.35 + 0.65*Math.pow(Math.random(), 0.55));
      neurons.push({
        a, r, r0:r,
        z: Math.random(),                                   // pseudo-depth → size/alpha
        spd: (0.12 + Math.random()*0.35) * (Math.random()<0.5?-1:1),
        wob: Math.random()*Math.PI*2,
        wobSpd: 0.4 + Math.random()*1.1,
        x:0, y:0
      });
    }

    const pulses = [];   // synapse firing: {from,to,t,spd}
    const rings  = [];   // resonance rings: {r,alpha,dir}

    const st = {
      state:'idle', t:0,
      energy:0, energyTarget:0,
      level:0, levelSm:0,                                   // raw + smoothed audio amplitude
      flare:0,
      pal: { a:[...PALETTES.idle.a], b:[...PALETTES.idle.b], core:[...PALETTES.idle.core], glow:PALETTES.idle.glow },
      raf:0, dead:false
    };

    function setState(s){
      if(!PALETTES[s]) s='idle';
      st.state = s;
      st.energyTarget = (s==='listening'||s==='speaking') ? 1 : s==='thinking' ? 0.65 : s==='ambient' ? 0.25 : 0;
    }
    function setLevel(v){ st.level = Math.max(0, Math.min(1, v||0)); }
    function flare(){ st.flare = 1; if(!REDUCED) for(let k=0;k<3;k++) rings.push({ r:baseR*0.4, alpha:.7-k*.15, dir:1, w:2.5-k*.5 }); }

    function step(){
      st.t += 0.016;
      st.energy += (st.energyTarget - st.energy)*0.08;
      st.levelSm += (st.level - st.levelSm)*0.25;
      st.flare *= 0.94;
      const target = PALETTES[st.state];
      st.pal.a = mix(st.pal.a, target.a, .05);
      st.pal.b = mix(st.pal.b, target.b, .05);
      st.pal.core = mix(st.pal.core, target.core, .05);
      st.pal.glow = lerp(st.pal.glow, target.glow, .05);

      const speaking = st.state==='speaking', listeningS = st.state==='listening', thinking = st.state==='thinking';
      const breath = st.state==='ambient' ? Math.sin(st.t*1.4)*0.06 : Math.sin(st.t*0.7)*0.025;
      const res = st.levelSm * (speaking||listeningS ? 1 : 0);
      const scale = 1 + breath + st.energy*0.10 + res*0.22 + st.flare*0.35;
      const pull = listeningS ? 0.85 : 1;                    // listening leans the network inward
      const swirl = thinking ? 2.2 : 1;

      // move neurons
      for(const n of neurons){
        n.a += n.spd * 0.016 * swirl;
        n.wob += n.wobSpd * 0.016 * (1 + res);
        const wobble = Math.sin(n.wob)* (2 + st.energy*4 + res*6);
        const r = (n.r0 * pull + wobble) * scale;
        n.x = C + Math.cos(n.a) * r;
        n.y = C + Math.sin(n.a) * r * 0.96;                 // slight oblateness — feels dimensional
      }

      // fire synapses while thinking/speaking
      if(!REDUCED && (thinking || speaking) && Math.random() < (thinking? .22 : .12) + res*.2 && pulses.length < 26){
        const i = (Math.random()*N)|0;
        let best=-1, bd=1e9;
        for(let j=0;j<N;j++){ if(j===i) continue;
          const dx=neurons[j].x-neurons[i].x, dy=neurons[j].y-neurons[i].y, d=dx*dx+dy*dy;
          if(d<bd && d < LINK*LINK*1.4){ bd=d; best=j; } }
        if(best>=0) pulses.push({ from:i, to:best, t:0, spd: 1.6+Math.random()*1.6 });
      }

      // resonance rings: speaking radiates OUT with her voice; listening ripples IN with yours
      if(!REDUCED && (speaking||listeningS) && st.levelSm > .12 && Math.random() < st.levelSm*.5 && rings.length < 8){
        rings.push(speaking
          ? { r: baseR*0.5*scale, alpha: .28+st.levelSm*.4, dir: 1, w: 1+st.levelSm*2 }
          : { r: baseR*1.5*scale, alpha: .22+st.levelSm*.3, dir:-1, w: 1+st.levelSm*1.5 });
      }
    }

    function draw(){
      ctx.clearRect(0,0,S,S);
      const P = st.pal;
      const e = st.energy, f = st.flare, res = st.levelSm;

      // ambient halo
      ctx.globalCompositeOperation = 'source-over';
      const halo = ctx.createRadialGradient(C,C,0,C,C,S*0.5);
      halo.addColorStop(0, rgba(P.a, .10 + e*.10 + f*.2));
      halo.addColorStop(.55, rgba(P.b, .05 + e*.05));
      halo.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = halo;
      ctx.fillRect(0,0,S,S);

      if(REDUCED){ drawCore(1); return; }

      ctx.globalCompositeOperation = 'screen';

      // synapses
      ctx.lineWidth = 0.6;
      for(let i=0;i<N;i++){
        const a = neurons[i];
        for(let j=i+1;j<N;j++){
          const b = neurons[j];
          const dx=a.x-b.x, dy=a.y-b.y, d2=dx*dx+dy*dy;
          if(d2 > LINK*LINK) continue;
          const d = Math.sqrt(d2);
          const al = (1 - d/LINK) * (0.10 + e*0.16 + res*0.12) * Math.min(a.z,b.z)+ .02;
          ctx.strokeStyle = rgba(mix(P.a,P.b,.5), al);
          ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
        }
      }

      // neurons
      for(const n of neurons){
        const sz = 0.7 + n.z*1.6 + e*0.8 + res*1.2;
        const al = 0.25 + n.z*0.45 + e*0.25 + f*0.4;
        ctx.fillStyle = rgba(mix(P.a,P.core,n.z*.5), al);
        ctx.beginPath(); ctx.arc(n.x,n.y,sz,0,7); ctx.fill();
      }

      // firing pulses along synapses
      for(let k=pulses.length-1;k>=0;k--){
        const p = pulses[k];
        p.t += 0.016*p.spd;
        if(p.t>=1){ pulses.splice(k,1); continue; }
        const a=neurons[p.from], b=neurons[p.to];
        const x=lerp(a.x,b.x,p.t), y=lerp(a.y,b.y,p.t);
        const tail = Math.max(0, p.t-0.12);
        ctx.strokeStyle = rgba(P.core, .5*(1-p.t));
        ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.moveTo(lerp(a.x,b.x,tail), lerp(a.y,b.y,tail)); ctx.lineTo(x,y); ctx.stroke();
        ctx.fillStyle = rgba(P.core, .85*(1-p.t*.5));
        ctx.beginPath(); ctx.arc(x,y,1.6,0,7); ctx.fill();
      }

      // resonance rings
      for(let k=rings.length-1;k>=0;k--){
        const r = rings[k];
        r.r += r.dir * (0.8 + res*1.6);
        r.alpha *= 0.965;
        if(r.alpha < .02 || r.r < baseR*0.3 || r.r > S*0.52){ rings.splice(k,1); continue; }
        ctx.strokeStyle = rgba(P.a, r.alpha);
        ctx.lineWidth = r.w;
        ctx.beginPath(); ctx.arc(C,C,r.r,0,7); ctx.stroke();
      }

      drawCore(1);
    }

    function drawCore(mult){
      const P = st.pal, e = st.energy, f = st.flare, res = st.levelSm;
      ctx.globalCompositeOperation = 'lighter';
      const coreR = (baseR*0.5 + e*baseR*0.14 + res*baseR*0.22 + f*baseR*0.3) * mult;
      const g = ctx.createRadialGradient(C,C,0,C,C,coreR*1.3);
      g.addColorStop(0, rgba([255,255,255], (P.glow*0.8 + res*0.3 + f*0.5)));
      g.addColorStop(0.35, rgba(P.core, (P.glow*0.7 + res*0.25 + f*0.35)));
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(C,C,coreR*1.3,0,7); ctx.fill();
    }

    function loop(){
      if(st.dead) return;
      if(!REDUCED) step(); else { st.t+=0.016; st.energy += (st.energyTarget-st.energy)*0.08; st.flare*=0.94; st.levelSm += (st.level-st.levelSm)*0.25;
        const target = PALETTES[st.state];
        st.pal.a=mix(st.pal.a,target.a,.05); st.pal.b=mix(st.pal.b,target.b,.05); st.pal.core=mix(st.pal.core,target.core,.05); st.pal.glow=lerp(st.pal.glow,target.glow,.05); }
      draw();
      st.raf = requestAnimationFrame(loop);
    }
    loop();

    return {
      setState, setLevel, flare,
      get state(){ return st.state; },
      destroy(){ st.dead = true; cancelAnimationFrame(st.raf); }
    };
  }

  function nullOrb(){ return { setState(){}, setLevel(){}, flare(){}, destroy(){}, state:'idle' }; }

  /* ── audio → resonance bridges (best-effort, never throw) ── */
  let sharedCtx = null;
  function audioCtx(){
    try{ if(!sharedCtx) sharedCtx = new (global.AudioContext||global.webkitAudioContext)(); if(sharedCtx.state==='suspended') sharedCtx.resume(); return sharedCtx; }
    catch(e){ return null; }
  }
  // Browsers keep a fresh AudioContext 'suspended' until a user gesture;
  // Safari even ignores resume() without one. Unlock on the first
  // interaction so resonance starts working from the second utterance on.
  try{
    const unlock = ()=>{ try{ if(sharedCtx && sharedCtx.state==='suspended') sharedCtx.resume(); }catch(e){} };
    ['pointerdown','touchstart','keydown'].forEach(ev => global.addEventListener(ev, unlock, { passive:true }));
  }catch(e){}
  function meter(orb, node, ac, onDone){
    try{
      const an = ac.createAnalyser(); an.fftSize = 256;
      node.connect(an);
      const buf = new Uint8Array(an.frequencyBinCount);
      let live = true;
      (function tick(){
        if(!live) return;
        an.getByteFrequencyData(buf);
        let sum=0; for(let i=2;i<buf.length;i++) sum += buf[i];
        orb.setLevel(Math.min(1, (sum/buf.length)/110));
        requestAnimationFrame(tick);
      })();
      return { stop(){ live=false; orb.setLevel(0); try{ node.disconnect(an); }catch(e){} if(onDone) onDone(); } };
    }catch(e){ return { stop(){} }; }
  }

  // Route an <audio> element (Lola's ElevenLabs playback) into the orb.
  // CRITICAL RULE: her VOICE outranks the visualization. Once an element
  // is wired through createMediaElementSource it can ONLY play via the
  // AudioContext — so if that context isn't actually 'running' (Safari
  // pre-gesture, autoplay policies), we must NOT touch the element at
  // all: playback stays native and audible, the orb just doesn't pulse
  // until the context unlocks on the first tap. Silent Lola is a bug;
  // a non-pulsing orb is a shrug.
  const wired = new WeakMap();
  function attachAudioElement(orb, el){
    const ac = audioCtx(); if(!ac || !el) return { stop(){} };
    if(ac.state !== 'running') return { stop(){} }; // voice > visuals
    try{
      let src = wired.get(el);
      if(!src){ src = ac.createMediaElementSource(el); src.connect(ac.destination); wired.set(el, src); }
      return meter(orb, src, ac);
    }catch(e){ return { stop(){} }; }
  }

  // Open a parallel mic stream purely for visual resonance while listening.
  async function attachMic(orb){
    const ac = audioCtx(); if(!ac || !navigator.mediaDevices?.getUserMedia) return { stop(){} };
    try{
      const stream = await navigator.mediaDevices.getUserMedia({ audio:true });
      const src = ac.createMediaStreamSource(stream);
      const m = meter(orb, src, ac, ()=> stream.getTracks().forEach(t=>t.stop()));
      return m;
    }catch(e){ return { stop(){} }; }
  }

  global.LolaOrb = { mount, attachAudioElement, attachMic };
})(window);
