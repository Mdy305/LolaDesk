/* ============================================================
   LOLA RESONANCE — the dashboard atom, alive
   One atom that breathes, listens and speaks:
     • idle      → a slow breath
     • listening → ripples with the owner's real mic level
     • thinking  → a quick shimmer
     • speaking  → pulses with Lola's real voice (ElevenLabs via /api/speak-lola)
   It is one Lola: tapping the atom opens Lola Everywhere (same brain,
   memory and tools as the ⌘J panel), and her state anywhere on the page
   (lola:state events) drives the atom here.

   Also provides the API app.js and lola-voice-router.js call:
   LolaResonance.{toggle, ask, speak, cancel, toggleAmbient, enable, disable, state}
   ============================================================ */

(function () {
  'use strict';
  if (window.LolaResonance) return;                 // loaded twice → run once

  const stage = document.querySelector('.lola-orb-stage');
  if (!stage) return;
  document.body.setAttribute('data-lola-resonance', 'on');

  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const state = { mode: 'idle', micOn: false, speaking: false, ambient: false };
  const everywhere = () => window.LolaEverywhere;

  // -------- caption + transcript (kept from the stripped UX) --------
  const caption = document.createElement('div');
  caption.className = 'lola-resonance-caption';
  caption.textContent = 'Tap to speak — or press ⌘J';
  // The dashboard orb already says "Tap to speak or type a command" right
  // under Lola; a second, fixed caption at the bottom repeated it and sat
  // underneath the command dock (desktop) and the tab bar (phone).
  if (document.getElementById('orbSub')) caption.hidden = true;
  document.body.appendChild(caption);
  const transcript = document.createElement('div');
  transcript.className = 'lola-resonance-transcript';
  document.body.appendChild(transcript);
  let transcriptTimer = null;
  // Her words sit just above the command bar, centred on Lola's column.
  function placeTranscript() {
    const dock = document.getElementById('cmdInput');
    const box = dock && (dock.closest('form, .lola-command, .cmd-dock, .command-dock') || dock.parentElement);
    const r = box && box.getBoundingClientRect();
    if (r && r.width) {
      transcript.style.left = Math.round(r.left + r.width / 2) + 'px';
      transcript.style.bottom = Math.round(innerHeight - r.top + 14) + 'px';
    } else { transcript.style.left = ''; transcript.style.bottom = ''; }
  }
  addEventListener('resize', () => { if (transcript.classList.contains('show')) placeTranscript(); });
  function showTranscript(text, holdMs) {
    placeTranscript();
    transcript.textContent = text || '';
    transcript.classList.add('show');
    if (transcriptTimer) clearTimeout(transcriptTimer);
    if (holdMs) transcriptTimer = setTimeout(() => transcript.classList.remove('show'), holdMs);
  }
  function hideTranscript() { transcript.classList.remove('show'); }

  // -------- living state: hero labels + data-state --------
  function setMode(m) {
    if (!m || state.mode === m) return;
    state.mode = m;
    stage.setAttribute('data-state', m);
    caption.classList.toggle('speaking', m === 'speaking');
    try { const A = app(); if (A) A.setOrbState(m === 'idle' && state.ambient ? 'ambient' : m); } catch (_) {}
    if (m === 'listening') startMic(); else if (m === 'idle') stopMicSoon();
    wake();
  }
  addEventListener('lola:state', (e) => setMode(e.detail && e.detail.mode));
  addEventListener('lola:panel-close', () => { if (!state.speaking) setMode('idle'); });

  // -------- audio --------
  const AC = window.AudioContext || window.webkitAudioContext;
  let ctx = null;
  function audio() {
    if (!AC) return null;
    if (!ctx) { try { ctx = new AC(); } catch (_) { ctx = null; } }
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  let micLevel = 0, ttsLevel = 0, smoothed = 0;

  // Mic: only while Lola is listening, released a few seconds after — no
  // permanent red recording dot in the tab.
  let mic = null, micStop = null;
  async function startMic() {
    if (micStop) { clearTimeout(micStop); micStop = null; }
    if (mic || state.micOn || !navigator.mediaDevices) return;
    const c = audio(); if (!c) return;
    state.micOn = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const src = c.createMediaStreamSource(stream), an = c.createAnalyser();
      an.fftSize = 512; an.smoothingTimeConstant = 0.6; src.connect(an);
      mic = { stream, src, an, buf: new Uint8Array(an.fftSize) };
      wake();
    } catch (err) {
      state.micOn = false;
      console.warn('[lola-resonance] mic blocked or unavailable:', err && err.name);
    }
  }
  function stopMic() {
    micStop = null;
    if (mic) { try { mic.src.disconnect(); mic.stream.getTracks().forEach(t => t.stop()); } catch (_) {} }
    mic = null; state.micOn = false; micLevel = 0;
  }
  function stopMicSoon() { if (!micStop && mic) micStop = setTimeout(stopMic, 4000); }

  function rms(an, buf, gain) {
    an.getByteTimeDomainData(buf);
    let s = 0; for (let i = 0; i < buf.length; i++) { const n = (buf[i] - 128) / 128; s += n * n; }
    return Math.min(1, Math.sqrt(s / buf.length) * gain);
  }

  // -------- the atom's heartbeat: runs only while there's something to show --------
  let raf = 0, tts = null;
  function tick(now) {
    raf = 0;
    if (document.hidden) return;
    micLevel = mic ? rms(mic.an, mic.buf, 5) : 0;
    ttsLevel = tts ? rms(tts.an, tts.buf, 4.5) : 0;
    let raw = Math.max(micLevel, ttsLevel);
    if (state.mode === 'thinking') raw = Math.max(raw, 0.12 + 0.08 * Math.sin(now / 120));
    if (state.mode === 'speaking' && !tts) raw = Math.max(raw, 0.3 + 0.2 * Math.sin(now / 90)); // Lola speaking in the panel
    const breath = reduce ? 0 : 0.04 * (0.5 + 0.5 * Math.sin(now / 1400));
    smoothed += (Math.max(raw, breath) - smoothed) * 0.25;
    const body = window.__LOLA_ORB__;
    if (body && body.gpu) {
      // A million-particle Lola: her voice shapes the particles themselves.
      const src = tts || mic;
      let bands = null;
      if (src && window.LolaOrb && LolaOrb.bandsOf) { src.fbuf = src.fbuf || new Uint8Array(src.an.frequencyBinCount); src.an.getByteFrequencyData(src.fbuf); bands = LolaOrb.bandsOf(src.fbuf); }
      body.feed(raw, bands);
      stage.style.transform = `scale(${(1 + smoothed * 0.035).toFixed(3)})`;
      stage.style.filter = '';
    } else {
      stage.style.transform = `scale(${(1 + smoothed * 0.18).toFixed(3)})`;
      stage.style.filter = `drop-shadow(0 0 ${(20 + smoothed * 90).toFixed(1)}px rgba(204,255,0,${(0.25 + smoothed * 0.65).toFixed(2)}))`;
    }
    const active = mic || tts || state.mode !== 'idle' || smoothed > 0.05;
    // At rest, breathe at a gentle ~20fps instead of burning every frame.
    if (active) raf = requestAnimationFrame(tick);
    else if (!reduce) setTimeout(() => { if (!raf) raf = requestAnimationFrame(tick); }, 50);
  }
  function wake() { if (!raf && !document.hidden) raf = requestAnimationFrame(tick); }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); });
  wake();

  // -------- Lola's voice --------
  let speakSeq = 0;
  async function speak(text) {
    const clean = String(text || '').replace(/\*([^*]+)\*/g, '$1').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, 1200);
    if (!clean) return;
    cancel();
    const my = ++speakSeq;
    // Her words stay readable at the atom — voice or no voice.
    showTranscript(clean.length > 280 ? clean.slice(0, 277) + '…' : clean, 0);
    try {
      let tok = ''; try { tok = localStorage.getItem('loladesk_token') || ''; } catch (_) {}
      // Signed-in owners speak freely (anonymous voice is capped per hour).
      const r = await fetch('/api/speak-lola', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, tok ? { Authorization: 'Bearer ' + tok } : {}), body: JSON.stringify({ text: clean }) });
      if (!r.ok) throw new Error('voice ' + r.status);
      const bytes = await r.arrayBuffer();
      if (my !== speakSeq) return;                       // interrupted while loading
      const c = audio(); if (!c) throw new Error('no audio');
      const buf = await c.decodeAudioData(bytes.slice(0));
      if (my !== speakSeq) return;
      const src = c.createBufferSource(), an = c.createAnalyser();
      src.buffer = buf; an.fftSize = 512; an.smoothingTimeConstant = 0.5;
      src.connect(an); an.connect(c.destination);
      tts = { src, an, buf: new Uint8Array(an.fftSize) };
      state.speaking = true; setMode('speaking');
      await new Promise((done) => { src.onended = done; src.start(0); });
    } catch (err) {
      console.warn('[lola-resonance] voice unavailable:', err && err.message);
      // Never silently mute her: say it where you're looking, and pulse her body so she still "speaks".
      try { const B = window.__LOLA_ORB__; if (B && B.voice) B.voice('lola', Math.min(6, 1 + clean.length / 18)); } catch (_) {}
      if (!document.querySelector('.lola-voice-off')) { const n = document.createElement('div'); n.className = 'lola-voice-off'; n.textContent = 'My voice is off right now — say “Lola, run a check”.'; n.style.cssText = 'position:fixed;left:50%;bottom:10px;transform:translateX(-50%);z-index:61;font:500 11.5px -apple-system,sans-serif;color:#ffb340;opacity:.85;pointer-events:none'; document.body.appendChild(n); setTimeout(() => n.remove(), 6000); }
    } finally {
      if (my === speakSeq) { finishSpeaking(); showTranscript(transcript.textContent, 7000); }
    }
  }
  function finishSpeaking() {
    if (tts) { try { tts.src.disconnect(); tts.an.disconnect(); } catch (_) {} }
    tts = null; state.speaking = false; ttsLevel = 0;
    if (state.mode === 'speaking' || state.mode === 'thinking') setMode('idle');
  }
  function cancel() {
    speakSeq++;
    if (tts || state.speaking) {
      if (tts) { try { tts.src.stop(); } catch (_) {} }
      finishSpeaking();
    }
  }

  // -------- follow the dashboard's own conversation (app.js) --------
  // app.js announces its hero state (lola:app-state); mirror it so the atom
  // breathes, listens and settles with her — and the mic is released after.
  const app = () => window.__lolaApp || null;
  function fromApp(s) {
    const m = s === 'ambient' ? 'idle' : s;
    if (!['idle', 'listening', 'thinking', 'speaking'].includes(m) || state.mode === m) return;
    if (m !== 'speaking' && state.speaking) return;           // our voice owns 'speaking'
    state.mode = m; stage.setAttribute('data-state', m);
    caption.classList.toggle('speaking', m === 'speaking');
    if (m === 'listening') startMic(); else if (m === 'idle') stopMicSoon();
    wake();
  }
  addEventListener('lola:app-state', (e) => fromApp(e.detail && e.detail.mode));

  // -------- one Lola --------
  // Pages with the Lola Everywhere panel open it; the dashboard (which has its
  // own conversation surface) runs app.js's listen → brain → voice loop.
  const panelMounted = () => !!document.querySelector('.lp-root');
  function toggle() {
    audio();
    if (state.speaking) { cancel(); return; }
    // Telnyx live conversation (the same assistant that answers the phone) when it's configured.
    const V = window.LolaVoice, R = window.LolaVoiceRouter;
    if (V && R && R.primary()) {
      if (V.state && V.state.streaming) { try { V.stop(); } catch (_) {} setMode('idle'); return; }
      setMode('listening');
      Promise.resolve(V.begin()).then((ok) => { if (!ok) { setMode('idle'); fallbackListen(); } }).catch(() => { setMode('idle'); fallbackListen(); });
      return;
    }
    fallbackListen();
  }
  function fallbackListen() {
    const L = everywhere();
    if (L && L.listen && panelMounted()) { L.listen(); setMode('listening'); return; }
    const A = app();
    if (A) {
      if (A.isListening()) { try { A.stopListening(); } catch (_) {} }
      else { try { A.startListening(); } catch (_) { setMode('idle'); } }
      return;
    }
    if (state.micOn) { stopMic(); setMode('idle'); } else { setMode('listening'); }
  }
  function ask(prompt) {
    const L = everywhere();
    if (L && L.ask && panelMounted()) { L.ask(prompt); return; }
    const A = app();
    if (A) { A.ask(prompt); return; }
    if (typeof window.openChat === 'function') window.openChat();
  }

  // -------- "say Lola" (opt-in; the router turns it off when phone voice owns the mic) --------
  const KEY = 'loladesk_resonance';
  let rec = null;
  function armWake() {
    const R = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!R || rec || !state.ambient || document.hidden || state.mode !== 'idle') return;
    try {
      rec = new R(); rec.lang = 'en-US'; rec.continuous = true; rec.interimResults = true;
      rec.onresult = (e) => {
        for (let i = e.resultIndex; i < e.results.length; i++) {
          if (/\blola\b/i.test(e.results[i][0].transcript)) { disarmWake(); toggle(); return; }
        }
      };
      rec.onend = () => { rec = null; setTimeout(armWake, 900); };
      rec.onerror = (e) => { const blocked = e && /not-allowed|service-not-allowed/.test(e.error); rec = null; if (blocked) { state.ambient = false; } };
      rec.start();
    } catch (_) { rec = null; }
  }
  function disarmWake() { const r = rec; rec = null; if (r) { try { r.onend = null; r.stop(); } catch (_) {} } }
  function enable() { state.ambient = true; try { localStorage.setItem(KEY, 'on'); } catch (_) {} armWake(); if (state.mode === 'idle') try { app() && app().setOrbState('ambient'); } catch (_) {} return true; }
  function disable() { state.ambient = false; try { localStorage.setItem(KEY, 'off'); } catch (_) {} disarmWake(); if (state.mode === 'idle') try { app() && app().setOrbState('idle'); } catch (_) {} return false; }
  function toggleAmbient() { return state.ambient ? disable() : enable(); }
  addEventListener('lola:state', (e) => { const m = e.detail && e.detail.mode; if (m && m !== 'idle') disarmWake(); else setTimeout(armWake, 1200); });
  try { if (localStorage.getItem(KEY) === 'on') document.addEventListener('click', enable, { once: true }); } catch (_) {}

  // -------- affordances --------
  // The atom's own onclick="toggleVoice()" routes here (app.js → LolaResonance.toggle).
  stage.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });

  window.LolaResonance = {
    toggle, ask, speak, cancel, toggleAmbient, enable, disable, state,
    showTranscript, hideTranscript,
    setMicLevel(v) { micLevel = Math.max(0, Math.min(1, +v || 0)); wake(); },
    setTtsLevel(v) { ttsLevel = Math.max(0, Math.min(1, +v || 0)); wake(); },
  };
})();
