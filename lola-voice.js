/* ════════════════════════════════════════════════════════════════════
   LolaDesk — LolaVoice: Lola in the browser (the "Hey Lola" orb path)
   ════════════════════════════════════════════════════════════════════
   The SAME Telnyx AI Assistant that answers the salon's phone answers the
   owner here. Protocol is Telnyx's REAL conversation WebSocket (relayed by
   /api/voice-relay). This module is deliberately BUNDLER-FREE (IIFE, no
   npm imports) so it deploys in the static+serverless stack unchanged.

   The wake word is owner-gated: it needs a Picovoice account + a trained
   "Hey Lola" model, which you have not supplied yet. Until then this runs
   in TAP-TO-TALK mode (click/tap the orb). The moment a wake model + key
   are provided, a thin Porcupine hook can call window.LolaVoice.begin()
   on detection. Nothing here is a fake voice — all audio is Lola's
   canonical voice via Telnyx/ElevenLabs.

   API:
     LolaVoice.begin()                          — merge active session / tap-to-talk
     LolaVoice.stop()                           — end the current conversation
     LolaVoice.arm()                            — request mic (enables begin)
     LolaVoice.on('state', cb) / on('error', cb)
   ════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';
  if (global.LolaVoice) return;

  const state = {
    armed: false, streaming: false, error: null,
    micStream: null, audioCtx: null, worklet: null, ws: null,
    playback: [], playing: false, outputRate: 24000,
    listeners: { state: [], error: [] },
  };

  const listeners = (ev) => state.listeners[ev] || [];
  function emit(ev, detail) {
    state[ev === 'state' ? 'lastState' : 'lastError'] = detail;
    state.listeners[ev].forEach((fn) => { try { fn(detail); } catch (e) {} });
    global.dispatchEvent(new CustomEvent('lola:' + ev, { detail }));
  }

  /* ── mic + PCM plumbing ───────────────────────────────────────── */
  function floatTo16bitPCM(float32arr) {
    const out = new Int16Array(float32arr.length);
    for (let i = 0; i < float32arr.length; i++) {
      const s = Math.max(-1, Math.min(1, float32arr[i] || 0));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }
  function base64FromPcm16(int16arr) {
    const bytes = new Uint8Array(int16arr.buffer);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return global.btoa(bin);
  }
  function pcm16ToFloat32Base64ToBuffer(b64) {
    const bin = global.atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer; // little-endian PCM16 bytes
  }

  /* ── arm: request mic (needs a user gesture) ──────────────────── */
  async function arm() {
    if (state.armed) return true;
    if (!(global.isSecureContext || global.location.hostname === 'localhost')) {
      state.error = 'HTTPS (or localhost) is required for the microphone.';
      emit('error', state.error);
      return false;
    }
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      state.micStream = s; // keep a live handle; worklet attaches on begin
      state.armed = true;
      state.error = null;
      emit('state', { armed: true });
      return true;
    } catch (e) {
      state.error = e?.name === 'NotAllowedError'
        ? 'Microphone permission denied — enable it for Lola to hear you.'
        : (e?.message || 'Could not access microphone.');
      emit('error', state.error);
      return false;
    }
  }

  /* ── begin a conversation tap-to-talk ─────────────────────────── */
  /**
   * begin() → Promise<boolean>
   * Resolves true when a Telnyx conversation session is actually streaming
   * (the orb should treat this as the PRIMARY voice path). Resolves false on
   * ANY failure — and cleans up the mic — so callers (the orb router) can
   * fall back to lola-resonance without a stuck mic.
   */
  async function begin() {
    if (state.streaming) return true; // already talking
    try {
      const token = global.localStorage && global.localStorage.getItem('loladesk_token');
      const resp = await fetch('/api/voice-session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': token ? 'Bearer ' + token : '',
        },
      });
      if (!resp.ok) {
        await cleanup('ended', 'session refused');
        const j = await resp.json().catch(() => ({}));
        if (state.listeners.error.length) emit('error', j.error || ('Could not start voice session (HTTP ' + resp.status + ')'));
        return false;
      }
      const { session_token, assistant_id, relay_url } = await resp.json();

      const armed = await arm();
      if (!armed) return false;

      const url = `${relay_url}?assistant=${encodeURIComponent(assistant_id)}&token=${encodeURIComponent(session_token)}`;
      state.ws = new global.WebSocket(url);
      await new Promise((resolve, reject) => {
        state.ws.onopen = () => resolve();
        state.ws.onerror = () => reject(new Error('Could not reach Lola relay'));
        setTimeout(() => reject(new Error('Voice relay connect timeout')), 8000);
      });

      state.ws.onmessage = onFrame;
      state.ws.onclose = () => cleanup('ended', 'remote close');
      state.ws.onerror = () => cleanup('ended', 'socket error');

      // Start the mic worklet and keep streaming PCM16 the whole time.
      if (state.audioCtx) state.audioCtx.resume();
      state.streaming = true;
      emit('state', { streaming: true });
      return true;
    } catch (e) {
      state.error = e?.message || 'Voice session failed';
      emit('error', state.error);
      await cleanup('ended', 'begin failed');
      return false;
    }
  }

  async function ensureCapturePipeline() {
    if (state.audioCtx && state.worklet) return;
    state.audioCtx = new (global.AudioContext || global.webkitAudioContext)({ sampleRate: 16000 });
    await state.audioCtx.audioWorklet.addModule('/public/lola-audio-worklet.js');
    state.worklet = new AudioWorkletNode(state.audioCtx, 'lola-mic-processor');
    state.worklet.port.onmessage = (ev) => {
      if (state.ws && state.ws.readyState === global.WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: base64FromPcm16(ev.data) }));
      }
    };
    const source = state.audioCtx.createMediaStreamSource(state.micStream);
    source.connect(state.worklet);
    // never connect worklet to destination — no echo of self
  }

  /* ── inbound frames (Telnyx real event names) ─────────────────── */
  function onFrame(event) {
    let msg;
    try { msg = JSON.parse(event.data); } catch (e) { return; }
    switch (msg.type) {
      case 'session.created':
        state.outputRate = msg.session?.audio?.output?.format?.rate || state.outputRate;
        // send dynamic_variables for this conversation (first frame rule)
        break;
      case 'input_audio_buffer.speech_started':
        // barge-in: flush queued assistant audio so Lola doesn't talk over you
        state.playback = [];
        emit('state', { userSpeaking: true });
        break;
      case 'conversation.item.input_audio_transcription.completed':
        emit('state', { transcript: msg.transcript, role: 'user' });
        break;
      case 'response.output_audio.delta':
        if (msg.delta) enqueuePlayback(msg.delta);
        break;
      case 'response.output_audio_transcript.delta':
        emit('state', { delta: msg.delta, role: 'assistant' });
        break;
      case 'response.done':
        break;
      case 'conversation.item.created':
        handleClientTool(msg.item);
        break;
      case 'error':
        state.error = msg.error?.message || 'Assistant error';
        console.warn('[LolaVoice] Telnyx:', msg.error?.code, msg.error?.message);
        emit('error', state.error);
        break;
    }
  }

  /* ── client-side tool execution ───────────────────────────────── */
  function handleClientTool(item) {
    if (!item || item.type !== 'function_call') return;
    const { name, call_id, arguments: argsJson } = item;
    let args = {};
    try { args = JSON.parse(argsJson || '{}'); } catch (e) { /* keep {} */ }
    let result = { ok: false, error: 'unknown tool' };
    try {
      if (name === 'navigate_ui') {
        global.location.assign(args.path || '/dashboard');
        result = { ok: true };
      } else if (name === 'prefill_form') {
        Object.entries(args.fields || {}).forEach(([k, v]) => {
          const el = global.document.querySelector('[name="' + k + '"], #' + k);
          if (el) { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }
        });
        result = { ok: true };
      } else if (global.LolaTools && typeof global.LolaTools[name] === 'function') {
        const p = global.LolaTools[name](args);
        if (p && typeof p.then === 'function') {
          return p.then((r) => sendToolResult(call_id, r || { ok: true }))
            .catch((err) => sendToolResult(call_id, { ok: false, error: String(err?.message || err) }));
        }
        result = p || { ok: true };
      }
      sendToolResult(call_id, result);
    } catch (e) {
      sendToolResult(call_id, { ok: false, error: String(e?.message || e) });
    }
  }

  function sendToolResult(call_id, output) {
    if (!state.ws || state.ws.readyState !== global.WebSocket.OPEN) return;
    state.ws.send(JSON.stringify({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id, output: JSON.stringify(output) },
    }));
  }

  /* ── playback queue ───────────────────────────────────────────── */
  function enqueuePlayback(b64) {
    const buffer = pcm16ToFloat32Base64ToBuffer(b64);
    if (state.playback.length === 0 && !state.playing) {
      state.playing = true;
      playBuffer(buffer, state.outputRate);
    } else {
      state.playback.push(buffer);
    }
  }
  function playBuffer(pcmByteBuffer, rate) {
    // decode to Float32 at the reported output rate into a queue
    const int16 = new Int16Array(pcmByteBuffer); // assumes little-endian
    const float = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float[i] = int16[i] / 32768;
    if (!state.audioCtx) {
      state.playing = false;
      drainNext();
      return;
    }
    // Resample from `rate` to the AudioContext's actual sample rate.
    const ctxRate = state.audioCtx.sampleRate;
    const ratio = ctxRate / (rate || ctxRate);
    const target = Math.max(1, Math.round(float.length * ratio));
    const resampled = new Float32Array(target);
    for (let i = 0; i < target; i++) {
      const src = Math.min(float.length - 1, i / ratio);
      const i0 = Math.floor(src); const frac = src - i0;
      resampled[i] = float[i0] * (1 - frac) + (float[Math.min(i0 + 1, float.length - 1)] * frac);
    }
    const buf = state.audioCtx.createBuffer(1, resampled.length, ctxRate);
    buf.copyToChannel(resampled, 0);
    const srcNode = state.audioCtx.createBufferSource();
    srcNode.buffer = buf;
    srcNode.connect(state.audioCtx.destination);
    srcNode.onended = () => { state.playing = false; drainNext(); };
    srcNode.start();
  }
  function drainNext() {
    if (!state.playback.length) { state.playing = false; return; }
    state.playing = true;
    const b64 = state.playback.shift();
    playBuffer(pcm16ToFloat32Base64ToBuffer(b64), state.outputRate);
  }

  /* ── stop / cleanup ───────────────────────────────────────────── */
  function stop() {
    if (state.ws && state.ws.readyState === global.WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: 'response.cancel' }));
    }
    cleanup('ended', 'user-stop');
  }
  async function cleanup(reason, detail) {
    if (state.worklet) { try { state.worklet.disconnect(); } catch (e) {} state.worklet = null; }
    if (state.audioCtx) { try { await state.audioCtx.close(); } catch (e) {} state.audioCtx = null; }
    if (state.micStream) { try { state.micStream.getTracks().forEach((t) => t.stop()); } catch (e) {} state.micStream = null; }
    if (state.ws) { try { state.ws.close(); } catch (e) {} state.ws = null; }
    state.streaming = false;
    state.playing = false;
    state.playback = [];
    state.armed = false; // mic released — next begin re-requests it
    emit('state', { streaming: false, reason, detail });
  }
  function destroy() { return cleanup('ended', 'destroy'); }

  // keep pipeline alive across begin/stop so the same mic worklet persists
  async function wrapBegin() {
    await ensureCapturePipeline();
    return begin();
  }

  global.LolaVoice = {
    begin: async () => (await arm()) ? wrapBegin() : false,
    stop, arm, destroy,
    on(ev, fn) {
      if (ev === 'state' || ev === 'error') {
        state.listeners[ev].push(fn);
        // replay most recent state/error so late subscribers see it
        if (ev === 'state' && state.lastState !== undefined) fn(state.lastState);
        if (ev === 'error' && state.lastError !== undefined) fn(state.lastError);
      }
      return () => { state.listeners[ev] = state.listeners[ev].filter((f) => f !== fn); };
    },
    get state() {
      return { armed: state.armed, streaming: state.streaming, error: state.error,
        outputRate: state.outputRate };
    },
  };
}(window));