/* LolaDesk Resonance Runtime — wake, converse, remember, interrupt.
   ════════════════════════════════════════════════════════════════
   ONE Lola, ONE voice, everywhere. This is the universal voice
   control for the app — the "Jarvis" layer. She:

     1. HEARS   — browser SpeechRecognition, two modes:
                 · tap-to-talk (orb / mic / ⌘Space)
                 · ambient wake-word ("…Lola …") armed on boot
     2. THINKS  — /api/lola (the same brain that runs phone calls)
                 with an instant deterministic fallback so she ALWAYS
                 answers, even if the network brain hiccups.
     3. SPEAKS  — ONLY her canonical ElevenLabs voice via
                 /api/speak-lola. Never a browser-TTS substitute.
                 Every syllable drives the orb and the micro
                 particle field live (amplitude → canvas + CSS).

   She is the centerpiece: on wake the particle field rushes in
   (LolaWakeBurst), while listening it leans in and ripples with the
   owner's voice, while speaking it radiates her real audio
   amplitude, and she never dies silently — a reply always renders.

   API:
     LolaResonance.enable / disable / ask(text) / toggle() /
                  toggleAmbient() / speak(text) / cancel(reason)
     Also installs window.askLola, window.toggleVoice,
     window.toggleAmbientListening, window.speak so every page's
     inline onclicks route here (app.js delegates when present).
   ═══════════════════════════════════════════════════════════════ */
