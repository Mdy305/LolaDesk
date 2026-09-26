/* ============================================================
   LOLA CORE — the canonical Lola module for every LolaDesk page.
   One atom. One brain. One audio pipeline. Every page imports THIS.
   Replaces the fragmented lola-alive / lola-orb / lola-presence /
   lola-live-* / lola-resonance / lola-voice / lola-wake-burst set.
   ============================================================ */
(function (global) {
  'use strict';

  const DEFAULTS = {
    container: null,          // element (or selector) that holds the atom
    mode: 'corner',           // 'corner' | 'center' | 'inline'
    size: 64,                 // px in corner/inline mode
    wake: true,               // enable wake-word listener after first tap
    autoNudge: true,          // enable contextual bubbles
    endpoints: {
      ask:   '/api/lola/ask',
      askFallbacks: ['/api/lola', '/api/lola-brain', '/api/lola-execute'],
      speak: '/api/speak-lola',
    }
  };

  // ── Singleton state ──────────────────────────────────────
  const S = {
    mounted: false,
    engaged: false,
    canvas: null, ctx: null,
    stage: null,
    overlay: null,
    transcript: null, caption: null,
    nudgeEl: null, nudgeTimer: null,
    audioCtx: null,
    micStarted: false,
    micStream: null,
    level: 0, smoothed: 0, phase: 0,
    recognition: null,
    wake: null,
    opts: DEFAULTS,
    onEngageHandlers: [],
    onDisengageHandlers: [],
    onTranscriptHandlers: [],
    onAnswerHandlers: [],
  };

  // ── Public API ───────────────────────────────────────────
  const LolaCore = {
    mount(opts) {
      if (S.mounted) return LolaCore;
      S.opts = Object.assign({}, DEFAULTS, opts || {});
      buildDom();
      startDraw();
      wireEvents();
      if (S.opts.wake) {
        document.addEventListener('click', () => armWake(), { once: true });
      }
      S.mounted = true;
      return LolaCore;
    },
    engage()   { return engage(); },
    disengage(){ return disengage(); },
    speak(text){ return speakAndDrive(text); },
    ask(text)  { return callAsk(text); },
    nudge(text, ms) { return nudge(text, ms); },
    onEngage(fn)     { S.onEngageHandlers.push(fn); return LolaCore; },
    onDisengage(fn)  { S.onDisengageHandlers.push(fn); return LolaCore; },
    onTranscript(fn) { S.onTranscriptHandlers.push(fn); return LolaCore; },
    onAnswer(fn)     { S.onAnswerHandlers.push(fn); return LolaCore; },
    setMicLevel(v){ S.level = clamp(v); },
    setTtsLevel(v){ S.level = clamp(v); },
    element() { return S.stage; },
  };

  function clamp(v){ return Math.max(0, Math.min(1, +v || 0)); }
  function esc(s){ return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  // ── DOM ──────────────────────────────────────────────────
  function buildDom() {
    // Stage (the atom button)
    let stage = typeof S.opts.container === 'string'
      ? document.querySelector(S.opts.container)
      : S.opts.container;
    if (!stage) {
      stage = document.createElement('button');
      stage.className = 'lola-core-atom lola-core-' + S.opts.mode;
      stage.setAttribute('aria-label', 'Talk to Lola');
      document.body.appendChild(stage);
    }
    S.stage = stage;
    S.stage.classList.add('lola-core-atom');

    // Canvas inside stage
    const canvas = document.createElement('canvas');
    canvas.width = 120; canvas.height = 120;
    canvas.className = 'lola-core-canvas';
    canvas.style.pointerEvents = 'none';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    S.stage.style.padding = '0';
    S.stage.style.border = 'none';
    S.stage.style.background = 'transparent';
    S.stage.style.cursor = 'pointer';
    S.stage.appendChild(canvas);
    S.canvas = canvas;
    S.ctx = canvas.getContext('2d');

    // Overlay (fullscreen when engaged)
    const overlay = document.createElement('div');
    overlay.className = 'lola-core-overlay';
    overlay.innerHTML =
      '<button class="lola-core-close" aria-label="Close">×</button>' +
      '<div class="lola-core-transcript"></div>' +
      '<div class="lola-core-caption">Listening…</div>';
    document.body.appendChild(overlay);
    S.overlay = overlay;
    S.transcript = overlay.querySelector('.lola-core-transcript');
    S.caption = overlay.querySelector('.lola-core-caption');

    // Nudge bubble
    const nudge = document.createElement('div');
    nudge.className = 'lola-core-nudge';
    nudge.hidden = true;
    document.body.appendChild(nudge);
    S.nudgeEl = nudge;

    // Inline styles so this works on any page even without CSS include.
    injectStyles();
  }

  function injectStyles() {
    if (document.getElementById('lola-core-styles')) return;
    const st = document.createElement('style');
    st.id = 'lola-core-styles';
    st.textContent = `
      .lola-core-atom{position:fixed;top:20px;right:20px;width:${S.opts.size}px;height:${S.opts.size}px;z-index:100;transition:transform 320ms cubic-bezier(.16,1,.3,1),top 320ms cubic-bezier(.16,1,.3,1),right 320ms cubic-bezier(.16,1,.3,1),width 320ms cubic-bezier(.16,1,.3,1),height 320ms cubic-bezier(.16,1,.3,1)}
      .lola-core-atom:hover{transform:scale(1.06)}
      .lola-core-atom.center{top:calc(50vh - ${S.opts.size/2}px);right:calc(50vw - ${S.opts.size/2}px)}
      .lola-core-atom.expanded{top:calc(50vh - 100px);right:calc(50vw - 100px);width:200px;height:200px}
      .lola-core-atom.inline{position:relative;top:auto;right:auto;display:inline-block}
      .lola-core-overlay{position:fixed;inset:0;background:rgba(255,255,255,.9);-webkit-backdrop-filter:saturate(180%) blur(30px);backdrop-filter:saturate(180%) blur(30px);opacity:0;pointer-events:none;transition:opacity 400ms ease;z-index:50}
      .lola-core-overlay.on{opacity:1;pointer-events:auto}
      .lola-core-close{position:absolute;top:20px;right:20px;width:44px;height:44px;border:none;background:transparent;font-size:30px;line-height:1;color:#86868b;cursor:pointer;border-radius:50%;transition:background 200ms;z-index:200}
      .lola-core-close:hover{background:rgba(0,0,0,.05);color:#1d1d1f}
      .lola-core-transcript{position:absolute;top:18vh;left:50%;transform:translateX(-50%);max-width:min(90vw,640px);padding:0 32px;font:400 22px/1.4 -apple-system,BlinkMacSystemFont,"SF Pro Display",system-ui,sans-serif;color:#1d1d1f;text-align:center;opacity:0;transition:opacity 400ms ease;pointer-events:none}
      .lola-core-transcript.show{opacity:1}
      .lola-core-caption{position:absolute;bottom:12vh;left:50%;transform:translateX(-50%);font:500 12px/1.4 -apple-system,system-ui,sans-serif;letter-spacing:.16em;text-transform:uppercase;color:#86868b;pointer-events:none}
      .lola-core-nudge{position:fixed;top:24px;right:${20 + S.opts.size + 16}px;max-width:260px;padding:12px 16px;border-radius:14px;background:#fff;border:1px solid rgba(0,0,0,.06);box-shadow:0 4px 20px rgba(0,0,0,.06);font:400 13px/1.4 -apple-system,system-ui,sans-serif;color:#1d1d1f;z-index:90;animation:lola-core-nudge-in 400ms cubic-bezier(.16,1,.3,1)}
      .lola-core-nudge::after{content:'';position:absolute;top:24px;right:-6px;width:12px;height:12px;background:#fff;border-right:1px solid rgba(0,0,0,.06);border-top:1px solid rgba(0,0,0,.06);transform:rotate(45deg)}
      @keyframes lola-core-nudge-in{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:translateY(0)}}
    `;
    document.head.appendChild(st);
  }

  // ── Draw loop ────────────────────────────────────────────
  function startDraw() {
    const g = S.ctx, W = S.canvas.width, H = S.canvas.height;
    const CX = W/2, CY = H/2;
    (function draw() {
      S.phase += 0.018;
      S.smoothed += (S.level - S.smoothed) * 0.22;
      const breath = 0.5 + 0.5 * Math.sin(S.phase);
      const pulse = Math.max(S.smoothed, breath * 0.12);
      g.clearRect(0, 0, W, H);
      // Outer glow
      const glowR = 32 + pulse * 40;
      let grad = g.createRadialGradient(CX, CY, 4, CX, CY, glowR);
      grad.addColorStop(0, `rgba(255,255,255,${0.85 - pulse * 0.25})`);
      grad.addColorStop(0.55, `rgba(215,230,255,${0.28 + pulse * 0.35})`);
      grad.addColorStop(1, 'rgba(200,215,240,0)');
      g.fillStyle = grad; g.beginPath(); g.arc(CX, CY, glowR, 0, Math.PI * 2); g.fill();
      // Core
      const coreR = 18 + pulse * 5;
      grad = g.createRadialGradient(CX - 4, CY - 4, 0, CX, CY, coreR);
      grad.addColorStop(0, 'rgba(255,255,255,1)');
      grad.addColorStop(0.7, 'rgba(240,245,255,0.96)');
      grad.addColorStop(1, 'rgba(200,215,240,0.6)');
      g.fillStyle = grad; g.beginPath(); g.arc(CX, CY, coreR, 0, Math.PI * 2); g.fill();
      // Thin ring
      g.strokeStyle = `rgba(120,140,170,${0.12 + pulse * 0.35})`;
      g.lineWidth = 0.8;
      g.beginPath(); g.arc(CX, CY, coreR + 5 + pulse * 4, 0, Math.PI * 2); g.stroke();
      requestAnimationFrame(draw);
    })();
  }

  // ── Wire events ──────────────────────────────────────────
  function wireEvents() {
    S.stage.addEventListener('click', (e) => { e.stopPropagation(); engage(); });
    S.overlay.querySelector('.lola-core-close').addEventListener('click', (e) => {
      e.stopPropagation(); disengage();
    });
    S.overlay.addEventListener('click', (e) => { if (e.target === S.overlay) disengage(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') disengage(); });
  }

  // ── Audio ────────────────────────────────────────────────
  function ensureCtx() {
    if (S.audioCtx) return S.audioCtx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    S.audioCtx = new AC();
    return S.audioCtx;
  }

  async function armMic() {
    const ctx = ensureCtx();
    if (!ctx || S.micStarted) return;
    S.micStarted = true;
    try {
      if (ctx.state === 'suspended') await ctx.resume();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      S.micStream = stream;
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser(); an.fftSize = 512; an.smoothingTimeConstant = 0.6;
      src.connect(an);
      const buf = new Uint8Array(an.frequencyBinCount);
      (function tick() {
        an.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) { const n = (buf[i] - 128) / 128; sum += n * n; }
        S.level = Math.min(1, Math.sqrt(sum / buf.length) * 5);
        requestAnimationFrame(tick);
      })();
    } catch (err) {
      console.warn('[lola-core] mic:', err && err.name);
      S.micStarted = false;
      if (S.caption) S.caption.textContent = 'Mic blocked';
    }
  }

  async function speakAndDrive(text) {
    if (!text) return;
    const ctx = ensureCtx();
    if (!ctx) return;
    if (S.caption) S.caption.textContent = 'Speaking';
    try {
      const r = await fetch(`${S.opts.endpoints.speak}?text=${encodeURIComponent(text)}`, { credentials: 'include' });
      if (!r.ok) throw new Error('tts ' + r.status);
      const arr = await r.arrayBuffer();
      const buf = await ctx.decodeAudioData(arr.slice(0));
      const src = ctx.createBufferSource(); src.buffer = buf;
      const an = ctx.createAnalyser(); an.fftSize = 512; an.smoothingTimeConstant = 0.5;
      src.connect(an); an.connect(ctx.destination);
      const data = new Uint8Array(an.frequencyBinCount);
      let running = true;
      src.onended = () => { running = false; S.level = 0; if (S.caption) S.caption.textContent = 'Listening…'; };
      src.start(0);
      (function tick() {
        if (!running) return;
        an.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) { const n = (data[i] - 128) / 128; sum += n * n; }
        S.level = Math.min(1, Math.sqrt(sum / data.length) * 4.5);
        requestAnimationFrame(tick);
      })();
    } catch (err) {
      console.warn('[lola-core] tts:', err && err.message);
      if (S.caption) S.caption.textContent = 'Listening…';
    }
  }

  // ── Brain (ask endpoint with fallbacks) ──────────────────
  async function callAsk(question) {
    const eps = [S.opts.endpoints.ask, ...S.opts.endpoints.askFallbacks];
    for (const ep of eps) {
      try {
        const r = await fetch(ep, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ question, message: question, text: question })
        });
        if (!r.ok) continue;
        const d = await r.json().catch(() => ({}));
        const ans = d.answer || d.text || d.reply || d.message || d.response || '';
        if (ans) return ans;
      } catch (_) { /* try next */ }
    }
    return '';
  }

  // ── Recognition ──────────────────────────────────────────
  function startRecognition() {
    const R = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!R) { if (S.caption) S.caption.textContent = 'Voice unsupported'; return null; }
    const rec = new R();
    rec.lang = 'en-US'; rec.interimResults = true; rec.continuous = false;
    let finalText = '';
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) finalText += res[0].transcript; else interim += res[0].transcript;
      }
      const t = (finalText + interim).trim();
      if (S.transcript) { S.transcript.textContent = t; S.transcript.classList.add('show'); }
      S.onTranscriptHandlers.forEach(fn => { try { fn(t, false); } catch {} });
    };
    rec.onend = async () => {
      const q = finalText.trim();
      if (!q) { setTimeout(disengage, 800); return; }
      if (S.caption) S.caption.textContent = 'Thinking';
      S.onTranscriptHandlers.forEach(fn => { try { fn(q, true); } catch {} });
      const ans = await callAsk(q);
      if (ans) {
        if (S.transcript) { S.transcript.textContent = ans; S.transcript.classList.add('show'); }
        S.onAnswerHandlers.forEach(fn => { try { fn(ans, q); } catch {} });
        await speakAndDrive(ans);
        setTimeout(() => S.transcript?.classList.remove('show'), 6000);
      } else {
        if (S.transcript) S.transcript.textContent = "I couldn't reach the brain — try again.";
        setTimeout(disengage, 2500);
      }
    };
    try { rec.start(); } catch {}
    return rec;
  }

  // ── Wake word ────────────────────────────────────────────
  function armWake() {
    const R = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!R || S.wake) return;
    try {
      S.wake = new R();
      S.wake.lang = 'en-US';
      S.wake.continuous = true;
      S.wake.interimResults = true;
      S.wake.onresult = (e) => {
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const t = e.results[i][0].transcript.toLowerCase();
          if (/\blola\b/.test(t) && !S.engaged) { try { S.wake.stop(); } catch {} engage(); return; }
        }
      };
      S.wake.onend = () => { S.wake = null; if (!S.engaged) setTimeout(armWake, 500); };
      S.wake.onerror = () => { S.wake = null; };
      S.wake.start();
    } catch { S.wake = null; }
  }

  // ── Engage / disengage ───────────────────────────────────
  function engage() {
    if (S.engaged) return;
    S.engaged = true;
    S.stage.classList.add('expanded');
    S.overlay.classList.add('on');
    if (S.caption) S.caption.textContent = 'Listening…';
    if (S.transcript) { S.transcript.textContent = ''; S.transcript.classList.remove('show'); }
    armMic();
    S.recognition = startRecognition();
    S.onEngageHandlers.forEach(fn => { try { fn(); } catch {} });
  }
  function disengage() {
    if (!S.engaged) return;
    S.engaged = false;
    S.stage.classList.remove('expanded');
    S.overlay.classList.remove('on');
    if (S.transcript) S.transcript.classList.remove('show');
    if (S.recognition) { try { S.recognition.stop(); } catch {} S.recognition = null; }
    S.level = 0;
    S.onDisengageHandlers.forEach(fn => { try { fn(); } catch {} });
  }

  // ── Nudge bubble ─────────────────────────────────────────
  function nudge(text, ms) {
    if (!S.nudgeEl) return;
    S.nudgeEl.textContent = String(text || '');
    S.nudgeEl.hidden = false;
    if (S.nudgeTimer) clearTimeout(S.nudgeTimer);
    S.nudgeTimer = setTimeout(() => { S.nudgeEl.hidden = true; }, ms || 6000);
  }

  // ── Auto-mount when script loads if a container exists ──
  function autoMount() {
    if (document.querySelector('[data-lola-atom]')) {
      LolaCore.mount({ container: document.querySelector('[data-lola-atom]'), mode: 'inline' });
    } else if (!document.querySelector('.lola-core-atom')) {
      // Page didn't provide a container — auto-add corner atom on pages that opt in.
      if (document.body.getAttribute('data-lola-core') !== 'off') {
        LolaCore.mount({ mode: 'corner' });
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoMount);
  } else {
    autoMount();
  }

  global.LolaCore = LolaCore;
})(window);
