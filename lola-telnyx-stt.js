/* ═══════════════════════════════════════════════════════════════════
   lola-telnyx-stt.js — server-side STT drop-in for window.SpeechRecognition
   ═══════════════════════════════════════════════════════════════════
   WHY: Chrome's SpeechRecognition fails with `network` for many users
   (Google's own endpoint), which muted the wake-word/listening path.
   Loading this BEFORE lola-resonance.js replaces window.SpeechRecognition
   with an implementation that streams the mic to /api/stt-relay (Deepgram
   server-side, key never leaves the server) and emits the same event
   surface — start/stop/onresult/onerror/onend — so lola-resonance.js
   works unchanged. Falls back gracefully: if the relay is unreachable the
   shim reports `network` exactly like the failing native path, and the
   resonance backoff/retry UI still works.

   Auth: reads the same localStorage token the rest of the dashboard uses.
   ═══════════════════════════════════════════════════════════════════ */
(function () {
  if (window.__LOLA_STT_SHIM__) return;
  window.__LOLA_STT_SHIM__ = true;

  function relayUrl() {
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    const token = localStorage.getItem('loladesk_token') || '';
    return proto + location.host + '/api/stt-relay?sample_rate=16000&token=' + encodeURIComponent(token);
  }

  function TelnyxSpeechRecognition() {
    this.continuous = false;
    this.interimResults = true;
    this.lang = 'en-US';
    this.onstart = null; this.onresult = null; this.onerror = null; this.onend = null;
    this._ws = null; this._ctx = null; this._worklet = null; this._stream = null;
    this._running = false; this._final = ''; this._closedByUs = false;
  }

  TelnyxSpeechRecognition.prototype.start = async function () {
    if (this._running) return;
    this._running = true;
    this._final = '';
    try {
      this._ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      try { await this._ctx.audioWorklet.addModule('/public/lola-mic-worklet.js'); }
      catch (e) { await this._ctx.audioWorklet.addModule('/lola-mic-worklet.js'); }
      this._stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleRate: 16000 }
      });
      const src = this._ctx.createMediaStreamSource(this._stream);
      this._worklet = new AudioWorkletNode(this._ctx, 'lola-mic');

      const ws = new WebSocket(relayUrl());
      this._ws = ws;
      ws.binaryType = 'arraybuffer';

      let opened = false;
      const openTimeout = setTimeout(() => {
        if (!opened) { this._fail('network'); }
      }, 8000);

      ws.onopen = () => {
        // wait for the server's {type:'ready'} before declaring open
      };
      const self = this;
      ws.onmessage = (evt) => {
        let msg; try { msg = JSON.parse(evt.data); } catch (e) { return; }
        if (msg.type === 'ready') {
          opened = true;
          clearTimeout(openTimeout);
          src.connect(self._worklet);
          self._worklet.port.onmessage = (e) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(e.data.buffer);
          };
          if (typeof self.onstart === 'function') { try { self.onstart(); } catch (e) {} }
          return;
        }
        // Deepgram result envelope → SpeechRecognition event shape
        const alt = msg.channel && msg.channel.alternatives && msg.channel.alternatives[0];
        const transcript = (alt && alt.transcript || '').trim();
        if (!transcript) return;
        const isFinal = !!msg.is_final;
        if (isFinal) self._final = (self._final ? self._final + ' ' : '') + transcript;
        const results = [{ 0: { transcript, confidence: (alt.confidence != null ? alt.confidence : 0.9) }, isFinal, length: 1 }];
        results.length = 1;
        if (typeof self.onresult === 'function') {
          try { self.onresult({ results, resultIndex: 0 }); } catch (e) {}
        }
      };
      ws.onclose = () => {
        clearTimeout(openTimeout);
        const wasRunning = self._running;
        self._cleanup();
        if (!self._closedByUs && typeof self.onerror === 'function' && !self._errored) {
          self._fail('network');
        }
        if (wasRunning && typeof self.onend === 'function') { try { self.onend(); } catch (e) {} }
      };
      ws.onerror = () => { /* onclose follows */ };
    } catch (e) {
      this._running = false;
      this._fail(e && e.name === 'NotAllowedError' ? 'not-allowed' : 'audio-capture');
      if (typeof this.onend === 'function') { try { this.onend(); } catch (err) {} }
    }
  };

  TelnyxSpeechRecognition.prototype._fail = function (type) {
    this._errored = true;
    if (typeof this.onerror === 'function') { try { this.onerror({ error: type }); } catch (e) {} }
  };

  TelnyxSpeechRecognition.prototype.stop = function () { this._closedByUs = true; this._cleanup(); };
  TelnyxSpeechRecognition.prototype.abort = function () { this._closedByUs = true; this._cleanup(); };

  TelnyxSpeechRecognition.prototype._cleanup = function () {
    this._running = false;
    try { this._ws && this._ws.close(); } catch (e) {}
    try { this._worklet && this._worklet.disconnect(); } catch (e) {}
    try { this._stream && this._stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
    try { this._ctx && this._ctx.close(); } catch (e) {}
    this._ws = this._worklet = this._stream = this._ctx = null;
  };

  // Swap in the shim. lola-resonance.js reads these globals and never knows.
  window.SpeechRecognition = TelnyxSpeechRecognition;
  window.webkitSpeechRecognition = TelnyxSpeechRecognition;
  window.__LOLA_STT_ENGINE__ = 'server-deepgram';
  console.log('[Lola STT] using server-side Deepgram via /api/stt-relay');
})();
