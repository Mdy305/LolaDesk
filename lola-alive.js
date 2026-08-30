/* ═══════════════════════════════════════════════════════════════
   LolaAlive — Lola's neurologic path
   ════════════════════════════════════════════════════════════════
   One Lola, ONE voice, everywhere. This module gives Lola her
   *hearing* and *thinking* in the browser — but it never invents a
   voice for her. She speaks ONLY through /api/speak-lola, which
   returns her canonical ElevenLabs voice. If that endpoint is
   unreachable, Lola stays silent and reports `engine:'unavailable'`
   — she does NOT fall back to a generic browser voice, because that
   would not be Lola. (One voice, like Siri. Not changeable.)

   Lobes:
     1. HEAR   — browser SpeechRecognition (on-device STT)
     2. THINK  — a deterministic intent brain (the same skill layer
                 api/lola-brain.js runs server-side)
     3. SPEAK  — ONLY Lola's official voice via /api/speak-lola

   In the static preview the local server proxies /api/speak-lola to
   the live deployment, so she still speaks in her real voice.

   API:
     LolaAlive.speak(text) → { engine:'elevenlabs'|'unavailable', cancel() }
     LolaAlive.listen({ onResult, onError, onEnd }) → { stop() }
     LolaAlive.reply(text) → string            // intent brain

   Everything is best-effort and never throws to callers.
   ═══════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  /* ── SPEAK ──────────────────────────────────────────────────────
     Lola's official voice only. No fake voices, ever.               */
  function speak(text) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return Promise.resolve({ engine: 'unavailable', cancel() {} });

    return fetch('/api/speak-lola', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: clean })
    }).then(async r => {
      if (!r.ok) throw new Error('voice unavailable');
      const bytes = await r.arrayBuffer();
      const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }));
      const audio = new Audio(url);
      audio.onended = () => { try { URL.revokeObjectURL(url); } catch (e) {} };
      const p = audio.play();
      if (p && p.catch) p.catch(() => {});
      return {
        engine: 'elevenlabs',
        cancel() { audio.pause(); }
      };
    }).catch(() => ({
      engine: 'unavailable',
      cancel() {}
    }));
  }

  /* ── HEAR (open STT) ─────────────────────────────────────────── */
  function listen(opts = {}) {
    const SR = global.SpeechRecognition || global.webkitSpeechRecognition;
    if (!SR) {
      const err = new Error('Speech recognition needs Chrome, Edge or Safari');
      if (opts.onError) opts.onError(err);
      return { stop() {} };
    }
    const rec = new SR();
    rec.continuous = false;
    rec.interimResults = Boolean(opts.interimResults);
    rec.lang = opts.lang || 'en-US';
    rec.onresult = e => {
      let text = '';
      for (let i = e.resultIndex; i < e.results.length; i++) text += e.results[i][0].transcript;
      if (opts.onResult) opts.onResult(text, !!(e.results[e.results.length - 1] || {}).isFinal);
    };
    rec.onerror = e => { if (opts.onError) opts.onError(new Error(e.error || 'recognition error')); };
    rec.onend = () => { if (opts.onEnd) opts.onEnd(); };
    try { rec.start(); } catch (e) {}
    return { stop() { try { rec.stop(); } catch (e) {} } };
  }

  /* ── THINK (intent brain) ──────────────────────────────────────
     The same deterministic skill layer as api/lola-brain.js, in the
     browser, so she answers instantly with zero latency or cost.    */
  function reply(text) {
    const t = String(text || '').toLowerCase().trim();
    if (!t) return "I'm listening. What would you like — an appointment, our prices, or our hours?";

    if (/^(hi|hello|hey|lola|yo|good (morning|afternoon|evening))\b/.test(t))
      return "Hi, I'm Lola — the front desk that never sleeps. I can book an appointment, check prices, or tell you our hours. What do you need?";
    if (/\b(who|what) are you\b/.test(t) || /\bare you (real|a robot|ai|human)\b/.test(t))
      return "I'm Lola, the AI concierge behind LolaDesk. I answer every call, book every client, and never miss a booking. This is how I sound on every call.";
    if (/sign me in|log me in|sign in|log in/.test(t))
      return "Of course. For security I'll need your email and password in the form below — voice never bypasses sign-in. Type them in and I'll get you straight to your dashboard.";
    if (/\b(book|schedule|reschedule|appointment|pencil)/.test(t))
      return "I'd love to get you booked. What service would you like, and what day works best?";
    if (/\b(price|pricing|cost|how much|menu|services?|offer)/.test(t))
      return "Our signature balayage is three ninety-five, and a cut and gloss is two twenty-five. Want me to book one for you?";
    if (/\b(hours?|open|close|when are you|location|address|where are you)\b/.test(t))
      return "We're open Tuesday through Saturday, noon to eight. Want me to find an opening for you?";
    if (/\b(thanks|thank you|cheers)\b/.test(t))
      return "Anytime — I'm here around the clock. Is there anything else I can do for you?";
    if (/\b(bye|goodbye|see you|that's all)\b/.test(t))
      return "Goodbye! Call or text anytime — I never miss you.";
    return "I can help you book an appointment, check our prices, or tell you our hours. What would you like?";
  }

  global.LolaAlive = { speak, listen, reply };
})(window);
