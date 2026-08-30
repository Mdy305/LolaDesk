/* ════════════════════════════════════════════════════════════════════
   LolaDesk — lola-voice-router.js
   ════════════════════════════════════════════════════════════════════
   Makes window.LolaVoice (the Telnyx-conversation path — the SAME assistant
   that answers the phone) the PRIMARY orb/tap voice path, with
   lola-resonance (browser STT → /api/voice/session → ElevenLabs) as the
   automatic fallback.

   Why a router at all: both engines grab the microphone, so they can never
   run at once. This module probes /api/voice-session ONCE at boot:
     • HTTP 200  → LolaVoice is reachable → it owns the orb tap.
                    Resonance sleep-mode is set so it never auto-arms and
                    fights for the mic.
     • anything else (503 assistant-not-configured, 401 unauthenticated,
       5xx, network) → LolaVoice can't connect right now → resonance owns
       the orb exactly as it did before this file existed.

   Load AFTER lola-resonance.js so it can override window.toggleVoice.
   ════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var RESONANCE_KEY = 'loladesk_resonance';

  function token() { try { return global.localStorage.getItem('loladesk_token') || ''; } catch (e) { return ''; } }

  function baseToggleVoice() {
    return global.LolaResonance && typeof global.LolaResonance.toggle === 'function'
      ? global.LolaResonance.toggle
      : (global.toggleVoice || function () {});
  }

  // One-time probe: can LolaVoice actually mint a session today?
  function probeLolaVoice() {
    if (!global.LolaVoice) return Promise.resolve(false);
    return fetch('/api/voice-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': token() ? 'Bearer ' + token() : '' },
    }).then(function (r) {
      if (r.status === 200) return true;   // assistant configured + reachable
      return false;                        // 503 assistant missing, 401, 5xx, etc.
    }).catch(function () { return false; });
  }

  var lolaPrimary = false;

  var overrideToggle = function () {
    if (global.LolaVoice && lolaPrimary) {
      var st = global.LolaVoice.state;
      if (st && st.streaming) { global.LolaVoice.stop(); return; }
      global.LolaVoice.begin().then(function (ok) {
        // If primary failed at tap-time, drop through to resonance so the
        // tap still does something (text/STT path).
        if (!ok) { var fb = baseToggleVoice(); if (fb) fb(); }
      });
      return;
    }
    var fb2 = baseToggleVoice();
    if (fb2) fb2();
  };

  // Install the router synchronously (taps before the probe resolves fall
  // through to resonance, which is the safe default).
  global.toggleVoice = overrideToggle;
  global.toggleChatVoice = overrideToggle;

  probeLolaVoice().then(function (ok) {
    lolaPrimary = ok;
    if (ok) {
      // Room for LolaVoice to own the mic: silence resonance's auto-arm.
      try { global.localStorage.setItem(RESONANCE_KEY, 'off'); } catch (e) {}
      // If resonance had already enabled (rare), back it down.
      if (global.LolaResonance && typeof global.LolaResonance.disable === 'function') {
        try { global.LolaResonance.disable(); } catch (e) {}
      }
    }
  });

  // If LolaVoice is stopped/disarmed by anything, ensure a late probe
  // failure still leaves the orb usable.
  if (global.document && global.document.addEventListener) {
    global.document.addEventListener('lola:ended', function () { /* handled by toggle */ });
  }
})(window);