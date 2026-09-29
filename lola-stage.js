/* LolaDesk — Lola, alive on the calendar.
 *
 * Hundreds of thousands of GPU micro-particles form Lola in the top-right of
 * the calendar (up to a million on a strong GPU — she tunes herself to the
 * device). She breathes, listens, thinks and speaks with the same states and
 * voice as Lola everywhere else. When a booking lands — made by Lola on the
 * phone, from the booking widget, or by you — a stream of her particles flies
 * out, frames the new appointment, and flows back. Every so often she drifts
 * over to the next client coming in.
 *
 * Needs <div id="lolaAnchor"></div> on the page. lola-everywhere.js supplies
 * the conversation; this file is only her body. API: window.LolaStage.
 */
(function () {
  if (window.LolaStage) return;
  const anchor = document.getElementById('lolaAnchor');
  if (!anchor) return;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const small = innerWidth < 700;

  const style = document.createElement('style');
  style.textContent = `
    #lolaAnchor:not([data-inline]) { position: fixed; top: calc(22px + env(safe-area-inset-top, 0px)); right: calc(28px + env(safe-area-inset-right, 0px)); width: 150px; height: 150px; pointer-events: none; z-index: 1; }
    @media (max-width: 1100px) { #lolaAnchor:not([data-inline]) { width: 112px; height: 112px; top: 14px; right: 16px; } }
    @media (max-width: 700px)  { #lolaAnchor:not([data-inline]) { width: 80px; height: 80px; top: 6px; right: 6px; } }
    .ls-canvas { position: fixed; inset: 0; width: 100vw; height: 100vh; pointer-events: none; z-index: 90; }`;
  document.head.appendChild(style);

  const core = document.createElement('canvas'); core.className = 'ls-canvas'; core.setAttribute('aria-hidden', 'true');
  const field = document.createElement('canvas'); field.className = 'ls-canvas'; field.setAttribute('aria-hidden', 'true');
  document.body.appendChild(field); document.body.appendChild(core);
  const ctx = field.getContext('2d');

  // ── theme: follow the page underneath ──
  let dark = false;
  function readTheme() {
    let el = document.body, rgb = null;
    while (el) { const c = getComputedStyle(el).backgroundColor; if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) { rgb = c.match(/\d+/g).map(Number); break; } el = el.parentElement; }
    dark = rgb ? (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255 < 0.5 : matchMedia('(prefers-color-scheme: dark)').matches;
  }
  readTheme();
  const INK = () => (dark ? '245,245,247' : '29,29,31'), GLOW = '204,255,0';

  // ── body on the GPU ──
  let gl = null;
  try { gl = core.getContext('webgl', { antialias: false, premultipliedAlpha: false, alpha: true }); } catch (_) {}
  let prog = null, buf = null, loc = {}, coreN = 0, hasGL = false;
  const LEVELS = [45000, 90000, 180000, 400000, 1000000];
  let level = reduce ? 0 : small ? 1 : 2;
  try { const saved = parseInt(localStorage.getItem('lola.detail') || '', 10); const i = LEVELS.indexOf(saved); if (i >= 0 && !reduce) level = i; } catch (_) {}

  const VS = `
    attribute vec3 a_dir; attribute float a_r; attribute float a_ph; attribute float a_acc;
    uniform vec2 u_res; uniform vec2 u_c; uniform float u_t, u_R, u_ay, u_tilt, u_amp, u_lean, u_think, u_breath, u_dpr, u_alpha, u_flow;
    varying float v_a; varying float v_acc;
    void main() {
      vec3 d = a_dir; float t = u_t;
      vec3 flow = vec3(sin(t*0.71 + d.y*3.1 + a_ph), sin(t*0.63 + d.z*2.7 + a_ph*1.3), sin(t*0.82 + d.x*3.3 + a_ph*0.7));
      d = normalize(d + flow * 0.2 * u_flow);
      float cy = cos(u_ay), sy = sin(u_ay), ct = cos(u_tilt), st = sin(u_tilt);
      float x1 = d.x*cy - d.z*sy, z1 = d.x*sy + d.z*cy;
      float y2 = d.y*ct - z1*st,  z2 = d.y*st + z1*ct;
      float r = a_r;
      if (r > 1.0) r += 0.12 * sin(t*0.5 + a_ph*3.0);
      r *= 1.0 + u_amp * 0.42 * sin(a_ph*3.0 + t*11.0 + d.y*7.0);
      r *= mix(1.0, 0.8 + 0.25*sin(a_ph + t*6.0), u_think);
      r *= u_breath;
      r += 0.012 * sin(t*23.0 + a_ph*57.0);
      vec2 p = u_c + vec2(x1, y2) * r * u_R + u_lean * (z2 + 1.0) * vec2(-10.0, 8.0);
      vec2 clip = (p / u_res) * 2.0 - 1.0;
      gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
      float depth = (z2 + 1.0) * 0.5;
      gl_PointSize = (0.75 + 0.8 * depth) * u_dpr * (a_acc > 0.5 ? 1.35 : 1.0);
      v_a = (0.3 + 0.7 * depth) * u_alpha * (a_r > 1.0 ? 0.45 : 1.0) * (a_acc > 0.5 ? 2.6 : 1.0) * (1.0 + u_amp * 0.6);
      v_acc = a_acc;
    }`;
  const FS = `
    precision mediump float;
    uniform vec3 u_ink; uniform vec3 u_glow;
    varying float v_a; varying float v_acc;
    void main() {
      vec2 q = gl_PointCoord - 0.5; float d = dot(q, q);
      if (d > 0.25) discard;
      gl_FragColor = vec4(v_acc > 0.5 ? u_glow : u_ink, clamp(v_a * (1.0 - d * 3.2), 0.0, 1.0));
    }`;
  function compile(type, src) {
    const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    return sh;
  }
  function buildCore(n) {
    const a = new Float32Array(n * 6);
    for (let i = 0, o = 0; i < n; i++, o += 6) {
      const u = Math.random() * 2 - 1, th = Math.random() * 6.283185, s = Math.sqrt(1 - u * u), roll = Math.random();
      a[o] = s * Math.cos(th); a[o + 1] = u; a[o + 2] = s * Math.sin(th);
      a[o + 3] = roll < 0.64 ? 0.8 + 0.2 * Math.sqrt(Math.random()) : roll < 0.92 ? Math.cbrt(Math.random()) * 0.8 : 1.02 + Math.random() * 0.3;
      a[o + 4] = Math.random() * 6.283185; a[o + 5] = Math.random() < 0.09 ? 1 : 0;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, a, gl.STATIC_DRAW);
    const F = 4, stride = 6 * F;
    gl.enableVertexAttribArray(loc.a_dir); gl.vertexAttribPointer(loc.a_dir, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(loc.a_r); gl.vertexAttribPointer(loc.a_r, 1, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(loc.a_ph); gl.vertexAttribPointer(loc.a_ph, 1, gl.FLOAT, false, stride, 16);
    gl.enableVertexAttribArray(loc.a_acc); gl.vertexAttribPointer(loc.a_acc, 1, gl.FLOAT, false, stride, 20);
    coreN = n;
  }
  try {
    if (gl) {
      prog = gl.createProgram();
      gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
      gl.useProgram(prog);
      for (const n of ['a_dir', 'a_r', 'a_ph', 'a_acc']) loc[n] = gl.getAttribLocation(prog, n);
      for (const n of ['u_res', 'u_c', 'u_t', 'u_R', 'u_ay', 'u_tilt', 'u_amp', 'u_lean', 'u_think', 'u_breath', 'u_dpr', 'u_alpha', 'u_flow', 'u_ink', 'u_glow']) loc[n] = gl.getUniformLocation(prog, n);
      buf = gl.createBuffer();
      buildCore(LEVELS[level]);
      hasGL = true;
    }
  } catch (e) { hasGL = false; core.remove(); }
  function setLevel(i) {
    if (!hasGL) return;
    i = Math.max(0, Math.min(LEVELS.length - 1, i));
    if (i === level && coreN) return;
    level = i; buildCore(LEVELS[i]);
    try { localStorage.setItem('lola.detail', String(LEVELS[i])); } catch (_) {}
  }

  // ── worker particles: the ones that fly out to the calendar ──
  const N = hasGL ? (reduce ? 400 : small ? 800 : 1500) : (reduce ? 400 : small ? 700 : 1100);
  const P = [];
  for (let i = 0; i < N; i++) {
    const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2, s = Math.sqrt(1 - u * u);
    P.push({ ux: s * Math.cos(th), uy: u, uz: s * Math.sin(th), r: 0.55 + 0.45 * Math.pow(Math.random(), 0.35), ph: Math.random() * 6.283,
      sz: hasGL ? 0.45 + Math.random() * 0.6 : 0.6 + Math.random() * 0.9, acc: Math.random() < 0.16,
      x: 0, y: 0, vx: 0, vy: 0, vis: 1, m: null, du: Math.random(), dv: Math.random(), delay: 0 });
  }

  // ── state ──
  const S = { mode: 'idle', amp: 0, ampTarget: 0, R: 44, spin: 0.22, ay: 0, t: 0, lean: 0, glow: 0.25, think: 0, levelFn: null };
  const MODE = {
    idle: { R: 44, spin: 0.2, glow: 0.22, lean: 0, think: 0 },
    listening: { R: 60, spin: 0.32, glow: 0.45, lean: 1, think: 0 },
    thinking: { R: 38, spin: 1.8, glow: 0.55, lean: 0, think: 1 },
    speaking: { R: 52, spin: 0.42, glow: 0.6, lean: 0, think: 0 },
  };
  function center() { const r = anchor.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, scale: r.width / 150 }; }

  let missions = [];
  function edgePoint(el, p, pad = 6) {
    const r = el.getBoundingClientRect();
    const w = r.width + pad * 2, h = r.height + pad * 2, per = 2 * (w + h);
    let d = p.du * per; const j = (p.dv - 0.5) * 7; let x, y;
    if (d < w) { x = d; y = j; } else if ((d -= w) < h) { x = w + j; y = d; } else if ((d -= h) < w) { x = w - d; y = h + j; } else { d -= w; x = j; y = h - d; }
    return { x: r.left - pad + x, y: r.top - pad + y };
  }
  /** Send a group of workers to frame an element, hold, and come home. */
  function mission(el, opts = {}) {
    if (!el || !el.isConnected) return null;
    const count = Math.min(opts.count || 700, P.length);
    const m = { el, k: 0.045, damp: 0.84, born: S.t, hold: (opts.hold || 2600) / 1000, stagger: opts.stagger ?? 0.8 };
    const free = P.filter(p => !p.m);
    for (let i = free.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [free[i], free[j]] = [free[j], free[i]]; }
    m.members = free.slice(0, count);
    m.members.forEach((p, i) => { p.m = m; p.delay = S.t + (i / m.members.length) * m.stagger; p.du = Math.random(); p.dv = Math.random(); });
    missions.push(m);
    if (opts.glow !== false) { el.style.transition = 'background-color .8s ease'; el.style.backgroundColor = dark ? 'rgba(204,255,0,.07)' : 'rgba(127,163,0,.07)'; setTimeout(() => { el.style.backgroundColor = ''; }, m.hold * 1000 + 900); }
    return m;
  }
  function endMission(m) { m.members.forEach(p => { p.m = null; }); missions = missions.filter(x => x !== m); }

  // ── canvas sizing ──
  let W = 0, H = 0, DPR = 1;
  function resize() {
    DPR = Math.min(devicePixelRatio || 1, 2); W = innerWidth; H = innerHeight;
    field.width = W * DPR; field.height = H * DPR; ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    if (hasGL) { core.width = W * DPR; core.height = H * DPR; gl.viewport(0, 0, core.width, core.height); }
  }
  resize(); addEventListener('resize', resize);

  // ── frame loop, with a self-tuning particle count ──
  let last = performance.now(), fpsAcc = 0, fpsN = 0, good = 0, bad = 0, running = true;
  function frame(now) {
    if (!running) return;
    const dt = Math.min(0.05, (now - last) / 1000); last = now; S.t += dt;
    const M = MODE[S.mode] || MODE.idle, ease = 1 - Math.pow(0.001, dt);
    S.R += (M.R - S.R) * ease * 0.9; S.spin += (M.spin - S.spin) * ease; S.glow += (M.glow - S.glow) * ease;
    S.lean += (M.lean - S.lean) * ease; S.think += (M.think - S.think) * ease;
    S.ay += S.spin * dt * (reduce ? 0.5 : 1);
    let target = 0;
    if (typeof S.levelFn === 'function') { try { target = S.levelFn() || 0; } catch (_) { target = 0; } }
    else if (S.mode === 'listening') target = 0.18 + 0.12 * Math.sin(S.t * 5);
    S.ampTarget = target; S.amp += (S.ampTarget - S.amp) * Math.min(1, dt * 18);

    const C = center(), R = S.R * C.scale;
    const breathe = 1 + Math.sin(S.t * 1.25) * (reduce ? 0.02 : 0.045), tilt = 0.38 + Math.sin(S.t * 0.4) * 0.08;
    ctx.clearRect(0, 0, W, H);
    const haloR = R * (2.2 + S.amp * 1.1);
    const g = ctx.createRadialGradient(C.x, C.y, 0, C.x, C.y, haloR);
    g.addColorStop(0, `rgba(${GLOW},${(dark ? 0.08 : 0.04) + S.glow * (dark ? 0.2 : 0.11) + S.amp * 0.12})`);
    g.addColorStop(1, `rgba(${GLOW},0)`);
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(C.x, C.y, haloR, 0, Math.PI * 2); ctx.fill();

    const onScreen = C.y > -R * 3 && C.y < H + R * 3;
    if (hasGL) {
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); gl.enable(gl.BLEND);
      if (dark) gl.blendFunc(gl.SRC_ALPHA, gl.ONE); else gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(prog);
      gl.uniform2f(loc.u_res, W, H); gl.uniform2f(loc.u_c, C.x, C.y);
      gl.uniform1f(loc.u_t, S.t); gl.uniform1f(loc.u_R, R); gl.uniform1f(loc.u_ay, S.ay);
      gl.uniform1f(loc.u_tilt, tilt); gl.uniform1f(loc.u_amp, S.amp); gl.uniform1f(loc.u_lean, S.lean);
      gl.uniform1f(loc.u_think, S.think); gl.uniform1f(loc.u_breath, breathe); gl.uniform1f(loc.u_dpr, DPR);
      gl.uniform1f(loc.u_alpha, Math.max(0.03, Math.min(0.9, (dark ? 44 : 78) / Math.sqrt(coreN) * (C.scale < 0.7 ? 0.8 : 1))));
      gl.uniform1f(loc.u_flow, reduce ? 0.4 : 1);
      const ink = INK().split(',').map(v => parseFloat(v) / 255);
      gl.uniform3fv(loc.u_ink, ink); gl.uniform3fv(loc.u_glow, [0.8, 1, 0]);
      if (onScreen) gl.drawArrays(gl.POINTS, 0, coreN);
    }

    // workers
    const cy = Math.cos(S.ay), sy = Math.sin(S.ay), ct = Math.cos(tilt), st = Math.sin(tilt);
    const buckets = [[], [], [], [], [], []];
    for (const m of missions.slice()) {
      if (!m.el.isConnected || S.t - m.born > m.stagger + m.hold + 0.8) endMission(m);
    }
    for (const p of P) {
      let tx, ty, k = 0.22, damp = 0.62, depth = 0.5;
      const m = p.m;
      if (m && S.t >= p.delay) {
        const pt = edgePoint(m.el, p);
        tx = pt.x + Math.sin(S.t * 3 + p.ph) * 2.5; ty = pt.y + Math.cos(S.t * 2.6 + p.ph) * 2.5; k = m.k; damp = m.damp; depth = 0.9;
      } else {
        const x1 = p.ux * cy - p.uz * sy, z1 = p.ux * sy + p.uz * cy, y2 = p.uy * ct - z1 * st, z2 = p.uy * st + z1 * ct;
        let rr = p.r * R * breathe * (1 + S.amp * 0.42 * Math.sin(p.ph * 3 + S.t * 11 + p.uy * 7));
        rr *= 1 - S.think * 0.2 + S.think * 0.25 * Math.sin(p.ph + S.t * 6);
        tx = C.x + x1 * rr - S.lean * (z2 + 1) * 10; ty = C.y + y2 * rr + S.lean * (z2 + 1) * 8; depth = (z2 + 1) / 2;
      }
      p.vx = (p.vx + (tx - p.x) * k) * damp; p.vy = (p.vy + (ty - p.y) * k) * damp; p.x += p.vx; p.y += p.vy;
      if (hasGL) { const away = Math.hypot(p.x - C.x, p.y - C.y) - R * 1.05; p.vis = Math.max(0, Math.min(1, away / 28)); if (p.vis <= 0.01) continue; }
      buckets[(p.acc ? 3 : 0) + Math.min(2, Math.floor(depth * 3))].push(p);
    }
    const alphaFor = dark ? [0.28, 0.55, 0.9] : [0.35, 0.6, 0.9];
    for (let i = 0; i < 6; i++) {
      const list = buckets[i]; if (!list.length) continue;
      const acc = i >= 3, lvl = i % 3;
      ctx.fillStyle = acc ? `rgba(${dark ? GLOW : '127,163,0'},${Math.min(1, alphaFor[lvl] + 0.1)})` : `rgba(${INK()},${alphaFor[lvl]})`;
      ctx.beginPath();
      for (const p of list) { const r = p.sz * (0.7 + lvl * 0.35) * (0.4 + 0.6 * p.vis); ctx.moveTo(p.x + r, p.y); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); }
      ctx.fill();
    }

    // Tune to the device: climb toward a million while it stays smooth, step down if it doesn't.
    fpsAcc += dt; fpsN++;
    if (fpsAcc >= 1) {
      const fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0;
      if (!reduce && hasGL && !document.hidden) {
        if (fps >= 57) { good++; bad = 0; } else if (fps < 40) { bad++; good = 0; } else { good = 0; bad = 0; }
        if (good >= 3 && level < LEVELS.length - 1 && !small) { setLevel(level + 1); good = 0; }
        if (bad >= 2 && level > 0) { setLevel(level - 1); bad = 0; }
      }
    }
    rafId = requestAnimationFrame(frame);
  }
  { const C = center(); P.forEach(p => { p.x = C.x + (Math.random() - .5) * 4; p.y = C.y + (Math.random() - .5) * 4; }); }
  let rafId = requestAnimationFrame(frame);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { running = false; cancelAnimationFrame(rafId); }
    else if (!running) { running = true; last = performance.now(); cancelAnimationFrame(rafId); rafId = requestAnimationFrame(frame); }
  });

  // ── the calendar: welcome new bookings, glance at the next client ──
  addEventListener('lola:agenda', (e) => {
    const fresh = (e.detail && e.detail.fresh) || [];
    fresh.slice(0, 3).forEach((id, i) => setTimeout(() => {
      const el = document.querySelector(`[data-booking-id="${CSS.escape(String(id))}"]`);
      if (el) mission(el, { count: 750, hold: 3000 });
    }, 400 + i * 1400));
  });
  function nextUp() {
    const rows = [...document.querySelectorAll('[data-booking-id][data-start]')];
    const now = Date.now();
    return rows.find(r => { const t = Date.parse(r.dataset.start); return t > now && t - now < 3 * 3600e3; }) || null;
  }
  if (!reduce) setInterval(() => {
    if (document.hidden || missions.length || S.mode !== 'idle') return;
    const el = nextUp(); if (el) mission(el, { count: 160, hold: 1800, stagger: 1.2, glow: false });
  }, 26000);

  window.LolaStage = {
    anchor,
    setMode(m) { if (MODE[m]) S.mode = m; },
    get mode() { return S.mode; },
    setLevel(fn) { S.levelFn = typeof fn === 'function' ? fn : null; },
    mission,
    get particles() { return hasGL ? coreN : 0; },
    setDetail(n) { const i = LEVELS.indexOf(n); if (i >= 0) setLevel(i); },
  };
})();
