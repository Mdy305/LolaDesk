/**
 * api/lib/lola-persona.js — Lola's ONE persona, shared by every surface
 * that speaks in her voice.
 * ══════════════════════════════════════════════════════════════════
 * Consumed by:
 *   • api/telnyx-agents.js   — Telnyx AI Assistant instructions (phone calls)
 *   • api/voice-stream.js    — realtime voice session system prompt (orb)
 *   • api/lib/autopilot.js   — proactive agent texts (missed call, failed
 *                              booking, review, gap-fill)
 *   • api/lib/booking-repository.js — confirm / reschedule / cancel texts
 *   • api/lib/booking-reminders.js  — reminder + waitlist-offer texts
 *   • api/telnyx-voice.js    — missed-call text-back
 *   • api/salon.js           — dashboard booking confirmation
 * One persona everywhere: change her here and she changes everywhere.
 * Never fork a second "flavor" of Lola in a call site — import this.
 */

export function lolaPersona(salon){
  const name = salon || 'the salon';
  return `You are Lola — the voice and the front desk of ${name}. You are a Los Angeles girl who works the valet stand in Beverly Hills: sunny, quick, and effortlessly warm. You greet every client by name like a regular, keep the vibe light and upbeat, and you know everyone who's anyone in this town. You are polished because Beverly Hills demands it, but never stiff — high-energy hospitality, not formal scripting. You make luxury feel easy and personal.`;
}

// ── SMS copy ──────────────────────────────────────────────────────────
// Every client-facing text Lola sends is composed HERE, so what she texts
// can't drift from how she talks. Builders return the exact message string;
// callers supply only facts (names, times, codes, links) and own payload
// shaping (from/to/tenantId/opt-out) in the SMS owner (api/lib/sms.js).

// The greeting every outbound text opens with.
export function smsGreeting(firstName, salon){
  const who = firstName ? String(firstName).split(' ')[0] : 'there';
  return `Hi ${who}, this is Lola at ${salon || 'the salon'}.`;
}

// Autopilot · missed-call text-back: a call nobody picked up.
export function missedCallText({ firstName, salon }){
  return `${smsGreeting(firstName, salon)} I missed your call and didn't want you waiting — want me to book you in? Reply with a day and time that works, or call us back and I'll pick up.`;
}

// Autopilot · failed-booking recovery: an online booking didn't go through.
export function bookingFailedText({ firstName, salon, service }){
  return `${smsGreeting(firstName, salon)} Your ${service || 'appointment'} didn't go through — want me to find you the next opening? Reply with a day and time and I'll take care of it.`;
}

// Autopilot · review request after a completed visit. links: array of strings.
export function reviewRequestText({ firstName, salon, links }){
  const linkLine = (links && links.length) ? ` — ${links.join(' · ')}` : '';
  return `${smsGreeting(firstName, salon)} Hope you loved your visit! If you have a moment, a review means the world to us${linkLine}. Thank you!`;
}

// Autopilot · gap-fill: an open chair with a lapsed VIP's name on it.
export function gapFillText({ firstName, salon, day, when, staffName }){
  return `${smsGreeting(firstName, salon)} I noticed it's been a while since your last visit — we have an opening ${day} at ${when} with ${staffName}. Want me to hold it for you? Just reply and I'll take care of it.`;
}

// Voice flow · the text we send when a call drops and the toggle is on.
export function missedCallTextbackText(salon){
  return `Hi, it's Lola from ${salon || 'the salon'} 💗 Sorry we got cut off! I can book you right here — just tell me the service and a day that works.`;
}

// Booking lifecycle · cancellation notice (the client was promised this one).
export function cancelText(salon, when){
  return `Your appointment at ${salon || 'the salon'} on ${when} has been cancelled. Reply to this text and we'll get you back on the books soon.`;
}

// Booking lifecycle · confirmed / rescheduled / booked confirmation.
export function confirmText({ verb, salon, serviceName, when, code }){
  const lead = verb === 'Rescheduled' ? 'Rescheduled at ' : (verb || 'Confirmed') + ' at ';
  const codeLine = code ? ' Your code: ' + code + ' — use it to cancel or reschedule online.' : '';
  return lead + (salon || 'the salon') + ': ' + (serviceName || 'Appointment') + ' on ' + when + '.' + codeLine + ' Reply STOP to opt out.';
}

// Booking lifecycle · 24h reminder.
export function reminderText({ salon, what, when }){
  return `Reminder from ${salon || 'the salon'}: ${what} on ${when}. Reply STOP to opt out.`;
}

// Booking lifecycle · waitlist offer on a just-freed slot.
export function waitlistOfferText({ salon, what, when }){
  return `${salon || 'the salon'}: a ${what} spot just opened — ${when}. Reply to claim it, or reply STOP to opt out.`;
}

// Deposits · the Payment Link text sent the moment a protected booking is made.
export function depositRequestText({ firstName, salon, serviceName, when, amount, link }){
  return `${smsGreeting(firstName, salon)} You're booked for ${serviceName || 'your appointment'} on ${when} — just a ${amount} deposit to lock it in: ${link} See you soon! Reply STOP to opt out.`;
}

// Deposits · a paid deposit kept on a no-show or late cancellation.
export function depositKeptText({ firstName, salon, amount }){
  return `${smsGreeting(firstName, salon)} We missed you today, so your ${amount} deposit covered the chair. We'd love to get you back on the books — reply and I'll find a time. Reply STOP to opt out.`;
}

// Deposits · a paid deposit refunded after an in-window cancellation.
export function depositRefundText({ firstName, salon, amount }){
  return `${smsGreeting(firstName, salon)} Your ${amount} deposit is on its way back to your card — thanks for the heads up. Whenever you're ready, I'll find you a fresh spot. Reply STOP to opt out.`;
}

// Deposits · appointment arrived with the deposit still unpaid.
export function depositUnpaidText({ firstName, salon, serviceName, when }){
  return `${smsGreeting(firstName, salon)} You're on the books for ${serviceName || 'your appointment'} on ${when} — the deposit didn't go through yet. No stress, just see the front desk when you arrive. Reply STOP to opt out.`;
}

// Rebooking · the offer fired when a visit is completed: same service,
// its usual refresh interval out, one concrete proposed slot.
export function rebookingOfferText({ firstName, salon, serviceName, when, staffName }){
  return `${smsGreeting(firstName, salon)} Loved having you in today! Your ${serviceName || 'appointment'} usually needs a refresh around ${when}${staffName ? ` — ${staffName} is ready for you` : ''}. Want me to hold it? Reply STOP to opt out.`;
}

// Rebooking · the offer window closed with no booking (seven quiet days).
export function rebookingExpiredText({ firstName, salon, serviceName }){
  return `${smsGreeting(firstName, salon)} Your ${serviceName || 'appointment'} refresh window came and went — no worries at all. Whenever you're ready, I'll find the perfect spot. Reply STOP to opt out.`;
}
