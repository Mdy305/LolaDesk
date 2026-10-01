/**
 * lola-ears.js — Lola hears you. Every page, every browser.
 * ════════════════════════════════════════════════════════════════
 * The browser's built-in speech recognition fails silently far too often
 * (blocked mic, "network" errors, Firefox, in-app browsers). So Lola listens
 * with her own ears:
 *   • the microphone is recorded while you talk; she knows when you start
 *     and when you stop (no button to hold, stops ~1s after you finish);
 *   • the recording is transcribed by Telnyx (/api/lola/hear);
 *   • if the browser's recognizer also heard you, its words come back
 *     instantly and the upload is skipped;
 *   • every failure is said out loud in plain words — never silence.
 *
 *   LolaEars.listen({ onInterim(text), onLevel(0..1), onStart() }) → Promise<{ text, error, say }>
 *   LolaEars.stop()    — finish now and transcribe what was said
 *   LolaEars.cancel()  — drop it
 *   LolaEars.busy
 */
(function () {
  'use strict';
  if (window.LolaEars) return;

  const SAY = {
    mic_blocked: 'I can’t hear you — the microphone is blocked for this site. Click the icon left of the address bar, set Microphone to Allow, then tap me again.',
    no_mic: 'I can’t find a microphone on this device. You can type to me instead.',
    no_speech: 'I didn’t catch anything. Tap me and talk — I’m listening.',
    hear_failed: 'I couldn’t make that out. Say it again, or type it.',
    unsupported: 'This browser won’t share the microphone with me. Type to me, or open LolaDesk in Chrome or Safari.',
    insecure: 'Voice needs the secure site. Open https://www.loladesk.com.',
  };
  let current = null;

  function token() { try { return localStorage.getItem('loladesk_token') || ''; } catch (_) { return ''; } }
  function pickMime() {
    const M = window.MediaRecorder; if (!M || !M.isTypeSupported) return '';
    for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']) if (M.isTypeSupported(t)) return t;
    return '';
  }
  function toBase64(blob) {
    return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = rej; r.readAsDataURL(blob); });
  }
  async function transcribe(blob, mime) {
    const audio = await toBase64(blob);
    const t = token();
    const r = await fetch('/api/lola/hear', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, t ? { Authorization: 'Bearer ' + t } : {}), body: JSON.stringify({ audio, mime }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) throw new Error(d.error || ('hear ' + r.status));
    return String(d.text || '').trim();
  }

  function listen(opts) {
    opts = opts || {};
    if (current) { current.finish(); return current.promise; }
    if (!window.isSecureContext) return Promise.resolve({ text: '', error: 'insecure', say: SAY.insecure });
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
      return Promise.resolve({ text: '', error: 'unsupported', say: SAY.unsupported });
    }
    let resolveFn; const promise = new Promise((r) => { resolveFn = r; });
    const job = { promise, finish: () => {}, cancel: () => {} };
    current = job; LolaEars.busy = true;
    const done = (out) => { if (current === job) { current = null; LolaEars.busy = false; } resolveFn(out); };

    (async () => {
      let stream;
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
      catch (e) {
        const n = e && e.name;
        const err = (n === 'NotAllowedError' || n === 'SecurityError') ? 'mic_blocked' : (n === 'NotFoundError' || n === 'OverconstrainedError') ? 'no_mic' : 'mic_blocked';
        return done({ text: '', error: err, say: SAY[err] });
      }
      const mime = pickMime();
      let rec;
      try { rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); }
      catch (_) { stream.getTracks().forEach((t) => t.stop()); return done({ text: '', error: 'unsupported', say: SAY.unsupported }); }
      const chunks = []; rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

      // The browser's recognizer, in parallel, for instant words when it works.
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      let sr = null, srFinal = '', srInterim = '';
      if (SR) {
        try {
          sr = new SR(); sr.lang = opts.lang || 'en-US'; sr.interimResults = true; sr.continuous = true;
          sr.onresult = (e) => { let i2 = ''; for (let i = e.resultIndex; i < e.results.length; i++) { const t = e.results[i][0].transcript; if (e.results[i].isFinal) srFinal += t; else i2 += t; } srInterim = i2; opts.onInterim && opts.onInterim((srFinal + ' ' + i2).trim()); };
          sr.onerror = () => {}; sr.onend = () => { sr = null; };
          sr.start();
        } catch (_) { sr = null; }
      }

      // Hearing when you start and stop.
      let ctx = null, an = null, buf = null, raf = 0;
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        ctx = new AC(); if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        an = ctx.createAnalyser(); an.fftSize = 1024; buf = new Float32Array(an.fftSize);
        ctx.createMediaStreamSource(stream).connect(an);
      } catch (_) { an = null; }
      const t0 = performance.now(); let floor = 0.008, spoke = false, lastLoud = 0, finished = false, cancelled = false;
      const MAX = opts.maxMs || 15000, WAIT = opts.waitMs || 7000, TAIL = opts.tailMs || 1100;

      function level() {
        if (!an) return 0;
        an.getFloatTimeDomainData(buf); let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
        return Math.sqrt(s / buf.length);
      }
      function loop() {
        if (finished) return;
        const now = performance.now(), v = level(), el = now - t0;
        if (el < 350) floor = Math.max(floor, v * 0.9);
        const loud = v > Math.max(0.018, floor * 2.6);
        if (loud) { spoke = true; lastLoud = now; }
        opts.onLevel && opts.onLevel(Math.min(1, v * 8));
        if (spoke && now - lastLoud > TAIL) return finish();
        if (!spoke && !srInterim && !srFinal && el > WAIT) return finish();
        if (el > MAX) return finish();
        raf = requestAnimationFrame(loop);
      }

      function cleanup() {
        cancelAnimationFrame(raf);
        try { sr && sr.stop(); } catch (_) {}
        try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
        try { ctx && ctx.close(); } catch (_) {}
      }
      function finish() {
        if (finished) return; finished = true;
        rec.onstop = async () => {
          cleanup();
          if (cancelled) return done({ text: '', error: 'cancelled' });
          const quick = srFinal.trim(), partial = srInterim.trim();
          if (quick) return done({ text: (quick + (partial ? ' ' + partial : '')).trim() });
          if (!spoke && !partial && an) return done({ text: '', error: 'no_speech', say: SAY.no_speech });
          const blob = new Blob(chunks, { type: (rec.mimeType || mime || 'audio/webm').split(';')[0] });
          if (blob.size < 1200) return done(partial ? { text: partial } : { text: '', error: 'no_speech', say: SAY.no_speech });
          opts.onThinking && opts.onThinking();
          try {
            const text = await transcribe(blob, blob.type);
            done(text ? { text } : partial ? { text: partial } : { text: '', error: 'no_speech', say: SAY.no_speech });
          } catch (_) { done(partial ? { text: partial } : { text: '', error: 'hear_failed', say: SAY.hear_failed }); }
        };
        try { rec.state !== 'inactive' ? rec.stop() : rec.onstop(); } catch (_) { rec.onstop(); }
      }
      job.finish = finish;
      job.cancel = () => { cancelled = true; finish(); };
      rec.start(250);
      opts.onStart && opts.onStart();
      raf = requestAnimationFrame(loop);
      // rAF pauses in background tabs — keep the clock honest.
      const guard = setInterval(() => { if (finished) return clearInterval(guard); if (performance.now() - t0 > MAX + 500) { clearInterval(guard); finish(); } }, 1000);
    })();
    return promise;
  }

  const LolaEars = {
    busy: false,
    supported: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder),
    listen,
    stop() { current && current.finish(); },
    cancel() { current && current.cancel(); },
    SAY,
  };
  window.LolaEars = LolaEars;
})();
