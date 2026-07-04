/* ═══════════════════════════════════════════════════════════════
   LolaOrb — Lola's neural particle resonance engine  v2
   ════════════════════════════════════════════════════════════════
   One Lola, everywhere. The single visual identity for Lola across
   the dashboard, widget, onboarding, and login — a living network
   of neon-pink neurons and synapses that is ALWAYS alive, and
   resonates in sync with every word she speaks.

   Design language (the "resonance" model):
   · idle       — ALWAYS alive. Synapses fire continuously at a low
                  cadence. Neon pink, slow orbital drift. She is
                  present, watching, never sleeping.
   · ambient    — pulse rate picks up. Halo brightens. Wake word armed.
   · listening  — network leans IN toward center, violet-pink shift,
                  mic amplitude ripples inward (sound flowing into her).
   · thinking   — orbital swirl 2×, synapses FIRE rapidly neuron→neuron.
   · speaking   — resonance rings radiate OUTWARD in sync with her
                  actual ElevenLabs voice amplitude.

   API:
     const orb = LolaOrb.mount(canvas, { size, particles });
     orb.setState('idle'|'ambient'|'listening'|'thinking'|'speaking');
     orb.setLevel(0..1);   // audio amplitude (0–1)
     orb.flare();          // one-shot burst (wake-word hit / go-live)
     orb.destroy();

   Audio helpers (best-effort, never throw):
     LolaOrb.attachAudioElement(orb, audioEl)  // Lola's voice → orb
     LolaOrb.attachMic(orb)                    // mic → orb, returns {stop()}

   Respects prefers-reduced-motion.
   ═══════════════════════════════════════════════════════════════ */
