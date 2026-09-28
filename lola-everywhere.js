/* LolaDesk — Lola, present on every page.
 *
 * A small living particle Lola in the corner. Tap her (or ⌘J / Ctrl+J) to
 * talk or type. She runs the same brain as the dashboard (/api/lola: Telnyx AI,
 * persistent memory, owner tools), answers in her own voice (/api/speak-lola),
 * knows which page and client you're looking at, and keeps one conversation
 * as you move between pages.
 *
 * (Named lola-everywhere.js: /lola-presence.js is the dashboard orb bridge.)
 * Loaded by auth-guard.js on every signed-in page, and directly on the pages
 * that don't use auth-guard. Safe to load twice.
 */
(function () {
  if (window.LolaEverywhere) return;
  const TOKEN_KEY = 'loladesk_token';
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} },
    sget(k) { try { return sessionStorage.getItem(k); } catch (_) { return null; } },
    sset(k, v) { try { v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch (_) {} },
  };
  const token = () => { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (_) { return ''; } };
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ── where am I? ───────────────────────────────────────────
  const extraContext = {};
  function pageName() {
    const p = location.pathname.replace(/\.html$/, '').replace(/^\//, '') || 'dashboard';
    return p.split('/')[0];
  }
  function heading() {
    const t = (document.querySelector('#cpName, [data-client-name], .client-name, h1')?.textContent || '').trim();
    return /^loading/i.test(t) ? '' : t;
  }
  function pageContext() {
    const page = pageName();
    const qs = new URLSearchParams(location.search);
    const h1 = heading().slice(0, 80);
    const bits = [`The owner is on the "${page}" page of LolaDesk.`];
    if (page === 'client' && h1) bits.push(`They are looking at the client "${h1}"${qs.get('id') ? ` (client id ${qs.get('id')})` : ''}. "She/he/they/this client" means ${h1}.`);
    else if (h1) bits.push(`The page heading reads "${h1}".`);
    if (page === 'calendar') { const d = document.getElementById('dayDate')?.textContent?.trim(); if (d) bits.push(`The calendar shows ${d}.`); }
    for (const [k, v] of Object.entries(extraContext)) bits.push(`${k}: ${v}`);
    return bits.join(' ');
  }
  function suggestions() {
    const page = pageName();
    const h1 = heading().split(' ')[0];
    if (page === 'client' && h1) return [`When is ${h1} booked next?`, `Text ${h1}`, `Call ${h1}`];
    if (page === 'calendar') return ['Catch me up on today', "Who's coming tomorrow?", 'Move a booking'];
    if (page === 'revenue') return ["How's revenue this month?", 'Compare this week to last week'];
    if (page === 'calls') return ['Catch me up', 'Call back a client'];
    return ['Catch me up', "How's revenue this month?", 'Text my VIP clients'];
  }

  // ── styles (theme follows the page underneath) ────────────
  function pageIsDark() {
    let el = document.body, rgb = null;
    while (el) { const c = getComputedStyle(el).backgroundColor; if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) { rgb = c.match(/\d+/g).map(Number); break; } el = el.parentElement; }
    if (!rgb) return matchMedia('(prefers-color-scheme: dark)').matches;
    return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255 < 0.5;
  }
  function css(dark) {
    const t = dark
      ? { bg: 'rgba(22,22,26,.92)', ink: '#f5f5f7', muted: '#98989f', line: 'rgba(255,255,255,.12)', me: '#2c2c32', lola: 'rgba(204,255,0,.12)', acc: '#ccff00', accInk: '#000', shadow: '0 24px 70px rgba(0,0,0,.55)' }
      : { bg: 'rgba(255,255,255,.9)', ink: '#1d1d1f', muted: '#6e6e73', line: 'rgba(0,0,0,.1)', me: '#f0f0f3', lola: 'rgba(127,163,0,.10)', acc: '#1d1d1f', accInk: '#fff', shadow: '0 24px 70px rgba(0,0,0,.18)' };
    return `
    .lp-root { --lp-bg:${t.bg}; --lp-ink:${t.ink}; --lp-muted:${t.muted}; --lp-line:${t.line}; --lp-me:${t.me}; --lp-lola:${t.lola}; --lp-acc:${t.acc}; --lp-acc-ink:${t.accInk}; --lp-shadow:${t.shadow};
      font: 400 15px/1.45 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", "Inter", system-ui, sans-serif; color: var(--lp-ink); }
    .lp-orb { position: fixed; right: calc(20px + env(safe-area-inset-right, 0px)); bottom: calc(20px + env(safe-area-inset-bottom, 0px)); width: 72px; height: 72px; z-index: 2147482000;
      border: 0; padding: 0; background: transparent; cursor: pointer; border-radius: 50%; transition: transform .3s cubic-bezier(.32,.72,0,1); }
    .lp-orb:hover { transform: scale(1.08); } .lp-orb:active { transform: scale(.96); }
    .lp-orb:focus-visible { outline: 2px solid #ccff00; outline-offset: 4px; }
    .lp-orb canvas { width: 100%; height: 100%; display: block; pointer-events: none; }
    .lp-panel { position: fixed; right: calc(16px + env(safe-area-inset-right, 0px)); bottom: calc(104px + env(safe-area-inset-bottom, 0px)); width: min(400px, calc(100vw - 32px)); max-height: min(620px, calc(100vh - 140px));
      z-index: 2147482001; display: flex; flex-direction: column; background: var(--lp-bg); border: 1px solid var(--lp-line); border-radius: 24px; box-shadow: var(--lp-shadow);
      backdrop-filter: blur(24px) saturate(160%); -webkit-backdrop-filter: blur(24px) saturate(160%);
      transform-origin: 100% 100%; transition: transform .35s cubic-bezier(.32,.72,0,1), opacity .2s ease; }
    .lp-panel[hidden] { display: none !important; }
    .lp-panel.lp-enter { transform: scale(.92) translateY(12px); opacity: 0; }
    /* One Lola: the old "go to dashboard" pill and the per-page atoms step aside. */
    #lolaPresencePill, [data-lola-atom], .lola-core-atom { display: none !important; }
    @media (max-width: 1100px) { .lp-orb { bottom: calc(84px + env(safe-area-inset-bottom, 0px)); width: 60px; height: 60px; } .lp-panel { bottom: calc(156px + env(safe-area-inset-bottom, 0px)); max-height: calc(100vh - 190px); } }
    @media (max-width: 520px) { .lp-panel { right: 8px; left: 8px; width: auto; } }
    .lp-head { display: flex; align-items: center; gap: 10px; padding: 14px 14px 10px 18px; border-bottom: 1px solid var(--lp-line); }
    .lp-title { font-weight: 600; font-size: 16px; letter-spacing: -.01em; flex: 1; }
    .lp-title small { display: block; font-weight: 400; font-size: 12px; color: var(--lp-muted); letter-spacing: 0; }
    .lp-icon { width: 34px; height: 34px; border-radius: 50%; border: 1px solid var(--lp-line); background: transparent; color: var(--lp-ink); cursor: pointer; display: grid; place-items: center; font-size: 15px; }
    .lp-icon:hover { background: var(--lp-me); } .lp-icon:focus-visible { outline: 2px solid #ccff00; outline-offset: 2px; }
    .lp-thread { flex: 1; overflow-y: auto; padding: 14px 14px 6px; display: flex; flex-direction: column; gap: 10px; min-height: 120px; }
    .lp-msg { max-width: 86%; padding: 10px 14px; border-radius: 18px; white-space: pre-wrap; word-wrap: break-word; }
    .lp-msg.me { align-self: flex-end; background: var(--lp-me); border-bottom-right-radius: 6px; }
    .lp-msg.lola { align-self: flex-start; background: var(--lp-lola); border-bottom-left-radius: 6px; }
    .lp-msg.err { align-self: flex-start; color: #c62828; background: rgba(198,40,40,.08); }
    .lp-typing { align-self: flex-start; color: var(--lp-muted); font-size: 13px; padding: 4px 6px; }
    .lp-confirm { display: flex; gap: 8px; align-self: flex-start; }
    .lp-chips { display: flex; gap: 6px; flex-wrap: wrap; padding: 4px 14px 8px; }
    .lp-chip, .lp-btn { font: 500 13px inherit; font-family: inherit; color: var(--lp-ink); background: transparent; border: 1px solid var(--lp-line); border-radius: 999px; padding: 7px 12px; cursor: pointer; }
    .lp-chip:hover, .lp-btn:hover { background: var(--lp-me); }
    .lp-btn.pri { background: var(--lp-acc); color: var(--lp-acc-ink); border-color: var(--lp-acc); font-weight: 600; }
    .lp-chip:focus-visible, .lp-btn:focus-visible { outline: 2px solid #ccff00; outline-offset: 2px; }
    .lp-form { display: flex; align-items: flex-end; gap: 8px; padding: 10px 12px 12px; border-top: 1px solid var(--lp-line); }
    .lp-input { flex: 1; resize: none; max-height: 120px; min-height: 40px; padding: 10px 14px; border-radius: 20px; border: 1px solid var(--lp-line); background: transparent; color: var(--lp-ink); font: inherit; outline: none; }
    .lp-input:focus { border-color: #ccff00; }
    .lp-badge { position: absolute; top: 2px; right: 2px; min-width: 20px; height: 20px; padding: 0 6px; border-radius: 10px; background: #ff3b30; color: #fff; font: 600 12px/20px -apple-system, system-ui, sans-serif; box-shadow: 0 0 0 2px var(--lp-bg); pointer-events: none; }
    .lp-badge.dot { min-width: 12px; width: 12px; height: 12px; padding: 0; top: 6px; right: 6px; background: #ccff00; }
    .lp-badge[hidden], .lp-nudge[hidden] { display: none !important; }
    .lp-nudge { position: fixed; right: calc(104px + env(safe-area-inset-right, 0px)); bottom: calc(30px + env(safe-area-inset-bottom, 0px)); z-index: 2147482000; max-width: 280px; text-align: left;
      padding: 10px 14px; border-radius: 16px; border: 1px solid var(--lp-line); background: var(--lp-bg); color: var(--lp-ink); box-shadow: var(--lp-shadow); cursor: pointer; font: inherit;
      backdrop-filter: blur(24px) saturate(160%); -webkit-backdrop-filter: blur(24px) saturate(160%); animation: lp-in .45s cubic-bezier(.32,.72,0,1); }
    .lp-nudge b { display: block; font-weight: 600; font-size: 14px; } .lp-nudge span { display: block; font-size: 13px; color: var(--lp-muted); }
    @keyframes lp-in { from { opacity: 0; transform: translateX(10px) scale(.96); } }
    @media (max-width: 1100px) { .lp-nudge { bottom: calc(92px + env(safe-area-inset-bottom, 0px)); right: calc(88px + env(safe-area-inset-right, 0px)); } }
    .lp-send { background: var(--lp-acc); color: var(--lp-acc-ink); border-color: var(--lp-acc); }
    .lp-mic.on { background: #ccff00; color: #000; border-color: #ccff00; animation: lp-pulse 1.2s ease-in-out infinite; }
    @keyframes lp-pulse { 50% { box-shadow: 0 0 0 6px rgba(204,255,0,.25); } }
    @media (prefers-reduced-motion: reduce) { .lp-orb, .lp-panel { transition: none; } .lp-mic.on { animation: none; } }`;
  }

  // ── Lola's body: GPU micro-particles (fallback: soft gradient orb) ──
  function Body(canvas) {
    const S = { mode: 'idle', amp: 0, target: 0, R: 0.62, t: 0, ay: 0, spin: 0.25, think: 0 };
    const MODE = { idle: { R: 0.62, spin: 0.25, think: 0 }, listening: { R: 0.8, spin: 0.35, think: 0 }, thinking: { R: 0.55, spin: 1.8, think: 1 }, speaking: { R: 0.72, spin: 0.45, think: 0 } };
    let gl = null, prog, loc = {}, n = 0, dark = false, ctx2d = null;
    const size = 72, dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = size * dpr; canvas.height = size * dpr;
    try { gl = canvas.getContext('webgl', { premultipliedAlpha: false, alpha: true, antialias: false }); } catch (_) {}
    if (gl) {
      try {
        const vs = `attribute vec3 a_d; attribute vec2 a_p; uniform float u_t,u_R,u_ay,u_amp,u_th,u_dpr,u_al; varying float v_a; varying float v_g;
          void main(){ vec3 d=a_d; float t=u_t;
            d=normalize(d+0.2*vec3(sin(t*.71+d.y*3.1+a_p.x),sin(t*.63+d.z*2.7+a_p.x*1.3),sin(t*.82+d.x*3.3+a_p.x*.7)));
            float cy=cos(u_ay),sy=sin(u_ay),x1=d.x*cy-d.z*sy,z1=d.x*sy+d.z*cy,y2=d.y*.93-z1*.37,z2=d.y*.37+z1*.93;
            float r=a_p.y; if(r>1.0) r+=.12*sin(t*.5+a_p.x*3.);
            r*=1.+u_amp*.42*sin(a_p.x*3.+t*11.+d.y*7.); r*=mix(1.,.8+.25*sin(a_p.x+t*6.),u_th); r*=1.+.045*sin(t*1.25); r+=.012*sin(t*23.+a_p.x*57.);
            gl_Position=vec4(x1*r*u_R, -y2*r*u_R, 0., 1.); float dp=(z2+1.)*.5;
            gl_PointSize=(.8+.8*dp)*u_dpr; v_g=step(.91,fract(a_p.x*7.3)); v_a=(.3+.7*dp)*u_al*(a_p.y>1.?.45:1.)*(v_g>.5?2.4:1.)*(1.+u_amp*.6); }`;
        const fs = `precision mediump float; uniform vec3 u_ink,u_glow; varying float v_a; varying float v_g;
          void main(){ vec2 q=gl_PointCoord-.5; float d=dot(q,q); if(d>.25) discard; gl_FragColor=vec4(v_g>.5?u_glow:u_ink, clamp(v_a*(1.-d*3.2),0.,1.)); }`;
        const sh = (t, s) => { const x = gl.createShader(t); gl.shaderSource(x, s); gl.compileShader(x); if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x)); return x; };
        prog = gl.createProgram(); gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('link');
        gl.useProgram(prog);
        ['u_t', 'u_R', 'u_ay', 'u_amp', 'u_th', 'u_dpr', 'u_al', 'u_ink', 'u_glow'].forEach(k => loc[k] = gl.getUniformLocation(prog, k));
        n = reduce ? 6000 : 22000;
        const a = new Float32Array(n * 5);
        for (let i = 0, o = 0; i < n; i++, o += 5) {
          const u = Math.random() * 2 - 1, th = Math.random() * 6.2832, s = Math.sqrt(1 - u * u), roll = Math.random();
          a[o] = s * Math.cos(th); a[o + 1] = u; a[o + 2] = s * Math.sin(th); a[o + 3] = Math.random() * 6.2832;
          a[o + 4] = roll < .64 ? .8 + .2 * Math.sqrt(Math.random()) : roll < .92 ? Math.cbrt(Math.random()) * .8 : 1.02 + Math.random() * .3;
        }
        const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, a, gl.STATIC_DRAW);
        const ad = gl.getAttribLocation(prog, 'a_d'), ap = gl.getAttribLocation(prog, 'a_p');
        gl.enableVertexAttribArray(ad); gl.vertexAttribPointer(ad, 3, gl.FLOAT, false, 20, 0);
        gl.enableVertexAttribArray(ap); gl.vertexAttribPointer(ap, 2, gl.FLOAT, false, 20, 12);
        gl.viewport(0, 0, canvas.width, canvas.height);
      } catch (e) { gl = null; }
    }
    if (!gl) ctx2d = canvas.getContext('2d');
    let last = performance.now();
    function frame(now) {
      const dt = Math.min(.05, (now - last) / 1000); last = now; S.t += dt;
      const M = MODE[S.mode] || MODE.idle, e = 1 - Math.pow(.001, dt);
      S.R += (M.R - S.R) * e; S.spin += (M.spin - S.spin) * e; S.think += (M.think - S.think) * e;
      S.ay += S.spin * dt * (reduce ? .5 : 1);
      S.target = typeof S.level === 'function' ? S.level() : (S.mode === 'listening' ? .2 + .1 * Math.sin(S.t * 5) : 0);
      S.amp += (S.target - S.amp) * Math.min(1, dt * 18);
      if (gl) {
        gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); gl.enable(gl.BLEND);
        dark ? gl.blendFunc(gl.SRC_ALPHA, gl.ONE) : gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.uniform1f(loc.u_t, S.t); gl.uniform1f(loc.u_R, S.R * 0.78); gl.uniform1f(loc.u_ay, S.ay); gl.uniform1f(loc.u_amp, S.amp);
        gl.uniform1f(loc.u_th, S.think); gl.uniform1f(loc.u_dpr, dpr); gl.uniform1f(loc.u_al, (dark ? 44 : 78) / Math.sqrt(n));
        gl.uniform3fv(loc.u_ink, dark ? [0.96, 0.96, 0.97] : [0.11, 0.11, 0.12]); gl.uniform3fv(loc.u_glow, [0.8, 1, 0]);
        gl.drawArrays(gl.POINTS, 0, n);
      } else if (ctx2d) {
        const w = canvas.width, r = w * .32 * (S.R / .62) * (1 + S.amp * .2);
        ctx2d.clearRect(0, 0, w, w);
        const g = ctx2d.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, r);
        g.addColorStop(0, 'rgba(204,255,0,.95)'); g.addColorStop(.6, dark ? 'rgba(245,245,247,.5)' : 'rgba(29,29,31,.55)'); g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx2d.fillStyle = g; ctx2d.beginPath(); ctx2d.arc(w / 2, w / 2, r, 0, 6.2832); ctx2d.fill();
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
    return { set mode(m) { S.mode = m; }, get mode() { return S.mode; }, set level(fn) { S.level = fn; }, set dark(d) { dark = d; } };
  }

  // ── voice out: Lola's own voice, driving her particles ──
  let audioCtx = null, currentAudio = null;
  async function speak(text, body) {
    if (store.get('lola.muted', false) || !text) return;
    try {
      if (currentAudio) { currentAudio.pause(); currentAudio = null; }
      const a = new Audio(`/api/speak-lola?text=${encodeURIComponent(text.slice(0, 600))}`);
      a.crossOrigin = 'anonymous'; currentAudio = a;
      try {
        audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
        await audioCtx.resume();
        const src = audioCtx.createMediaElementSource(a), an = audioCtx.createAnalyser(); an.fftSize = 512;
        src.connect(an); an.connect(audioCtx.destination);
        const buf = new Uint8Array(an.fftSize);
        body.level = () => { an.getByteTimeDomainData(buf); let s = 0; for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; s += v * v; } return Math.min(1, Math.sqrt(s / buf.length) * 4.2); };
      } catch (_) { body.level = () => 0.35 + 0.25 * Math.sin(performance.now() / 90); }
      body.mode = 'speaking';
      a.onended = a.onerror = () => { body.level = null; if (body.mode === 'speaking') body.mode = 'idle'; };
      await a.play();
    } catch (_) { body.level = null; body.mode = 'idle'; }
  }

  const I = (d) => `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICON = {
    mic: I('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>'),
    send: I('<path d="M12 19V5M5 12l7-7 7 7"/>'),
    close: I('<path d="M6 6l12 12M18 6L6 18"/>'),
    on: I('<path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>'),
    off: I('<path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M17 9l5 6M22 9l-5 6"/>'),
  };

  // ── the conversation ──────────────────────────────────────
  let thread = store.get('lola.thread', []);
  function remember(role, text) { thread.push({ role, text, at: Date.now() }); thread = thread.slice(-40); store.set('lola.thread', thread); }

  async function ask(text) {
    const history = thread.filter(m => m.role === 'user' || m.role === 'assistant').slice(-10).map(m => ({ role: m.role, content: m.text }));
    const r = await fetch('/api/lola', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token() },
      body: JSON.stringify({ messages: [...history, { role: 'user', content: text }], channel: 'dashboard', system: pageContext() }),
    });
    const d = await r.json().catch(() => ({}));
    if (r.status === 401) throw new Error('Your session expired. Sign in again.');
    if (!r.ok) throw new Error(d?.error?.message || d?.error || `Lola couldn't answer (${r.status}).`);
    return { text: d?.content?.[0]?.text || '…', actions: d.actions || [], confirm: !!d.needs_confirmation };
  }

  function applyActions(actions) {
    for (const a of actions || []) {
      if (a.navigate) { store.sset('lola.reopen', '1'); setTimeout(() => { location.href = a.navigate; }, 900); }
      if (a.refresh) {
        window.dispatchEvent(new CustomEvent('lola:refresh', { detail: a }));
        if (a.refresh === 'bookings' && /calendar|dashboard|bookings/.test(pageName())) { store.sset('lola.reopen', '1'); setTimeout(() => location.reload(), 1600); }
      }
      if (a.client_id && pageName() !== 'client') window.dispatchEvent(new CustomEvent('lola:client', { detail: a }));
    }
  }

  // ── while you were away ───────────────────────────────────
  const AWAY_MS = 2 * 3600e3;
  let onAway = null;                       // set by the panel once mounted
  function markSeen() { store.set('lola.seen', Date.now()); }
  async function checkAway(prev) {
    if (!prev || Date.now() - prev < AWAY_MS) return;
    try {
      const r = await fetch('/api/lola/away?since=' + encodeURIComponent(new Date(prev).toISOString()), { headers: { Authorization: 'Bearer ' + token() } });
      if (!r.ok) return;
      const d = await r.json().catch(() => ({}));
      const brief = d && d.brief;
      if (!brief || !brief.notable) return;
      if (onAway) onAway(brief);
      else if (window.LolaNotify && typeof window.LolaNotify.show === 'function') window.LolaNotify.show({ title: 'While you were away', sub: brief.say, tone: brief.counts && brief.counts.needs_you ? 'call' : 'plain', sticky: true });
    } catch (_) {}
  }
  function startPresenceClock() {
    const prev = Number(store.get('lola.seen', 0)) || 0;
    markSeen();
    setInterval(() => { if (!document.hidden) markSeen(); }, 60e3);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { markSeen(); return; }
      const before = Number(store.get('lola.seen', 0)) || 0;
      markSeen(); checkAway(before);
    });
    addEventListener('pagehide', markSeen);
    return prev;
  }

  // ── mount ─────────────────────────────────────────────────
  function mount() {
    if (!token()) return;                                                  // signed-in pages only
    if (window.__lolaClock) return; window.__lolaClock = true;
    const prevSeen = startPresenceClock();
    if (document.getElementById('orbMic') || document.getElementById('cmdInput')) { setTimeout(() => checkAway(prevSeen), 1500); return; } // the dashboard has its own Lola
    if (document.querySelector('.lp-root')) return;
    // The calendar's old white atom is replaced by Lola herself.
    ['atom', 'atomOverlay'].forEach(id => { const el = document.getElementById(id); if (el) el.hidden = true; });

    const style = document.createElement('style'); style.id = 'lp-css'; style.textContent = css(pageIsDark()); document.head.appendChild(style);
    const root = document.createElement('div'); root.className = 'lp-root';
    root.innerHTML = `
      <button class="lp-orb" type="button" aria-label="Talk to Lola (⌘J)" aria-expanded="false"><canvas></canvas></button>
      <section class="lp-panel lp-enter" role="dialog" aria-label="Lola" hidden>
        <header class="lp-head">
          <div class="lp-title">Lola<small>Your front desk · ⌘J</small></div>
          <button class="lp-icon lp-mute" type="button" aria-label="Mute Lola's voice"></button>
          <button class="lp-icon lp-close" type="button" aria-label="Close">${ICON.close}</button>
        </header>
        <div class="lp-thread" aria-live="polite"></div>
        <div class="lp-chips"></div>
        <form class="lp-form">
          <textarea class="lp-input" id="lp-input" rows="1" placeholder="Ask Lola to do anything…" aria-label="Message Lola"></textarea>
          <button class="lp-icon lp-mic" type="button" aria-label="Speak to Lola">${ICON.mic}</button>
          <button class="lp-icon lp-send" type="submit" aria-label="Send">${ICON.send}</button>
        </form>
      </section>`;
    document.body.appendChild(root);

    const orb = root.querySelector('.lp-orb'), panel = root.querySelector('.lp-panel'), threadEl = root.querySelector('.lp-thread');
    const chipsEl = root.querySelector('.lp-chips'), form = root.querySelector('.lp-form'), input = root.querySelector('.lp-input');
    const mic = root.querySelector('.lp-mic'), mute = root.querySelector('.lp-mute');
    const body = Body(orb.querySelector('canvas'));
    body.dark = pageIsDark();

    const renderMute = () => { const m = store.get('lola.muted', false); mute.innerHTML = m ? ICON.off : ICON.on; mute.setAttribute('aria-label', m ? "Turn Lola's voice on" : "Mute Lola's voice"); };
    renderMute();
    mute.onclick = () => { store.set('lola.muted', !store.get('lola.muted', false)); renderMute(); if (currentAudio) currentAudio.pause(); };

    function bubble(role, text) {
      const el = document.createElement('div'); el.className = 'lp-msg ' + (role === 'user' ? 'me' : role === 'error' ? 'err' : 'lola');
      el.textContent = text; threadEl.appendChild(el); threadEl.scrollTop = threadEl.scrollHeight; return el;
    }
    function renderThread() {
      threadEl.innerHTML = '';
      if (!thread.length) bubble('assistant', "Hi, I'm here. I can text or call clients, move or cancel bookings, fill open slots, send offers, and catch you up. What do you need?");
      thread.slice(-20).forEach(m => bubble(m.role, m.text));
    }
    function renderChips(list) {
      chipsEl.innerHTML = '';
      (list && list.length ? list : suggestions()).forEach(s => { const b = document.createElement('button'); b.type = 'button'; b.className = 'lp-chip'; b.textContent = s; b.onclick = () => send(s); chipsEl.appendChild(b); });
    }

    let busy = false;
    async function send(text) {
      text = String(text || '').trim(); if (!text || busy) return;
      busy = true; input.value = ''; autosize();
      threadEl.querySelectorAll('.lp-confirm').forEach(n => n.remove());
      remember('user', text); bubble('user', text);
      const typing = document.createElement('div'); typing.className = 'lp-typing'; typing.textContent = 'Lola is working on it…'; threadEl.appendChild(typing);
      threadEl.scrollTop = threadEl.scrollHeight;
      body.mode = 'thinking';
      try {
        const out = await ask(text);
        typing.remove(); remember('assistant', out.text); bubble('assistant', out.text);
        if (out.confirm) {
          const row = document.createElement('div'); row.className = 'lp-confirm';
          row.innerHTML = '<button type="button" class="lp-btn pri">Yes, do it</button><button type="button" class="lp-btn">No</button>';
          row.children[0].onclick = () => send('yes'); row.children[1].onclick = () => send('no');
          threadEl.appendChild(row); threadEl.scrollTop = threadEl.scrollHeight;
        }
        body.mode = 'idle';
        speak(out.text, body);
        applyActions(out.actions);
      } catch (e) {
        typing.remove(); bubble('error', e.message || 'Something went wrong.'); body.mode = 'idle';
      } finally { busy = false; }
    }

    function autosize() { input.style.height = 'auto'; input.style.height = Math.min(120, input.scrollHeight) + 'px'; }
    input.addEventListener('input', autosize);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input.value); } });
    form.addEventListener('submit', (e) => { e.preventDefault(); send(input.value); });

    let awayBrief = null;
    function open() {
      panel.hidden = false; orb.setAttribute('aria-expanded', 'true');
      const brief = awayBrief; awayBrief = null; clearAway();
      if (brief) remember('assistant', brief.say);
      renderThread(); renderChips(brief && brief.suggestions);
      if (brief) speak(brief.say, body);
      requestAnimationFrame(() => panel.classList.remove('lp-enter'));
      setTimeout(() => input.focus(), 50);
      if (body.mode === 'idle') body.mode = 'listening'; setTimeout(() => { if (body.mode === 'listening') body.mode = 'idle'; }, 1200);
    }
    function close() {
      panel.classList.add('lp-enter'); orb.setAttribute('aria-expanded', 'false');
      setTimeout(() => { panel.hidden = true; }, 200); stopListening();
    }
    const toggle = () => (panel.hidden ? open() : close());
    orb.onclick = toggle;
    root.querySelector('.lp-close').onclick = close;
    addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'j') { e.preventDefault(); toggle(); }
      if (e.key === 'Escape' && !panel.hidden) close();
    });

    // voice in (browser speech recognition)
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    let rec = null;
    function stopListening() { try { rec && rec.stop(); } catch (_) {} rec = null; mic.classList.remove('on'); if (body.mode === 'listening') body.mode = 'idle'; }
    if (!SR) mic.hidden = true;
    else mic.onclick = () => {
      if (rec) return stopListening();
      rec = new SR(); rec.lang = 'en-US'; rec.interimResults = true; rec.continuous = false;
      let finalText = '';
      rec.onresult = (ev) => { let interim = ''; for (let i = ev.resultIndex; i < ev.results.length; i++) { const t = ev.results[i][0].transcript; if (ev.results[i].isFinal) finalText += t; else interim += t; } input.value = (finalText + interim).trim(); autosize(); };
      rec.onerror = () => stopListening();
      rec.onend = () => { const t = (finalText || input.value).trim(); rec = null; mic.classList.remove('on'); if (t) send(t); else if (body.mode === 'listening') body.mode = 'idle'; };
      mic.classList.add('on'); body.mode = 'listening'; if (currentAudio) currentAudio.pause();
      try { rec.start(); } catch (_) { stopListening(); }
    };

    // "While you were away": a badge on Lola and a quiet note beside her.
    const badge = document.createElement('span'); badge.className = 'lp-badge'; badge.hidden = true; orb.appendChild(badge);
    const nudge = document.createElement('button'); nudge.type = 'button'; nudge.className = 'lp-nudge'; nudge.hidden = true; root.appendChild(nudge);
    nudge.onclick = () => open();
    function clearAway() { badge.hidden = true; nudge.hidden = true; }
    onAway = (brief) => {
      awayBrief = brief;
      if (!panel.hidden) { const b = awayBrief; awayBrief = null; remember('assistant', b.say); bubble('assistant', b.say); renderChips(b.suggestions); return; }
      const n = (brief.counts && brief.counts.needs_you) || 0;
      badge.textContent = n ? String(n) : ''; badge.classList.toggle('dot', !n); badge.hidden = false;
      nudge.innerHTML = '<b>While you were away</b><span></span>'; nudge.lastChild.textContent = brief.headline || 'Tap to catch up';
      nudge.hidden = false; setTimeout(() => { nudge.hidden = true; }, 14000);
    };
    setTimeout(() => checkAway(prevSeen), 1200);

    // Some pages rebuild <body>; keep Lola attached.
    setInterval(() => { if (!root.isConnected && document.body) { document.body.appendChild(root); if (!document.getElementById('lp-css')) document.head.appendChild(style); } }, 1500);

    // Reopen after Lola navigated or refreshed the page for you.
    if (store.sget('lola.reopen')) { store.sset('lola.reopen', null); open(); }
  }

  window.LolaEverywhere = {
    setContext(obj) { Object.assign(extraContext, obj || {}); },
    open() { document.querySelector('.lp-orb')?.click(); },
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
