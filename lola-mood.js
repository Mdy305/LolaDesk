/* LolaDesk — lola-mood.js: Lola feels the room.
 *
 * One mood for every Lola on the page (the dashboard body, the corner Lola,
 * the phone-bar Lola). She reads three things and her body answers:
 *   · the hour        — bright and quick in the morning, soft late at night
 *   · the salon       — a booking or a call landing makes her light up
 *   · the conversation — your words: thanks and good news make her sparkle,
 *                        a problem makes her slow, warm and attentive,
 *                        "now / asap" makes her quick
 * Emits `lola:mood` {energy, joy, concern, pulse}; lola-orb.js listens.
 * Feelings fade back to her resting mood over about half a minute.
 */
(function () {
  if (window.LolaMood) return;
  const POS = /\b(thank(s| you)|love|great|amazing|awesome|perfect|beautiful|wonderful|excellent|nice|good (?:job|news|work)|well done|yay|congrats|happy|excited|booked|sold out|record|best)\b|😍|🎉|❤️|🙏/i;
  const NEG = /\b(angry|upset|mad|annoy|frustrat|problem|issue|broken|doesn'?t work|not working|wrong|bad|terrible|awful|complain|refund|cancel|no.?show|missed|late|lost|worried|stress|tired|slow|sad|sorry|wtf|hate)\b|😡|😤|😢/i;
  const URGENT = /\b(now|asap|urgent|quick(ly)?|hurry|immediately|right away|emergency)\b|!{2,}/i;
  const DONE = /^(sent|done|booked|moved|cancelled|marked|opening|here'?s)/i;

  function hourMood() {
    const h = new Date().getHours();
    if (h >= 6 && h < 11) return 0.72;   // morning: bright
    if (h >= 11 && h < 17) return 0.64;  // the day
    if (h >= 17 && h < 21) return 0.5;   // evening
    return 0.32;                          // night: soft
  }
  const state = { energy: hourMood(), joy: 0, concern: 0 };
  const feel = { joy: 0, concern: 0, energy: 0, at: 0 };

  function emit(extra) {
    const age = (Date.now() - feel.at) / 1000;
    const fade = feel.at ? Math.max(0, 1 - age / 35) : 0;
    state.joy = +(feel.joy * fade).toFixed(3);
    state.concern = +(feel.concern * fade).toFixed(3);
    state.energy = +Math.max(0, Math.min(1, hourMood() + feel.energy * fade)).toFixed(3);
    try { window.dispatchEvent(new CustomEvent('lola:mood', { detail: Object.assign({}, state, extra || {}) })); } catch (_) {}
  }
  function set(m, pulse) {
    feel.joy = Math.max(0, Math.min(1, m.joy || 0));
    feel.concern = Math.max(0, Math.min(1, m.concern || 0));
    feel.energy = Math.max(-0.4, Math.min(0.4, m.energy || 0));
    feel.at = Date.now();
    emit(pulse ? { pulse } : null);
  }
  function read(text) {
    const t = String(text || '');
    if (!t) return null;
    const pos = POS.test(t), neg = NEG.test(t), urg = URGENT.test(t);
    if (!pos && !neg && !urg) return null;
    return { joy: pos && !neg ? 0.85 : pos ? 0.35 : 0, concern: neg ? 0.75 : 0, energy: urg ? 0.3 : neg ? -0.15 : pos ? 0.15 : 0 };
  }

  // What you say to her.
  addEventListener('lola:heard', (e) => { const m = read(e.detail && e.detail.text); if (m) set(m, m.joy > 0.5 ? 0.35 : 0); });
  // What she did: something got done → a little lift.
  addEventListener('lola:reply', (e) => {
    const d = e.detail || {}; const said = (d.content && d.content[0] && d.content[0].text) || '';
    if (DONE.test(said) && !d.needs_confirmation) set({ joy: 0.55, energy: 0.12 }, 0.4);
    else { const m = read(said); if (m && m.concern) set({ concern: 0.4 }); }
  });
  // The salon itself: a booking, a call, a message landing (lola-live-poll / lolaPulse).
  addEventListener('lola:event', (e) => {
    const k = String((e.detail && e.detail.kind) || '');
    if (/booking|paid|review/.test(k)) set({ joy: 0.8, energy: 0.2 }, 0.7);
    else if (/missed|cancel|complaint/.test(k)) set({ concern: 0.6 }, 0.25);
    else set({ energy: 0.15 }, 0.35);
  });

  emit();
  setInterval(emit, 4000);            // feelings fade; the hour changes
  window.LolaMood = { state, set, read, emit };
})();
