/* ============================================================
   LOLA RESONANCE — audio-reactive atom
   Drives .lola-orb-stage scale + glow from BOTH:
     • user's mic (incoming voice)
     • Lola's TTS playback (outgoing voice)
   Result: one atom that breathes, listens, and speaks.
   ============================================================ */

(function () {
  'use strict';

  // Only run on pages that host the atom
  const stage = document.querySelector('.lola-orb-stage');
  if (!stage) return;

  // Flag body so the CSS applies
  document.body.setAttribute('data-lola-resonance', 'on');

  // -------- Small live caption + transcript --------
  const caption = document.createElement('div');
  caption.className = 'lola-resonance-caption';
  caption.textContent = 'Tap to speak — or say "Lola"';
  document.body.appendChild(caption);

  const transcript = document.createElement('div');
  transcript.className = 'lola-resonance-transcript';
  document.body.appendChild(transcript);

  let transcriptTimer = null;
  function showTranscript(text, holdMs) {
    transcript.textContent = text || '';
    transcript.classList.add('show');
    if (transcriptTimer) clearTimeout(transcriptTimer);
    if (holdMs) transcriptTimer = setTimeout(() => transcript.classList.remove('show'), holdMs);
  }
  function hideTranscript() {
    transcript.classList.remove('show');
  }

  // -------- Shared AudioContext --------
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) {
    console.warn('[lola-resonance] Web Audio API unavailable');
    return;
  }
  const ctx = new AC();
  // Some browsers require a user gesture to resume
  function resumeCtx() { if (ctx.state === 'suspended') ctx.resume().catch(() => {}); }
  document.addEventListener('click', resumeCtx, { once: false, passive: true });
  document.addEventListener('touchstart', resumeCtx, { once: false, passive: true });

  // -------- Amplitude drivers --------
  let micLevel = 0;   // 0..1
  let ttsLevel = 0;   // 0..1

  // Smoothed level used to animate the atom
  let smoothed = 0;

  function tick() {
    // Combined amplitude — TTS wins when Lola speaks, mic when user does
    const raw = Math.max(micLevel, ttsLevel);
    // Ease toward raw for a natural pulse
    smoothed += (raw - smoothed) * 0.25;

    const scale = 1 + smoothed * 0.18;
    const glow = 20 + smoothed * 90;
    const glowAlpha = 0.25 + smoothed * 0.65;

    stage.style.transform = `scale(${scale.toFixed(3)})`;
    stage.style.filter = `drop-shadow(0 0 ${glow.toFixed(1)}px rgba(204,255,0,${glowAlpha.toFixed(2)}))`;

    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  // -------- Mic tap (starts on first user gesture) --------
  let micStarted = false;
  async function startMic() {
    if (micStarted) return;
    micStarted = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      an.smoothingTimeConstant = 0.6;
      src.connect(an);
      const buf = new Uint8Array(an.frequencyBinCount);

      (function readMic() {
        an.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const n = (buf[i] - 128) / 128;
          sum += n * n;
        }
        // rms scaled a bit — voice sits around 0.02-0.15 rms
        micLevel = Math.min(1, Math.sqrt(sum / buf.length) * 5);
        requestAnimationFrame(readMic);
      })();
    } catch (err) {
      console.warn('[lola-resonance] mic blocked or unavailable:', err && err.name);
      micStarted = false;
    }
  }

  // Wire the atom stage as the mic-arm affordance
  stage.addEventListener('click', () => {
    resumeCtx();
    startMic();
  }, { passive: true });

  // Also arm mic on wake-word or key press
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space') { resumeCtx(); startMic(); }
  });

  // -------- TTS tap: wrap fetch() + <audio> so Lola's voice drives the atom --------
  // The dashboard already calls /api/speak-lola?text=... — we intercept the returned
  // audio blob, decode it, play it through our AudioContext, and read the analyser.

  // 1) Monkey-patch fetch so we can catch /api/speak-lola responses
  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const res = await origFetch.apply(this, arguments);
    try {
      if (/\/api\/speak-lola/.test(url) || /\/api\/tts/.test(url)) {
        // Clone so the caller still gets the body untouched
        const clone = res.clone();
        const buf = await clone.arrayBuffer();
        // Fire-and-forget playback through analyser
        playTTS(buf).catch(() => {});
        // Return a synthetic empty response so the caller doesn't ALSO play it
        return new Response(new Blob([], { type: 'audio/mpeg' }), {
          status: res.status,
          statusText: res.statusText,
          headers: res.headers
        });
      }
    } catch (_) { /* swallow */ }
    return res;
  };

  async function playTTS(arrayBuffer) {
    resumeCtx();
    try {
      const audioBuf = await ctx.decodeAudioData(arrayBuffer.slice(0));
      const src = ctx.createBufferSource();
      src.buffer = audioBuf;
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      an.smoothingTimeConstant = 0.5;
      src.connect(an);
      an.connect(ctx.destination);

      caption.classList.add('speaking');
      hideTranscript();

      const buf = new Uint8Array(an.frequencyBinCount);
      let running = true;
      src.onended = () => {
        running = false;
        ttsLevel = 0;
        caption.classList.remove('speaking');
      };
      src.start(0);

      (function readTTS() {
        if (!running) return;
        an.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const n = (buf[i] - 128) / 128;
          sum += n * n;
        }
        ttsLevel = Math.min(1, Math.sqrt(sum / buf.length) * 4.5);
        requestAnimationFrame(readTTS);
      })();
    } catch (err) {
      console.warn('[lola-resonance] tts decode failed:', err && err.message);
    }
  }

  // -------- Optional transcript hook --------
  // Existing dashboard code can call these to show partial/final transcripts.
  window.LolaResonance = {
    showTranscript,
    hideTranscript,
    setMicLevel(v) { micLevel = Math.max(0, Math.min(1, +v || 0)); },
    setTtsLevel(v) { ttsLevel = Math.max(0, Math.min(1, +v || 0)); },
  };

  console.info('[lola-resonance] ready — atom will resonate with mic + Lola TTS');
})();
