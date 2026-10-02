/* ═══════════════════════════════════════════════════════════════
   LolaSound — the one way Lola's voice leaves the speaker.
   ════════════════════════════════════════════════════════════════
   Why this exists: Lola answered in text but stayed silent, because
   her audio was played through a Web Audio graph created AFTER the
   network round-trip. Safari / iPhone keep such a context suspended
   (no tap inside the same gesture), and iPhone mutes Web Audio
   entirely when the ring switch is on silent. Result: no sound, and
   the "speaking" state never ended.

   The fix:
     • Her voice always plays through ONE native <audio> element,
       unlocked on the owner's first tap/keypress (and re-unlocked on
       every later one — cheap). Native media plays through the iPhone
       silent switch and keeps playing once unlocked.
     • navigator.audioSession = 'playback' where supported (iOS 17+).
     • The orb's resonance comes from the decoded audio's loudness
       envelope (an OfflineAudioContext — never needs a gesture), read
       at the element's currentTime. Visuals can never mute her again.
     • If the browser still refuses (first visit, no tap yet), a small
       "Tap to hear Lola" chip appears; one tap plays the reply.
     • Every play ends: a safety timer finishes it even if the browser
       never fires 'ended'.

   API:
     LolaSound.play(bytes|Blob, { onLevel(fn), onStart() }) → Promise<{ played, reason? }>
     LolaSound.cancel()
     LolaSound.unlocked → boolean
   ═══════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';
  if (global.LolaSound) return;
  const doc = global.document;
  const SILENT = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQQAAACAgICA';
  let el = null, unlocked = false, current = null, chip = null;

  try { if (global.navigator && global.navigator.audioSession) global.navigator.audioSession.type = 'playback'; } catch (_) {}

  function element() {
    if (el) return el;
    el = doc.createElement('audio');
    el.setAttribute('playsinline', ''); el.setAttribute('webkit-playsinline', '');
    el.preload = 'auto'; el.style.display = 'none';
    (doc.body || doc.documentElement).appendChild(el);
    return el;
  }

  function unlock() {
    const a = element();
    if (current) return;                               // she's speaking: don't touch the element
    try {
      a.muted = false; a.src = SILENT;
      const p = a.play();
      if (p && p.then) p.then(() => { unlocked = true; if (!current && String(a.currentSrc || a.src).startsWith('data:')) { try { a.pause(); } catch (_) {} } }).catch(() => {});
      else unlocked = true;
    } catch (_) {}
  }
  ['pointerdown', 'touchend', 'keydown', 'click'].forEach((ev) => {
    try { global.addEventListener(ev, unlock, { capture: true, passive: true }); } catch (_) {}
  });

  // Loudness envelope at 50 frames/s, from an offline context (no gesture needed, never audible).
  async function envelope(buf) {
    try {
      const OAC = global.OfflineAudioContext || global.webkitOfflineAudioContext;
      if (!OAC) return null;
      const ctx = new OAC(1, 1, 44100);
      const audio = await new Promise((res, rej) => { const p = ctx.decodeAudioData(buf.slice(0), res, rej); if (p && p.then) p.then(res, rej); });
      const ch = audio.getChannelData(0), step = Math.max(1, Math.floor(audio.sampleRate / 50)), out = new Float32Array(Math.ceil(ch.length / step));
      for (let f = 0; f < out.length; f++) { let s = 0; const a = f * step, b = Math.min(ch.length, a + step); for (let i = a; i < b; i += 4) s += ch[i] * ch[i]; out[f] = Math.min(1, Math.sqrt(s / Math.max(1, (b - a) / 4)) * 4.2); }
      return { frames: out, duration: audio.duration };
    } catch (_) { return null; }
  }

  function showChip(onTap) {
    hideChip();
    chip = doc.createElement('button');
    chip.type = 'button'; chip.className = 'lola-tap-to-hear';
    chip.textContent = '🔊 Tap to hear Lola';
    chip.style.cssText = 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:2147483000;padding:10px 18px;border-radius:999px;border:1px solid rgba(204,255,0,.55);background:rgba(10,12,8,.92);color:#eaff8f;font:600 14px -apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.45);cursor:pointer';
    chip.addEventListener('click', (e) => { e.stopPropagation(); hideChip(); onTap(); }, { once: true });
    (doc.body || doc.documentElement).appendChild(chip);
  }
  function hideChip() { if (chip) { try { chip.remove(); } catch (_) {} chip = null; } }

  function cancel() {
    hideChip();
    if (current) { const c = current; current = null; c.finish({ played: false, reason: 'cancelled' }); }
  }

  async function play(data, opts = {}) {
    cancel();
    const bytes = data instanceof ArrayBuffer ? data : await new Response(data).arrayBuffer();
    if (!bytes || !bytes.byteLength) return { played: false, reason: 'empty' };
    const a = element();
    const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }));
    const env = await envelope(bytes);
    return new Promise((resolve) => {
      let done = false, raf = 0, safety = 0;
      const me = {
        finish(r) {
          if (done) return; done = true;
          if (current === me) current = null;
          clearTimeout(safety); if (raf) cancelAnimationFrame(raf);
          try { a.onended = a.onerror = a.onplaying = null; a.pause(); } catch (_) {}
          if (opts.onLevel) opts.onLevel(null);
          setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 400);
          resolve(r);
        }
      };
      current = me;
      const level = () => {
        if (!env || !env.frames.length) return 0.35 + 0.25 * Math.sin(performance.now() / 90);
        return env.frames[Math.min(env.frames.length - 1, Math.floor((a.currentTime || 0) * 50))] || 0;
      };
      a.onended = () => me.finish({ played: true });
      a.onerror = () => me.finish({ played: false, reason: 'decode' });
      a.onplaying = () => {
        unlocked = true;
        if (opts.onStart) try { opts.onStart(); } catch (_) {}
        if (opts.onLevel) opts.onLevel(level);
        const ms = ((env && env.duration) || a.duration || 30) * 1000 + 2500;
        clearTimeout(safety); safety = setTimeout(() => me.finish({ played: true, reason: 'timeout' }), Math.min(ms, 120000));
      };
      safety = setTimeout(() => { if (!a.currentTime) me.finish({ played: false, reason: 'stalled' }); }, 15000);
      const go = () => {
        try {
          a.muted = false; a.src = url; a.currentTime = 0;
          const p = a.play();
          if (p && p.catch) p.catch((err) => {
            if (done) return;
            if (err && err.name === 'NotAllowedError') { clearTimeout(safety); showChip(go); safety = setTimeout(() => { hideChip(); me.finish({ played: false, reason: 'blocked' }); }, 60000); }
            else if (!(err && err.name === 'AbortError')) me.finish({ played: false, reason: String(err && err.name || 'error') });
          });
        } catch (_) { me.finish({ played: false, reason: 'error' }); }
      };
      go();
    });
  }

  global.LolaSound = { play, cancel, get unlocked() { return unlocked; } };
})(window);