(function () {
  if (window.LolaResonance) return;

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const ORB_SELECTOR = '.lola-orb, .lola-orb-stage, #orbStage, .orb, #lolaOrb, [data-lola-orb], [data-lola-voice]';

  const state = {
    enabled: false, awake: false, listening: false, speaking: false, busy: false,
    recognition: null, restartTimer: null, messages: [], lastWakeAt: 0,
    ownerName: 'there', mode: 'idle', turnId: 0, controller: null,
    startedAt: 0, transcript: '', interim: '', lastError: null,
    audio: null, audioUrl: null, audioContext: null, analyser: null,
    amplitudeFrame: null, sourceNode: null, ambientOn: false, pendingArm: false
  };

  const STORAGE_KEY = 'loladesk_resonance';
  const LABELS = {
    idle:      ['Hey Lola…', 'Tap to speak or type a command'],
    waking:    ['Starting Lola…', 'Waking her up'],
    ambient:   ['Hey Lola…', 'Listening for her name — just say it'],
    listening: ['Listening…', 'Speak now, I’m all ears'],
    thinking:  ['Thinking…', 'Working on it'],
    speaking:  ['Lola', 'Speaking…'],
    degraded:  ['Lola', 'Voice needs attention — tap to retry'],
    error:     ['Lola', 'Tap Lola to start again']
  };

  function token() { try { return localStorage.getItem('loladesk_token') || ''; } catch (e) { return ''; } }
  function now() { return Math.round(performance.now()); }
  function emit(name, detail) { window.dispatchEvent(new CustomEvent(name, { detail })); }

  function orbEl() { return document.querySelector(ORB_SELECTOR); }
  function lolaOrb() { return window.__LOLA_ORB__ || null; }
  function mapState(mode) {
    // LolaOrb canvas states: idle | ambient | listening | thinking | speaking
    if (mode === 'waking') return 'ambient';
    if (mode === 'degraded' || mode === 'error') return 'idle';
    return mode;
  }

  function setOrb(mode, detail = {}) {
    state.mode = mode;
    document.body.dataset.lolaState = mode;
    emit('lola:state', { mode, ...detail });

    const orb = orbEl();
    if (orb) { orb.dataset.state = mode; orb.setAttribute('aria-label', 'Lola is ' + mode); }
    const canvasOrb = lolaOrb();
    if (canvasOrb) { try { canvasOrb.setState(mapState(mode)); } catch (e) {} }

    const [title, sub] = LABELS[mode] || LABELS.idle;
    const tEl = document.getElementById('orbTitle');
    const sEl = document.getElementById('orbSub');
    if (tEl && !(mode === 'speaking' && state.transcript)) tEl.textContent = title;
    if (sEl) sEl.textContent = detail.label || sub;

    const mic = document.getElementById('orbMic');
    if (mic) mic.classList.toggle('on', mode === 'listening');

    const wave = document.getElementById('orbWave');
    if (wave) wave.style.display = (mode === 'listening' || mode === 'speaking') ? 'flex' : 'none';

    const ambientBtn = document.getElementById('ambientToggle');
    if (ambientBtn) {
      ambientBtn.classList.toggle('on', state.ambientOn);
      ambientBtn.setAttribute('aria-pressed', state.ambientOn ? 'true' : 'false');
      const ambientLabel = document.getElementById('ambientToggleLabel');
      if (ambientLabel) ambientLabel.textContent = state.ambientOn ? 'Listening for “Lola”…' : 'Always listening for “Lola”';
    }
  }

  function setTranscript(finalText = '', interim = '') {
    state.transcript = finalText; state.interim = interim;
    const el = document.getElementById('orbTranscript');
    if (el) el.textContent = (finalText || interim || '').trim();
    emit('lola:transcript', { final: finalText, interim });
  }

  function setAmplitude(value) {
    document.documentElement.style.setProperty('--lola-amplitude', String(Math.max(0, Math.min(1, value || 0))));
    const canvasOrb = lolaOrb();
    if (canvasOrb) { try { canvasOrb.setLevel(Math.max(0, Math.min(1, value || 0))); } catch (e) {} }
    emit('lola:amplitude', { value: value || 0, turnId: state.turnId });
  }

  function toast(text) {
    let el = document.getElementById('lolaResonanceToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'lolaResonanceToast';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      el.style.cssText = 'position:fixed;left:50%;bottom:94px;transform:translateX(-50%);z-index:99999;max-width:min(680px,88vw);padding:12px 16px;border:1px solid rgba(204,255,0,.24);border-radius:14px;background:rgba(8,8,10,.94);backdrop-filter:blur(18px);color:#f4f4f5;font:500 13px/1.45 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.35);opacity:0;transition:.2s';
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.style.opacity = '1';
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.style.opacity = '0'; }, 4600);
  }

  function cleanText(value) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(x => x && (x.text || x.content || '')).join(' ').trim();
    return value && (value.text || value.content) ? String(value.text || value.content) : '';
  }
  function cleanSpeechText(text) {
    return String(text || '').replace(/https?:\/\/\S+/g, '').replace(/[*_#`>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2400);
  }

  /* ── local deterministic brain (instant fallback, zero cost) ──
     Mirrors api/lola-brain.js's skill matcher so Lola ALWAYS answers
     even when the network brain is unreachable. */
  function localReply(text) {
    const t = String(text || '').toLowerCase().trim();
    if (!t) return "I'm listening. What would you like — an appointment, our prices, or our hours?";
    if (/^(hi|hello|hey|lola|yo|good (morning|afternoon|evening))\b/.test(t))
      return "Hi, I'm Lola — the front desk that never sleeps. I can book an appointment, check prices, or tell you our hours. What do you need?";
    if (/\b(who|what) are you\b/.test(t) || /\bare you (real|a robot|ai|human)\b/.test(t))
      return "I'm Lola, the AI concierge behind LolaDesk. I answer every call, book every client, and never miss a booking.";
    if (/\b(book|schedule|reschedule|appointment)\b/.test(t))
      return "I'd love to get you booked. What service would you like, and what day works best?";
    if (/\b(price|pricing|cost|how much|menu|services?|offer)\b/.test(t))
      return "Tell me which service you're curious about and I'll give you the exact price and time.";
    if (/\b(hours?|open|close|when are you|location|address|where are you)\b/.test(t))
      return "I can pull up our exact hours and location — want me to check the calendar for an opening too?";
    if (/\b(thanks|thank you|cheers)\b/.test(t))
      return "Anytime — I'm here around the clock. Is there anything else I can do for you?";
    if (/\b(bye|goodbye|see you|that's all)\b/.test(t))
      return "Goodbye! Call or text anytime — I never miss you.";
    return "I can help you book an appointment, check our prices, or tell you our hours. What would you like?";
  }

  /* ── audio plumbing ── */
  function stopAmplitude() {
    if (state.amplitudeFrame) cancelAnimationFrame(state.amplitudeFrame);
    state.amplitudeFrame = null;
    setAmplitude(0);
  }
  function releaseAudio() {
    stopAmplitude();
    if (state.audio) {
      try { state.audio.pause(); state.audio.removeAttribute('src'); state.audio.load(); } catch (e) {}
      state.audio = null;
    }
    if (state.audioUrl) { try { URL.revokeObjectURL(state.audioUrl); } catch (e) {} state.audioUrl = null; }
    state.sourceNode = null; state.analyser = null;
  }
  function cancelActive(reason = 'interrupted') {
    state.turnId++;
    try { state.controller && state.controller.abort(reason); } catch (e) {}
    state.controller = null;
    releaseAudio();
    try { speechSynthesis.cancel(); } catch (e) {}
    state.speaking = false; state.busy = false;
    emit('lola:cancel', { reason, turnId: state.turnId });
  }

  async function startAmplitude(audio, turnId) {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      state.audioContext = state.audioContext || new AC();
      if (state.audioContext.state === 'suspended') await state.audioContext.resume();
      const source = state.audioContext.createMediaElementSource(audio);
      const analyser = state.audioContext.createAnalyser();
      analyser.fftSize = 256; analyser.smoothingTimeConstant = .72;
      source.connect(analyser); analyser.connect(state.audioContext.destination);
      state.sourceNode = source; state.analyser = analyser;
      const data = new Uint8Array(analyser.frequencyBinCount);
      const draw = () => {
        if (turnId !== state.turnId || !state.speaking || state.audio !== audio) return stopAmplitude();
        analyser.getByteFrequencyData(data);
        let sum = 0; for (const value of data) sum += value;
        setAmplitude(Math.min(1, (sum / data.length) / 110));
        state.amplitudeFrame = requestAnimationFrame(draw);
      };
      draw();
    } catch (error) {
      metric('audio_analyser_error', 0, { error: String(error && error.message || error) });
    }
  }

  /* ── SPEAK: Lola's canonical ElevenLabs voice ONLY ──
     If her voice can't be produced, she stays silent but her reply
     still renders — a silent Lola is honest, a fake voice is not her. */
  async function speak(text, turnId) {
    text = cleanSpeechText(text);
    if (!text || turnId !== state.turnId) return;
    state.speaking = true;
    setOrb('speaking', { label: 'Speaking…' });
    try {
      const response = await fetch('/api/speak-lola', {
        method: 'POST',
        signal: state.controller && state.controller.signal,
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token() },
        body: JSON.stringify({ text, voiceType: 'lola' })
      });
      if (turnId !== state.turnId) return;
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        throw new Error(detail.error || ('Voice ' + response.status));
      }
      const blob = await response.blob();
      if (turnId !== state.turnId) return;
      if (!blob.size) throw new Error('Voice returned empty audio');
      state.audioUrl = URL.createObjectURL(blob);
      const audio = new Audio(state.audioUrl);
      state.audio = audio; audio.preload = 'auto'; audio.playsInline = true;
      await startAmplitude(audio, turnId);
      await new Promise((resolve, reject) => {
        audio.onplaying = () => metric('time_to_first_audio', now() - state.startedAt, { provider: 'elevenlabs' });
        audio.onended = resolve;
        audio.onerror = () => reject(new Error('Audio playback failed'));
        const play = audio.play();
        if (play && play.catch) play.catch(reject);
      });
    } catch (error) {
      if (error && (error.name === 'AbortError' || turnId !== state.turnId)) return;
      metric('voice_provider_error', 0, { provider: 'elevenlabs', error: String(error && error.message || error) });
      // ONE LOLA, ONE VOICE: no browser-TTS substitute — text already shows.
      setOrb('degraded', { label: 'Voice unavailable — reply shown below' });
    } finally {
      if (turnId !== state.turnId) return;
      releaseAudio();
      state.speaking = false;
      state.awake = true;
      setOrb(state.ambientOn ? 'ambient' : 'idle', { label: state.ambientOn ? 'Listening for “Lola”…' : 'Tap to speak or type a command' });
      scheduleRestart(180);
    }
  }

  /* ── THINK: the same brain as phone calls, with a live fallback ── */
  async function askLola(text) {
    text = String(text || '').trim();
    if (!text) return;
    cancelActive('new-turn');
    const turnId = state.turnId;
    state.busy = true;
    state.startedAt = now();
    state.controller = new AbortController();
    setOrb('thinking', { label: 'Lola is thinking' });
    toast('Lola heard: “' + text + '”');
    metric('time_to_visible_feedback', now() - state.startedAt);
    state.messages.push({ role: 'user', content: text });
    state.messages = state.messages.slice(-24);

    // Show what she heard inline (voice-first: no modal required).
    const tEl = document.getElementById('orbTitle');
    if (tEl) tEl.textContent = '“' + text + '”';
    const chatOpen = (() => { const c = document.getElementById('chatOverlay'); return c && c.classList.contains('show'); })();
    if (chatOpen && window.addChatMsg) { try { window.addChatMsg('user', text); } catch (e) {} }

    let reply = '';
    try {
      const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token() };
      const tenantSlug = (function () {
        try { const s = sessionStorage.getItem('loladesk_tenant'); if (s) { const t = JSON.parse(s); return t.slug || t.id || ''; } } catch (e) {}
        return '';
      })();
      if (tenantSlug) headers['x-tenant-id'] = tenantSlug;
      const response = await fetch('/api/lola', {
        method: 'POST',
        signal: state.controller && state.controller.signal,
        headers,
        body: JSON.stringify({
          system: systemPrompt(),
          messages: state.messages,
          channel: 'dashboard_voice',
          assistant: 'LolaBrain',
          turnId
        })
      });
      metric('time_to_response_headers', now() - state.startedAt, { status: response.status });
      const data = await response.json().catch(() => ({}));
      if (turnId !== state.turnId) return;
      if (!response.ok) throw new Error(data.error || ('Lola ' + response.status));
      reply = cleanText(data.content || data.reply || data.message);
      if (!reply) throw new Error('Lola returned an empty response');
    } catch (error) {
      if (error && (error.name === 'AbortError' || turnId !== state.turnId)) return;
      metric('brain_fallback', 0, { error: String(error && error.message || error) });
      reply = localReply(text); // ALWAYS answer — instant, zero cost
    }

    state.messages.push({ role: 'assistant', content: reply });
    state.messages = state.messages.slice(-24);
    setTranscript(reply);
    if (chatOpen && window.addChatMsg) { try { window.addChatMsg('ai', reply); } catch (e) {} }
    toast(reply);
    state.busy = false;
    await speak(reply, turnId);
    if (turnId === state.turnId) metric('turn_complete', now() - state.startedAt, { ok: true });
  }

  function systemPrompt() {
    return `You are Lola, a permanent senior team member inside LolaDesk, powered by LolaBrain. Speak naturally, warmly and decisively. Address the owner as ${state.ownerName}. Be concise in voice, take real actions only when tools confirm success, preserve context, and never claim completion when a downstream action failed. Never call yourself a chatbot.`;
  }

  /* ── HEAR ── */
  function commandFrom(transcript) {
    const match = transcript.match(/(?:hey|hi|okay|ok)?\s*lola[\s,.:;-]*(.*)$/i);
    return match ? match[1].trim() : '';
  }
  function scheduleRestart(delay = 250) {
    clearTimeout(state.restartTimer);
    if (!state.enabled || !state.recognition || state.busy || state.speaking) return;
    state.restartTimer = setTimeout(() => { try { state.recognition.start(); } catch (e) {} }, delay);
  }
  function initRecognition() {
    if (!SpeechRecognition) return false;
    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';
    recognition.onstart = () => {
      state.listening = true;
      setOrb(state.awake ? 'listening' : 'ambient', { label: state.awake ? 'I’m listening' : 'Listening for “Lola”…' });
    };
    recognition.onend = () => { state.listening = false; scheduleRestart(200); };
    recognition.onerror = (event) => {
      state.lastError = event.error;
      if (!['no-speech', 'aborted'].includes(event.error)) {
        setOrb('degraded', { label: 'Microphone needs attention' });
        toast('Microphone: ' + event.error + ' — tap Lola to retry');
        metric('recognition_error', 0, { error: event.error });
      }
    };
    recognition.onresult = (event) => {
      let finalText = '', interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const value = event.results[i][0].transcript.trim();
        if (event.results[i].isFinal) finalText += ' ' + value;
        else interim += ' ' + value;
      }
      setTranscript(finalText.trim(), interim.trim());
      const heard = (finalText || interim).trim();
      if (!heard) return;

      // BARGE-IN: she's mid-sentence and the owner speaks — cut her off
      // instantly and listen (the dashboard equivalent of interrupting a
      // human receptionist).
      if (state.speaking || state.busy) {
        cancelActive('barge-in');
        state.awake = true;
        setOrb('listening', { label: 'I’m listening' });
      }

      const hasWake = /\b(?:hey|hi|okay|ok)?\s*lola\b/i.test(heard);
      if (hasWake) {
        state.awake = true;
        state.lastWakeAt = Date.now();
        setOrb('listening', { label: 'I’m listening' });
        // The moment Lola comes alive — particle burst toward the orb.
        triggerWakeBurst();
        const command = commandFrom(heard);
        if (command && finalText) { try { recognition.stop(); } catch (e) {} askLola(command); }
        else if (finalText) toast('I’m listening.');
        return;
      }
      if (state.awake && finalText && Date.now() - state.lastWakeAt < 20000) {
        try { recognition.stop(); } catch (e) {}
        askLola(finalText.trim());
      }
    };
    state.recognition = recognition;
    return true;
  }

  function triggerWakeBurst() {
    const target = orbEl() || document.getElementById('orbStage');
    if (window.LolaWakeBurst) { try { window.LolaWakeBurst.trigger(target); } catch (e) {} }
  }

  async function enable() {
    if (state.enabled) return;
    state.enabled = true;
    state.pendingArm = false;
    setOrb('waking', { label: 'Starting Lola…' });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      stream.getTracks().forEach(track => track.stop());
      if (state.audioContext && state.audioContext.state === 'suspended') await state.audioContext.resume();
    } catch (error) {
      state.enabled = false;
      setOrb('error', { label: 'Microphone permission required' });
      toast('Allow microphone access, then tap Lola again.');
      return;
    }
    if (!state.recognition && !initRecognition()) {
      state.enabled = false;
      setOrb('degraded', { label: 'Voice needs Chrome, Edge or Safari — use the command bar' });
      const input = document.getElementById('cmdInput');
      if (input) input.focus();
      toast('Tap Lola to use chat instead.');
      return;
    }
    state.ambientOn = true;
    setOrb('ambient', { label: 'Listening for “Lola”…' });
    scheduleRestart(0);
    toast('Lola is with you. Say “Lola”, or tap the orb to talk.');
    try { localStorage.setItem(STORAGE_KEY, 'on'); } catch (e) {}
  }

  function disable() {
    state.enabled = false;
    state.awake = false;
    state.ambientOn = false;
    clearTimeout(state.restartTimer);
    cancelActive('disabled');
    try { state.recognition && state.recognition.stop(); } catch (e) {}
    setTranscript('', '');
    setOrb('idle', { label: 'Tap to speak or type a command' });
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
  }

  /* ── public toggles (installed as the page's voice control) ── */
  function toggle() {
    if (!state.enabled) { enable(); return; }
    if (state.listening) {
      try { state.recognition && state.recognition.stop(); } catch (e) {}
      state.listening = false;
      setOrb(state.ambientOn ? 'ambient' : 'idle', { label: state.ambientOn ? 'Listening for “Lola”…' : 'Tap to speak or type a command' });
      return;
    }
    // Barge-in then listen: she was talking — cut her off and take the command.
    if (state.speaking || state.busy) cancelActive('barge-in');
    state.awake = true;
    state.lastWakeAt = Date.now();
    triggerWakeBurst();
    setOrb('listening', { label: 'I’m listening' });
    toast('I’m listening.');
    try { state.recognition && state.recognition.start(); } catch (e) { scheduleRestart(0); }
  }

  function toggleAmbient() {
    if (!state.enabled) { enable(); return; }
    state.ambientOn = !state.ambientOn;
    if (!state.ambientOn) {
      try { state.recognition && state.recognition.stop(); } catch (e) {}
      setOrb('idle', { label: 'Tap to speak or type a command' });
      toast('Always-listening is off. Tap Lola to talk.');
      try { localStorage.setItem(STORAGE_KEY, 'off'); } catch (e) {}
    } else {
      setOrb('ambient', { label: 'Listening for “Lola”…' });
      scheduleRestart(0);
      toast('Listening for “Lola”.');
      try { localStorage.setItem(STORAGE_KEY, 'on'); } catch (e) {}
    }
  }

  /* ── micro particle presence field around the orb ──
     A handful of tiny drifting particles make her presence felt even
     at rest; they speed up and brighten while she listens/speaks. */
  function spawnPresence() {
    const field = document.getElementById('orbField');
    if (!field || field.querySelector('.lola-presence-particle')) return;
    const count = 26;
    for (let i = 0; i < count; i++) {
      const p = document.createElement('div');
      p.className = 'lola-presence-particle';
      const d = 6 + Math.random() * 6;
      p.style.left = (Math.random() * 100) + '%';
      p.style.top = (Math.random() * 100) + '%';
      p.style.setProperty('--d', d.toFixed(2) + 's');
      p.style.setProperty('--delay', (Math.random() * d).toFixed(2) + 's');
      p.style.setProperty('--dx', ((Math.random() - .5) * 34).toFixed(0) + 'px');
      p.style.setProperty('--dy', ((Math.random() - .5) * 34).toFixed(0) + 'px');
      field.appendChild(p);
    }
  }

  function metric(name, value, extra) {
    const detail = {
      name, value,
      tenant: window.LolaAuth && window.LolaAuth.tenant ? window.LolaAuth.tenant.id : null,
      session: window.LolaAuth && window.LolaAuth.session ? window.LolaAuth.session.id : null,
      turnId: state.turnId, mode: state.mode, ...extra
    };
    emit('lola:metric', detail);
    try { console.debug('[Lola metric]', detail); } catch (e) {}
  }

  function bind() {
    // Delegate: any orb / stage / mic anywhere routes here.
    document.addEventListener('click', (event) => {
      const target = event.target.closest(ORB_SELECTOR + ', #orbMic, #ambientToggle');
      if (!target) return;
      // Elements that carry their own inline onclick (dashboard's orb, mic
      // and ambient toggle) already route to window.toggleVoice /
      // toggleAmbientListening here — skip them so we never double-fire.
      if (typeof target.getAttribute === 'function' && target.getAttribute('onclick')) return;
      if (target.id === 'ambientToggle') { toggleAmbient(); return; }
      toggle();
    });

    window.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.code === 'Space') {
        event.preventDefault();
        state.enabled ? toggle() : enable();
      }
      if (event.key === 'Escape' && (state.speaking || state.busy)) {
        cancelActive('escape');
        scheduleRestart(100);
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) cancelActive('backgrounded');
      else if (state.enabled) scheduleRestart(150);
    });
    window.addEventListener('pagehide', () => cancelActive('pagehide'));
  }

  async function boot() {
    try {
      const auth = await window.LolaAuth.ready;
      state.ownerName = ((auth && (auth.tenant && auth.tenant.owner_name || auth.user && auth.user.user_metadata && auth.user.user_metadata.full_name)) || 'there').split(' ')[0];
    } catch (e) {}
    spawnPresence();
    bind();

    // Jarvis default: she's listening for her name unless the owner
    // turned it off. Browsers need a gesture before the mic opens, so
    // arm her and wake on the first interaction.
    let stored = null;
    try { stored = localStorage.getItem(STORAGE_KEY); } catch (e) {}
    if (stored === 'on' || stored === null) {
      state.pendingArm = true;
      const arm = () => {
        if (!state.pendingArm || state.enabled) return;
        enable();
        document.removeEventListener('pointerdown', arm);
      };
      document.addEventListener('pointerdown', arm, { once: true });
    }
    setOrb('idle', { label: stored === 'off' ? 'Tap to speak or type a command' : 'Listening for “Lola”…' });
  }

  /* ── global install: every page's inline onclicks route here ── */
  window.askLola = askLola;
  window.toggleVoice = toggle;
  window.toggleChatVoice = toggle;
  window.toggleAmbientListening = toggleAmbient;
  window.speak = (text) => {
    // Standalone speak (e.g. briefing playback): give it its own turn so
    // it never collides with an in-flight ask/speak exchange.
    if (state.speaking || state.busy) return;
    const id = state.turnId + 1;
    state.turnId = id;
    return speak(text, id);
  };

  window.LolaResonance = {
    enable, disable, ask: askLola, toggle, toggleAmbient, speak, cancel: cancelActive, state
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
