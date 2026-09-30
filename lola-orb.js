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
   · oncall     — a real phone call is live on the line right now.
                  Distinct cool blue palette (never confused with her
                  own listening/speaking colors) at a steady bright
                  energy, so the owner can tell at a glance — without
                  reading any text — that Lola is on with a caller.

   Body: on any device with a GPU she is up to a MILLION particles
   (tuned live to the device: phones up to 320k, laptops up to 1M),
   with the voice split into bands that shape her surface. Without a
   GPU, or with reduced motion, the original neural network below.

   API:
     const orb = LolaOrb.mount(canvas, { size, bleed, ambient, tier });
       size   — the stage size in CSS px (her sphere is 60% of it)
       bleed  — let her aura spill past the stage (0.25 = 25% each side)
       ambient— a quieter background Lola with a smaller budget
     orb.feed(level, [low, mid, high]);   // any voice source → resonance
     orb.particles                         // how many she's drawing now
     orb.setState('idle'|'ambient'|'listening'|'thinking'|'speaking'|'oncall');
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
    idle:      { a:[204,255,0],  b:[58,90,0],   core:[214,255,60],  glow:.30 },
    ambient:   { a:[204,255,0],  b:[72,108,0],  core:[222,255,92], glow:.38 },
    listening: { a:[220,255,102], b:[94,255,168],  core:[228,255,196], glow:.55 },
    thinking:  { a:[255,196,64], b:[204,255,0],  core:[255,232,168], glow:.50 },
    speaking:  { a:[232,255,140], b:[128,255,190],  core:[255,255,255], glow:.62 },
    oncall:    { a:[90,200,250],  b:[40,120,190],  core:[190,235,255], glow:.58 }
  };

  function lerp(a,b,t){ return a+(b-a)*t; }
  function mix(c1,c2,t){ return [lerp(c1[0],c2[0],t)|0, lerp(c1[1],c2[1],t)|0, lerp(c1[2],c2[2],t)|0]; }
  function rgba(c,a){ return `rgba(${c[0]},${c[1]},${c[2]},${Math.max(0,Math.min(1,a))})`; }

  /* ═══════════════════════════════════════════════════════════════
     GPU BODY — up to a million particles, tuned live to the device
     ───────────────────────────────────────────────────────────────
     Every particle lives on the GPU: the CPU only sends ~20 numbers a
     frame (time, state weights, voice bands). Four populations:
       · shell    — the dense luminous surface of Lola
       · nucleus  — a soft interior, hollow at the very center so her
                    name stays readable
       · corona   — her aura: streams OUT with her voice while she
                    speaks, streams IN (sound flowing into her) while
                    she listens, drifts slowly at rest
       · synapses — comets that race along great circles while she
                    thinks, and orbit as a signal while she's on a call
     Resonance: her real voice is split into low / mid / high bands.
     Low swells the whole body, mid raises standing-wave lobes across
     the surface, high makes the shell shimmer.
     The buffer is shuffled, so any prefix is a fair sample: the tuner
     changes detail by drawing more or fewer — never rebuilding.
     ═══════════════════════════════════════════════════════════════ */
  const GPU_VS = `
    precision highp float;
    attribute vec3 a_dir; attribute float a_r; attribute float a_k; attribute float a_s;
    uniform vec2 u_res; uniform float u_t, u_R, u_rot, u_swirl, u_tilt, u_breath, u_dpr, u_alpha;
    uniform float u_amp, u_low, u_mid, u_high, u_listen, u_think, u_speak, u_call, u_flare, u_edge;
    uniform vec3 u_a, u_b, u_core;
    varying vec4 v_c;
    float h(float x){ return fract(sin(x*127.1)*43758.5453); }
    vec3 rotY(vec3 p, float a){ float c=cos(a), s=sin(a); return vec3(p.x*c-p.z*s, p.y, p.x*s+p.z*c); }
    void main(){
      float t = u_t, k = a_k, s = a_s, ph = s*6.2831853;
      vec3 d = a_dir;
      float r = a_r, bright = 1.0;
      vec3 col = mix(u_b, u_a, 0.55 + 0.45*d.y);
      if (k > 2.5) {
        // synapse comet: a group of particles chasing the same head along a great circle
        float g = floor(s*48.0), lag = fract(s*48.0);
        vec3 ax = normalize(vec3(h(g+1.3)-.5, h(g+7.1)-.5, h(g+3.7)-.5));
        vec3 p0 = normalize(cross(ax, vec3(h(g+5.9)-.5, h(g+2.2)-.5, h(g+9.4)-.5)));
        vec3 p1 = cross(ax, p0);
        float spd = 0.55 + 1.9*u_think + 0.9*u_call + 0.6*u_speak;
        float th = t*spd*(0.7 + h(g)) + h(g+4.4)*6.2831853 - lag*(0.35 + 0.25*u_think);
        d = p0*cos(th) + p1*sin(th);
        r = 0.98 + 0.05*h(g+8.8);
        bright = (1.0 - lag) * (0.25 + 2.6*u_think + 1.6*u_call + 0.9*u_speak*u_amp);
        col = mix(u_core, u_a, lag);
      } else if (k > 1.5) {
        // corona: out with her voice, in with yours, a slow drift at rest
        float spd = 0.035 + 0.35*u_speak*(0.25 + u_amp) + 0.22*u_listen + 0.06*u_call;
        float q = fract(s*13.7 + t*spd);
        q = mix(q, 1.0 - q, u_listen);
        r = 1.0 + q*(0.5 + 0.75*u_amp*u_speak + 0.3*u_listen + 0.7*u_flare) * (0.55 + 0.45*a_r);
        bright = pow(1.0 - q, 1.4) * (1.2 + 2.6*u_amp*u_speak + 0.9*u_listen + 0.5*u_call + 2.4*u_flare);
        col = mix(u_a, u_b, q);
      } else {
        // shell + nucleus: organic flow, differential swirl, voice resonance
        vec3 fl = vec3(sin(t*.37 + d.y*3.1 + ph), sin(t*.41 + d.z*2.9 + ph*1.3), sin(t*.33 + d.x*3.3 + ph*.7));
        d = normalize(d + fl*(0.045 + 0.09*u_think + 0.03*u_listen));
        float lobes = sin(d.x*5.0 + t*3.1)*sin(d.y*4.0 - t*2.7)*sin(d.z*5.0 + t*2.2);
        float ring = sin(9.0*d.y - t*7.0);
        r *= 1.0 + u_low*0.09 + u_mid*0.17*lobes + u_high*0.05*sin(ph*37.0 + t*31.0)
               + u_call*0.035*ring - u_listen*0.07 + u_flare*0.28;
        r += 0.006*sin(t*19.0 + ph*57.0);
        if (k > 0.5) { col = mix(u_core, u_a, a_r); bright = 0.55 + 0.6*u_amp; }
        else bright = 0.85 + 0.5*u_amp + 0.35*u_high*step(0.93, fract(s*91.0 + t*4.0));
        // on a call: a bright band sweeps her latitudes like a signal
        bright += u_call * 1.4 * smoothstep(0.08, 0.0, abs(d.y - sin(t*1.6)));
        // listening: a soft ripple rolls inward
        bright += u_listen * 0.6 * max(0.0, sin(14.0*length(d.xz) + t*9.0));
      }
      d = rotY(d, u_rot + u_swirl*(0.45 + 0.55*d.y));
      float ct = cos(u_tilt), st = sin(u_tilt);
      vec3 p = vec3(d.x, d.y*ct - d.z*st, d.y*st + d.z*ct);
      r *= u_breath;
      float persp = 1.0/(1.0 - 0.16*p.z);
      vec2 px = u_res*0.5 + p.xy * r * u_R * persp;
      gl_Position = vec4(px/u_res*2.0 - 1.0, 0.0, 1.0);
      gl_Position.y = -gl_Position.y;
      float depth = 0.5 + 0.5*p.z;
      float edge = smoothstep(u_edge, u_edge*0.82, length(px - u_res*0.5));
      gl_PointSize = u_dpr * (k > 2.5 ? 2.1 : (0.7 + 0.65*depth)) * (1.0 + 0.25*u_amp);
      float rim = k < 0.5 ? 0.75 + 1.1*pow(1.0 - abs(p.z), 3.0) : 1.0;   // luminous silhouette
      float a = u_alpha * bright * rim * (0.25 + 0.75*depth) * edge;
      v_c = vec4(mix(col, u_core, 0.18*depth*u_amp), a);
    }`;
  const GPU_FS = `
    precision mediump float;
    varying vec4 v_c;
    void main(){
      vec2 q = gl_PointCoord - 0.5; float d = dot(q,q);
      float a = v_c.a * clamp(1.0 - d*3.6, 0.0, 1.0);
      gl_FragColor = vec4(v_c.rgb * a, a);   // premultiplied: pure light, no dark box
    }`;
  // soft light: the halo behind her body and the warm core
  const GLOW_VS = `attribute vec2 a_p; varying vec2 v_p; void main(){ v_p=a_p; gl_Position=vec4(a_p,0.0,1.0); }`;
  const GLOW_FS = `
    precision mediump float; varying vec2 v_p;
    uniform float u_k, u_glow, u_amp, u_flare; uniform vec3 u_a, u_core;
    void main(){
      float r = length(v_p)/u_k;
      float halo = exp(-r*r*1.6) * (0.10 + 0.10*u_glow + 0.18*u_amp + 0.35*u_flare);
      float core = exp(-r*r*9.0) * (0.14 + 0.35*u_glow + 0.35*u_amp + 0.5*u_flare);
      vec3 c = u_a*halo + u_core*core;
      gl_FragColor = vec4(c, max(c.r, max(c.g, c.b)));
    }`;

  const TIERS = [40000, 80000, 160000, 320000, 640000, 1000000];
  function deviceCeiling(ambient){
    const phone = (global.matchMedia && matchMedia('(pointer: coarse)').matches) || Math.min(screen.width||1e4, screen.height||1e4) < 700;
    const mem = navigator.deviceMemory || 8, cores = navigator.hardwareConcurrency || 8;
    let top = phone ? 3 : (mem <= 4 || cores <= 4) ? 4 : 5;     // phones: 320k · modest laptops: 640k · everything else: 1M
    if (ambient) top = Math.min(top, 2);
    return top;
  }
  function tierStore(){ try { return parseInt(localStorage.getItem('lola.orb.tier')||'',10); } catch(e){ return NaN; } }
  function tierSave(i){ try { localStorage.setItem('lola.orb.tier', String(i)); } catch(e){} }

  let probeOK = null;
  function probe(){
    if (probeOK !== null) return probeOK;
    probeOK = false;
    try {
      const c = document.createElement('canvas'), g = c.getContext('webgl');
      if (!g) return false;
      const ok = (vs, fs) => { const p = g.createProgram(); [[g.VERTEX_SHADER, vs],[g.FRAGMENT_SHADER, fs]].forEach(([t, src]) => { const x = g.createShader(t); g.shaderSource(x, src); g.compileShader(x); g.attachShader(p, x); }); g.linkProgram(p); return g.getProgramParameter(p, g.LINK_STATUS); };
      probeOK = !!(ok(GPU_VS, GPU_FS) && ok(GLOW_VS, GLOW_FS));
      const lose = g.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext();
    } catch(e){ probeOK = false; }
    return probeOK;
  }

  function mountGPU(canvas, opts){
    if (!probe()) return null;
    let gl = null;
    try { gl = canvas.getContext('webgl', { alpha:true, premultipliedAlpha:true, antialias:false, depth:false, stencil:false, powerPreference:'high-performance' }); } catch(e){}
    if (!gl) return null;
    const ambient = !!opts.ambient;
    const bleed = Math.max(0, opts.bleed || 0);
    const stageSize = opts.size || canvas.clientWidth || 240;
    if (bleed) {
      const cs = canvas.style;
      cs.position = 'absolute'; cs.right = cs.bottom = 'auto'; cs.left = cs.top = (-bleed*100)+'%';
      cs.width = cs.height = (100 + 200*bleed)+'%'; cs.maxWidth = 'none'; cs.pointerEvents = 'none';
    }
    canvas.classList.add('lola-gpu');
    if (canvas.parentElement) canvas.parentElement.classList.add('lola-gpu-stage');

    const ceiling = deviceCeiling(ambient);
    let tier = tierStore();
    if (!(tier >= 0)) tier = Math.min(ceiling, ceiling >= 5 ? 3 : 2);
    tier = Math.min(tier, ceiling);
    if (typeof opts.tier === 'number') tier = Math.max(0, Math.min(TIERS.length-1, opts.tier));
    const CAP = TIERS[Math.max(tier, ceiling)];

    function sh(type, src){ const x = gl.createShader(type); gl.shaderSource(x, src); gl.compileShader(x); if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x)); return x; }
    function program(vs, fs){ const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p)); return p; }
    let P, G, pBuf, gBuf; const U = {}, GU = {}; let A = {};

    function build(){
      P = program(GPU_VS, GPU_FS); G = program(GLOW_VS, GLOW_FS);
      ['u_res','u_t','u_R','u_rot','u_swirl','u_tilt','u_breath','u_dpr','u_alpha','u_amp','u_low','u_mid','u_high','u_listen','u_think','u_speak','u_call','u_flare','u_edge','u_a','u_b','u_core'].forEach(n => U[n] = gl.getUniformLocation(P, n));
      ['u_k','u_glow','u_amp','u_flare','u_a','u_core'].forEach(n => GU[n] = gl.getUniformLocation(G, n));
      A = { dir: gl.getAttribLocation(P,'a_dir'), r: gl.getAttribLocation(P,'a_r'), k: gl.getAttribLocation(P,'a_k'), s: gl.getAttribLocation(P,'a_s'), gp: gl.getAttribLocation(G,'a_p') };
      const n = CAP, a = new Float32Array(n*6);
      for (let i=0, o=0; i<n; i++, o+=6){
        const u = Math.random()*2-1, th = Math.random()*6.2831853, s = Math.sqrt(1-u*u), roll = Math.random();
        a[o] = s*Math.cos(th); a[o+1] = u; a[o+2] = s*Math.sin(th);
        let k, r;
        if (roll < 0.62)      { k = 0; r = 0.9 + 0.1*Math.sqrt(Math.random()); }          // shell
        else if (roll < 0.74) { k = 1; r = 0.28 + 0.6*Math.cbrt(Math.random()); }         // nucleus, hollow center
        else if (roll < 0.992){ k = 2; r = Math.random(); }                               // corona
        else                  { k = 3; r = 1; }                                           // synapses
        a[o+3] = r; a[o+4] = k; a[o+5] = Math.random();
      }
      pBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, pBuf); gl.bufferData(gl.ARRAY_BUFFER, a, gl.STATIC_DRAW);
      gBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, gBuf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
    }
    try { build(); } catch(e){ try { console.warn('[LolaOrb] GPU body unavailable:', e && e.message); } catch(_){} return null; }

    const st = {
      state:'idle', t:0, level:0, feed:0, lvl:0, bands:[0,0,0], bandsSm:[0,0,0], flare:0,
      w:{ listen:0, think:0, speak:0, call:0, ambient:0 }, rot:0, swirl:0,
      pal:{ a:PALETTES.idle.a.map(x=>x/255), b:PALETTES.idle.b.map(x=>x/255), core:PALETTES.idle.core.map(x=>x/255), glow:PALETTES.idle.glow },
      raf:0, dead:false, visible:true, W:0, H:0, dpr:1
    };
    let count = TIERS[tier];

    function resize(){
      const dpr = Math.min(global.devicePixelRatio || 1, 2);
      const cssW = canvas.clientWidth || stageSize*(1+2*bleed), cssH = canvas.clientHeight || cssW;
      const W = Math.max(1, Math.round(cssW*dpr)), H = Math.max(1, Math.round(cssH*dpr));
      if (W !== canvas.width || H !== canvas.height) { canvas.width = W; canvas.height = H; }
      st.W = W; st.H = H; st.dpr = dpr;
      // her size follows the stage she's actually drawn in (phones shrink it)
      st.stage = canvas.clientWidth ? Math.min(cssW, cssH)/(1+2*bleed) : stageSize;
    }
    resize();
    let ro = null; try { ro = new ResizeObserver(resize); ro.observe(canvas); } catch(e){}

    function setState(s){ if (!PALETTES[s]) s = 'idle'; st.state = s; }
    function setLevel(v){ st.level = Math.max(0, Math.min(1, +v || 0)); }
    function feed(v, bands){ st.feed = Math.max(0, Math.min(1, +v || 0)); if (bands) st.bands = [0,1,2].map(i => Math.max(0, Math.min(1, +bands[i] || 0))); }
    function setBands(l, m, hh){ st.bands = [l||0, m||0, hh||0]; }
    function flare(){ st.flare = 1; }

    // Tuner: climb toward the ceiling while she's smooth, step down (and stay down) if not.
    let fAcc = 0, fN = 0, good = 0, bad = 0, ceil = Math.max(tier, ceiling);
    function tune(dt){
      if (opts.tier != null) return;
      fAcc += dt; fN++;
      if (fAcc < 1) return;
      const fps = fN / fAcc; fAcc = 0; fN = 0;
      if (fps >= 56) { good++; bad = 0; } else if (fps < 44) { bad++; good = 0; } else { good = bad = 0; }
      if (good >= 2 && tier < ceil) { tier++; count = TIERS[tier]; good = 0; tierSave(tier); }
      if (bad >= 2 && tier > 0) { tier--; ceil = tier; count = TIERS[tier]; bad = 0; tierSave(tier); }
    }

    let last = performance.now();
    function frame(now){
      st.raf = 0;
      if (st.dead) return;
      const dt = Math.min(0.05, Math.max(0.001, (now - last)/1000)); last = now;
      st.t += dt;
      const e = 1 - Math.pow(0.02, dt), ef = 1 - Math.pow(0.0005, dt);
      const s = st.state, W = st.w;
      W.listen += ((s==='listening'?1:0) - W.listen)*e;
      W.think  += ((s==='thinking'?1:0) - W.think)*e;
      W.speak  += ((s==='speaking'?1:0) - W.speak)*e;
      W.call   += ((s==='oncall'?1:0) - W.call)*e;
      W.ambient+= ((s==='ambient'?1:0) - W.ambient)*e;
      const raw = Math.max(st.level, st.feed);
      st.lvl += (raw - st.lvl) * Math.min(1, dt*16);
      for (let i=0;i<3;i++) st.bandsSm[i] += (Math.max(st.bands[i], raw*[0.8,0.6,0.35][i]) - st.bandsSm[i]) * Math.min(1, dt*14);
      st.flare *= Math.pow(0.12, dt);
      const T = PALETTES[s];
      for (let i=0;i<3;i++){ st.pal.a[i] += (T.a[i]/255 - st.pal.a[i])*ef; st.pal.b[i] += (T.b[i]/255 - st.pal.b[i])*ef; st.pal.core[i] += (T.core[i]/255 - st.pal.core[i])*ef; }
      st.pal.glow += (T.glow - st.pal.glow)*ef;
      st.rot += dt*(0.12 + 0.10*W.speak + 0.08*W.call);
      st.swirl += dt*(0.02 + 1.35*W.think + 0.25*W.call);
      tune(dt);

      const breath = 1 + (0.022 + 0.03*W.ambient)*Math.sin(st.t*(0.9 + 0.6*W.ambient)) + 0.04*W.speak*st.lvl;
      const Rpx = (st.stage || stageSize)*0.30*st.dpr;
      gl.viewport(0, 0, st.W, st.H);
      gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);

      // glow first
      gl.useProgram(G);
      gl.bindBuffer(gl.ARRAY_BUFFER, gBuf);
      if (A.dir >= 0) gl.disableVertexAttribArray(A.dir);
      gl.enableVertexAttribArray(A.gp); gl.vertexAttribPointer(A.gp, 2, gl.FLOAT, false, 8, 0);
      gl.uniform1f(GU.u_k, (Rpx*1.25)/(st.W*0.5)); gl.uniform1f(GU.u_glow, st.pal.glow*(ambient?0.5:1)); gl.uniform1f(GU.u_amp, st.lvl); gl.uniform1f(GU.u_flare, st.flare);
      gl.uniform3fv(GU.u_a, st.pal.a); gl.uniform3fv(GU.u_core, st.pal.core);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.disableVertexAttribArray(A.gp);

      // then her body
      gl.useProgram(P);
      gl.bindBuffer(gl.ARRAY_BUFFER, pBuf);
      gl.enableVertexAttribArray(A.dir); gl.vertexAttribPointer(A.dir, 3, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(A.r);   gl.vertexAttribPointer(A.r,   1, gl.FLOAT, false, 24, 12);
      gl.enableVertexAttribArray(A.k);   gl.vertexAttribPointer(A.k,   1, gl.FLOAT, false, 24, 16);
      gl.enableVertexAttribArray(A.s);   gl.vertexAttribPointer(A.s,   1, gl.FLOAT, false, 24, 20);
      gl.uniform2f(U.u_res, st.W, st.H);
      gl.uniform1f(U.u_t, st.t); gl.uniform1f(U.u_R, Rpx); gl.uniform1f(U.u_rot, st.rot); gl.uniform1f(U.u_swirl, st.swirl);
      gl.uniform1f(U.u_tilt, 0.38 + 0.05*Math.sin(st.t*0.21)); gl.uniform1f(U.u_breath, breath); gl.uniform1f(U.u_dpr, st.dpr);
      // constant brightness at any detail: more particles → each one finer
      // same glow at any size: a bigger Lola spreads the particles thinner
      const areaK = Math.min(3.5, Math.max(0.6, Math.pow(((st.stage || stageSize) * 0.30) / 96, 2)));
      gl.uniform1f(U.u_alpha, Math.min(1, 26000/count) * (ambient ? 0.45 : 0.62) * (st.dpr < 1.5 ? 1.35 : 1) * areaK);
      gl.uniform1f(U.u_amp, st.lvl); gl.uniform1f(U.u_low, st.bandsSm[0]); gl.uniform1f(U.u_mid, st.bandsSm[1]); gl.uniform1f(U.u_high, st.bandsSm[2]);
      gl.uniform1f(U.u_listen, W.listen); gl.uniform1f(U.u_think, W.think); gl.uniform1f(U.u_speak, W.speak); gl.uniform1f(U.u_call, W.call); gl.uniform1f(U.u_flare, st.flare);
      gl.uniform1f(U.u_edge, Math.min(st.W, st.H)*0.5);
      gl.uniform3fv(U.u_a, st.pal.a); gl.uniform3fv(U.u_b, st.pal.b); gl.uniform3fv(U.u_core, st.pal.core);
      gl.drawArrays(gl.POINTS, 0, count);

      schedule();
    }
    function schedule(){ if (!st.raf && !st.dead && st.visible && !document.hidden) st.raf = requestAnimationFrame(frame); }
    // Rest when nobody can see her: background tab, or scrolled out of view.
    const onVis = () => { if (!document.hidden) { last = performance.now(); schedule(); } };
    document.addEventListener('visibilitychange', onVis);
    let io = null;
    try { io = new IntersectionObserver((es) => { st.visible = es.some(x => x.isIntersecting); if (st.visible) { last = performance.now(); schedule(); } }, { rootMargin:'120px' }); io.observe(canvas); } catch(e){}
    canvas.addEventListener('webglcontextlost', (ev) => { ev.preventDefault(); if (st.raf) cancelAnimationFrame(st.raf); st.raf = 0; });
    canvas.addEventListener('webglcontextrestored', () => { try { build(); last = performance.now(); schedule(); } catch(e){} });
    schedule();

    return {
      gpu:true, setState, setLevel, setBands, feed, flare,
      get state(){ return st.state; },
      get particles(){ return count; },
      setDetail(i){ tier = Math.max(0, Math.min(TIERS.length-1, i|0)); if (tier > ceil) ceil = tier; count = Math.min(TIERS[tier], CAP); },
      destroy(){ st.dead = true; if (st.raf) cancelAnimationFrame(st.raf); document.removeEventListener('visibilitychange', onVis); try { ro && ro.disconnect(); io && io.disconnect(); } catch(e){} }
    };
  }

  function mount(canvas, opts={}){
    if(!canvas || !canvas.getContext) return nullOrb();
    // A million-particle body when the device has a GPU; the calm 2D
    // network when it doesn't, or when the owner asked for less motion.
    if(!REDUCED && opts.gpu !== false){
      try{ const g = mountGPU(canvas, opts); if(g) return g; }catch(e){}
    }
    return mount2D(canvas, opts);
  }

  function mount2D(canvas, opts={}){
    const ctx = canvas.getContext('2d');
    if(!ctx) return nullOrb(); // some environments (headless test runners, canvas-disabled browsers) return null here
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
      st.energyTarget = (s==='listening'||s==='speaking'||s==='oncall') ? 1 : s==='thinking' ? 0.65 : s==='ambient' ? 0.25 : 0;
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
      gpu:false, setState, setLevel, flare,
      setBands(){}, feed(v){ setLevel(v); }, particles:N,
      get state(){ return st.state; },
      destroy(){ st.dead = true; cancelAnimationFrame(st.raf); }
    };
  }

  function nullOrb(){ return { gpu:false, setState(){}, setLevel(){}, setBands(){}, feed(){}, flare(){}, destroy(){}, state:'idle', particles:0 }; }

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
  // Voice → three resonance bands (low swell · mid lobes · high shimmer).
  function bandsOf(buf){
    const n = buf.length, avg = (a,b) => { let s=0; for(let i=a;i<b;i++) s+=buf[i]; return s/Math.max(1,b-a)/255; };
    return [Math.min(1, avg(1, Math.max(2,n*.06|0))*1.6), Math.min(1, avg(n*.06|0, n*.3|0)*2.0), Math.min(1, avg(n*.3|0, n*.75|0)*3.2)];
  }
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
        if(orb.setBands) orb.setBands(...bandsOf(buf));
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

  global.LolaOrb = { mount, attachAudioElement, attachMic, bandsOf };
})(window);