(function(global){
  'use strict';

  const REDUCED = typeof matchMedia === 'function'
    && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ── Neon pink palette — always vivid, never dim ──────────────────
  const PALETTES = {
    idle:      { a:[255, 45,142], b:[180, 20,110], core:[255,120,180], glow:.42, pulseRate:.18 },
    ambient:   { a:[255, 60,155], b:[200, 30,120], core:[255,150,200], glow:.52, pulseRate:.28 },
    listening: { a:[255,100,200], b:[160, 70,255], core:[240,200,255], glow:.60, pulseRate:.20 },
    thinking:  { a:[255,160,100], b:[255, 45,142], core:[255,230,180], glow:.55, pulseRate:.50 },
    speaking:  { a:[255,180,220], b:[210, 90,255], core:[255,255,255], glow:.70, pulseRate:.35 }
  };

  function lerp(a,b,t){ return a+(b-a)*t; }
  function mix(c1,c2,t){ return [lerp(c1[0],c2[0],t)|0,lerp(c1[1],c2[1],t)|0,lerp(c1[2],c2[2],t)|0]; }
  function rgba(c,a){ return `rgba(${c[0]},${c[1]},${c[2]},${Math.max(0,Math.min(1,a))})`; }

  function mount(canvas, opts={}){
    if(!canvas || !canvas.getContext) return nullOrb();
    const ctx = canvas.getContext('2d');
    const cssSize = opts.size || canvas.clientWidth || canvas.width || 240;
    const dpr = Math.min(global.devicePixelRatio || 1, 2);
    canvas.width  = cssSize * dpr;
    canvas.height = cssSize * dpr;
    ctx.scale(dpr, dpr);
    const S = cssSize, C = S/2;
    const sf = S / 240.0;
    const baseR = S * 0.30;

    const N    = opts.particles || Math.min(150, Math.round(S / 4.0));   // bounded neuron count for elegance
    const LINK = baseR * 0.68;                             // synapse connect distance
    const neurons = [];
    for(let i=0;i<N;i++){
      const a = Math.random()*Math.PI*2;
      const r = baseR * (0.28 + 0.72*Math.pow(Math.random(), 0.50)); // denser shell
      neurons.push({
        a, r, r0:r,
        z:    Math.random(),
        spd:  (0.10 + Math.random()*0.30) * (Math.random()<0.5?-1:1),
        wob:  Math.random()*Math.PI*2,
        wobSpd: 0.3 + Math.random()*0.9,
        x:0, y:0
      });
    }

    const pulses = [];  // {from,to,t,spd}
    const rings  = [];  // {r,alpha,dir,w}

    const st = {
      state:'idle', t:0,
      energy:0, energyTarget:0.15,     // idle never goes to 0 — always has life
      level:0,  levelSm:0,
      flare:0,
      pal:{ a:[...PALETTES.idle.a], b:[...PALETTES.idle.b], core:[...PALETTES.idle.core],
            glow:PALETTES.idle.glow, pulseRate:PALETTES.idle.pulseRate },
      raf:0, dead:false
    };

    function setState(s){
      if(!PALETTES[s]) s='idle';
      st.state = s;
      // idle keeps a base energy of 0.15 so she's always visibly alive
      const base = s==='idle' ? 0.15 : s==='ambient' ? 0.30 : 0;
      st.energyTarget = (s==='listening'||s==='speaking') ? 1 : s==='thinking' ? 0.70 : base;
    }
    function setLevel(v){ st.level = Math.max(0, Math.min(1, v||0)); }
    function flare(){
      st.flare = 1;
      if(!REDUCED) for(let k=0;k<4;k++)
        rings.push({ r:baseR*0.35, alpha:.80-k*.15, dir:1, w:3-k*.5 });
    }

    function step(){
      st.t += 0.016;
      st.energy   += (st.energyTarget - st.energy) * 0.07;
      st.levelSm  += (st.level - st.levelSm) * 0.25;
      st.flare    *= 0.93;

      const target = PALETTES[st.state];
      st.pal.a          = mix(st.pal.a,    target.a,    .06);
      st.pal.b          = mix(st.pal.b,    target.b,    .06);
      st.pal.core       = mix(st.pal.core, target.core, .06);
      st.pal.glow       = lerp(st.pal.glow, target.glow, .06);
      st.pal.pulseRate  = lerp(st.pal.pulseRate, target.pulseRate, .06);

      const speaking   = st.state==='speaking';
      const listening  = st.state==='listening';
      const thinking   = st.state==='thinking';
      const res = st.levelSm * ((speaking||listening) ? 1 : 0);

      // breath: always present at idle, bigger when active
      const breathAmp = listening ? 0.02 : st.state==='ambient' ? 0.07 : 0.04;
      const breathFreq = st.state==='ambient' ? 1.6 : 0.8;
      const breath = Math.sin(st.t * breathFreq) * breathAmp;
      const scale  = 1 + breath + st.energy*0.12 + res*0.24 + st.flare*0.38;
      const pull   = listening ? 0.82 : 1;
      const swirl  = thinking ? 2.4 : st.state==='ambient' ? 1.3 : 1;

      for(const n of neurons){
        n.a   += n.spd * 0.016 * swirl;
        n.wob += n.wobSpd * 0.016 * (1 + res*1.5);
        const wobble = Math.sin(n.wob) * (2.5 + st.energy*5 + res*8) * sf;
        const r = (n.r0 * pull + wobble) * scale;
        n.x = C + Math.cos(n.a) * r;
        n.y = C + Math.sin(n.a) * r * 0.95;
      }

      // synapse firing — ALWAYS happens at idle (pulseRate > 0 in all states)
      if(!REDUCED && Math.random() < st.pal.pulseRate + res*0.25 && pulses.length < 32){
        const i = (Math.random()*N)|0;
        let best=-1, bd=1e9;
        for(let j=0;j<N;j++){
          if(j===i) continue;
          const dx=neurons[j].x-neurons[i].x, dy=neurons[j].y-neurons[i].y, d=dx*dx+dy*dy;
          if(d<bd && d<LINK*LINK*1.5){ bd=d; best=j; }
        }
        if(best>=0) pulses.push({ from:i, to:best, t:0, spd:1.4+Math.random()*1.8 });
      }

      // resonance rings
      if(!REDUCED && (speaking||listening) && st.levelSm>.10 && Math.random()<st.levelSm*.55 && rings.length<10){
        rings.push(speaking
          ? { r:baseR*0.45*scale, alpha:.30+st.levelSm*.45, dir: 1, w:(1.2+st.levelSm*2.2)*sf }
          : { r:baseR*1.6*scale,  alpha:.22+st.levelSm*.35, dir:-1, w:(1.0+st.levelSm*1.8)*sf });
      }

      // idle micro-rings — subtle heartbeat so she always feels alive
      if(!REDUCED && st.state==='idle' && Math.random()<0.008 && rings.length<4){
        rings.push({ r:baseR*0.5, alpha:.14, dir:1, w:0.8*sf });
      }
    }

    function draw(){
      ctx.clearRect(0,0,S,S);
      const P = st.pal, e = st.energy, f = st.flare, res = st.levelSm;

      // outer glow — always has a neon pink bloom
      ctx.globalCompositeOperation = 'source-over';
      const halo = ctx.createRadialGradient(C,C,0,C,C,S*0.52);
      halo.addColorStop(0,   rgba(P.a, .14+e*.12+f*.25+res*.10));
      halo.addColorStop(.45, rgba(P.b, .07+e*.07+res*.05));
      halo.addColorStop(1,   'rgba(0,0,0,0)');
      ctx.fillStyle = halo;
      ctx.fillRect(0,0,S,S);

      if(REDUCED){ drawCore(1); return; }

      ctx.globalCompositeOperation = 'screen';

      // synapses — always rendered (brighter when active)
      ctx.lineWidth = 0.7 * Math.max(0.5, sf);
      for(let i=0;i<N;i++){
        const a = neurons[i];
        for(let j=i+1;j<N;j++){
          const b = neurons[j];
          const dx=a.x-b.x, dy=a.y-b.y, d2=dx*dx+dy*dy;
          if(d2>LINK*LINK) continue;
          const d = Math.sqrt(d2);
          // idle base alpha raised so connections are always faintly visible
          const al = (1-d/LINK) * (0.12+e*0.20+res*0.14) * Math.min(a.z,b.z) + .025;
          ctx.strokeStyle = rgba(mix(P.a,P.b,.5), al);
          ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
        }
      }

      // neurons
      for(const n of neurons){
        const sz = (0.8+n.z*1.8+e*1.0+res*1.4) * sf;
        const al = 0.30+n.z*0.50+e*0.28+f*0.45;
        ctx.fillStyle = rgba(mix(P.a,P.core,n.z*.6), al);
        ctx.beginPath(); ctx.arc(n.x,n.y,Math.max(0.2, sz),0,7); ctx.fill();
      }

      // firing pulses — travel along synapses with a glowing tail
      for(let k=pulses.length-1;k>=0;k--){
        const p = pulses[k];
        p.t += 0.016*p.spd;
        if(p.t>=1){ pulses.splice(k,1); continue; }
        const a=neurons[p.from], b=neurons[p.to];
        const x=lerp(a.x,b.x,p.t), y=lerp(a.y,b.y,p.t);
        const tail = Math.max(0, p.t-0.15);
        // tail
        ctx.strokeStyle = rgba(P.core, .55*(1-p.t));
        ctx.lineWidth = 1.4 * Math.max(0.5, sf);
        ctx.beginPath(); ctx.moveTo(lerp(a.x,b.x,tail),lerp(a.y,b.y,tail)); ctx.lineTo(x,y); ctx.stroke();
        // head glow
        ctx.fillStyle = rgba(P.core, .90*(1-p.t*.5));
        ctx.beginPath(); ctx.arc(x,y,2.0*sf,0,7); ctx.fill();
        // hot white center
        ctx.fillStyle = rgba([255,255,255], .70*(1-p.t));
        ctx.beginPath(); ctx.arc(x,y,0.9*sf,0,7); ctx.fill();
      }

      // resonance rings (outward when speaking, inward when listening)
      for(let k=rings.length-1;k>=0;k--){
        const r = rings[k];
        r.r    += r.dir * (0.9+res*1.8);
        r.alpha *= 0.962;
        if(r.alpha<.018||r.r<baseR*0.25||r.r>S*0.54){ rings.splice(k,1); continue; }
        ctx.strokeStyle = rgba(P.a, r.alpha);
        ctx.lineWidth = r.w;
        ctx.beginPath(); ctx.arc(C,C,r.r,0,7); ctx.stroke();
      }

      drawCore(1);
    }

    function drawCore(mult){
      const P=st.pal, e=st.energy, f=st.flare, res=st.levelSm;
      ctx.globalCompositeOperation = 'lighter';
      const coreR = (baseR*0.52+e*baseR*0.16+res*baseR*0.26+f*baseR*0.34)*mult;
      // inner hot-white bloom
      const g = ctx.createRadialGradient(C,C,0,C,C,coreR*1.4);
      g.addColorStop(0,    rgba([255,255,255], P.glow*0.9+res*0.35+f*0.55));
      g.addColorStop(0.25, rgba(P.core,        P.glow*0.80+res*0.28+f*0.40));
      g.addColorStop(0.65, rgba(P.a,           P.glow*0.30+res*0.10));
      g.addColorStop(1,    'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(C,C,coreR*1.4,0,7); ctx.fill();
    }

    function loop(){
      if(st.dead) return;
      if(!REDUCED){
        step();
      } else {
        st.t+=0.016;
        st.energy   += (st.energyTarget-st.energy)*0.07;
        st.flare    *= 0.93;
        st.levelSm  += (st.level-st.levelSm)*0.25;
        const T=PALETTES[st.state];
        st.pal.a=mix(st.pal.a,T.a,.06); st.pal.b=mix(st.pal.b,T.b,.06);
        st.pal.core=mix(st.pal.core,T.core,.06); st.pal.glow=lerp(st.pal.glow,T.glow,.06);
      }
      draw();
      st.raf = requestAnimationFrame(loop);
    }
    loop();

    return {
      setState, setLevel, flare,
      get state(){ return st.state; },
      destroy(){ st.dead=true; cancelAnimationFrame(st.raf); }
    };
  }

  function nullOrb(){ return { setState(){}, setLevel(){}, flare(){}, destroy(){}, state:'idle' }; }

  /* ── Audio → resonance bridges (best-effort, never throw) ─────── */
  let sharedCtx = null;
  function audioCtx(){
    try{
      if(!sharedCtx) sharedCtx = new (global.AudioContext||global.webkitAudioContext)();
      if(sharedCtx.state==='suspended') sharedCtx.resume();
      return sharedCtx;
    }catch(e){ return null; }
  }
  // Unlock on first user gesture (Safari requires this)
  try{
    const unlock = ()=>{ try{ if(sharedCtx&&sharedCtx.state==='suspended') sharedCtx.resume(); }catch(e){} };
    ['pointerdown','touchstart','keydown'].forEach(ev=>global.addEventListener(ev,unlock,{passive:true}));
  }catch(e){}

  function meter(orb, node, ac, onDone){
    try{
      const an = ac.createAnalyser(); an.fftSize=256;
      node.connect(an);
      const buf = new Uint8Array(an.frequencyBinCount);
      let live = true;
      (function tick(){
        if(!live) return;
        an.getByteFrequencyData(buf);
        let sum=0; for(let i=2;i<buf.length;i++) sum+=buf[i];
        orb.setLevel(Math.min(1,(sum/buf.length)/105));
        requestAnimationFrame(tick);
      })();
      return { stop(){ live=false; orb.setLevel(0); try{ node.disconnect(an); }catch(e){} if(onDone) onDone(); } };
    }catch(e){ return { stop(){} }; }
  }

  // Wire an <audio> element (Lola's ElevenLabs playback) into the orb.
  // RULE: voice > visuals. If AudioContext isn't running yet (pre-gesture),
  // leave the element native so playback is never silenced.
  const wired = new WeakMap();
  function attachAudioElement(orb, el){
    const ac = audioCtx(); if(!ac||!el) return { stop(){} };
    if(ac.state!=='running') return { stop(){} };
    try{
      let src = wired.get(el);
      if(!src){ src=ac.createMediaElementSource(el); src.connect(ac.destination); wired.set(el,src); }
      return meter(orb,src,ac);
    }catch(e){ return { stop(){} }; }
  }

  // Mic stream for visual resonance while listening.
  async function attachMic(orb){
    const ac = audioCtx(); if(!ac||!navigator.mediaDevices?.getUserMedia) return { stop(){} };
    try{
      const stream = await navigator.mediaDevices.getUserMedia({audio:true});
      const src = ac.createMediaStreamSource(stream);
      return meter(orb,src,ac,()=>stream.getTracks().forEach(t=>t.stop()));
    }catch(e){ return { stop(){} }; }
  }

  global.LolaOrb = { mount, attachAudioElement, attachMic };
})(window);
