/**
 * api/lib/owner-intents.js — Lola's reflexes.
 * ════════════════════════════════════════════════════════════════
 * The things an owner says fifty times a day — "open my calendar",
 * "catch me up", "how much did we make this week", "text Maria I'm running
 * late", "call Priya", "cancel Ana's appointment" — are recognised here in
 * a millisecond and run straight through the owner tools. No model in the
 * loop, so they work instantly and identically every time, like a switch.
 * Anything else goes to Lola's brain (Telnyx inference with tools).
 *
 * routeOwnerIntent(text) → null | { navigate, say } | { tool, args }
 */

// Where each spoken page name lives.
const PAGES = [
  [/^(?:the )?(?:calendar|schedule|bookings?|appointments?|book)$/, '/calendar', 'your calendar'],
  [/^(?:today|dashboard|home|now|front desk)$/, '/dashboard', 'Now'],
  [/^(?:clients?|client list|customers?|crm)$/, '/clients', 'your clients'],
  [/^(?:calls?|call log|phone calls?|voicemails?)$/, '/calls', 'your calls'],
  [/^(?:inbox|messages|texts|conversations|dms?)$/, '/inbox', 'your inbox'],
  [/^(?:revenue|money|sales|reports?|numbers)$/, '/revenue', 'revenue'],
  [/^(?:growth plan|growth|marketing plan|marketer|marketing|vp of marketing)$/, '/marketer', 'your growth plan'],
  [/^(?:campaigns?|texts? campaigns?|30.day plan|fill plan)$/, '/campaigns', 'your campaigns'],
  [/^(?:reviews?|google reviews|reputation)$/, '/reviews', 'your reviews'],
  [/^(?:team|staff|stylists?|employees)$/, '/team', 'your team'],
  [/^(?:services?|menu|service menu|prices|price list)$/, '/services', 'your services'],
  [/^(?:settings|preferences|account)$/, '/settings', 'settings'],
  [/^(?:booking settings|booking rules)$/, '/booking-settings', 'booking rules'],
  [/^(?:banking|payments|payouts|bank)$/, '/banking', 'banking'],
  [/^(?:pos|checkout|register|point of sale)$/, '/pos', 'checkout'],
  [/^(?:telecom|phone numbers?|numbers|texting)$/, '/telecom', 'phone & texting'],
  [/^(?:subscription|billing|plan)$/, '/subscription', 'your subscription'],
  [/^(?:lola|full screen|lola live)$/, '/lola-live', 'full-screen Lola'],
];

const PRONOUN = /^(?:me|us|her|him|them|it|back|someone|somebody|everyone|everybody|all|the salon|my clients|clients)$/i;
const WEEKDAY = '(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)';

/** "Hey Lola, could you please …" → "…" */
export function normalize(text) {
  return String(text || '')
    .replace(/[“”]/g, '"').replace(/[’]/g, "'")
    .trim()
    .replace(/^(?:(?:hey|hi|ok|okay|yo)\s+)?lola[,.!:]?\s*/i, '')
    .replace(/^(?:can you|could you|would you|will you|i need you to|i want you to|go ahead and|please)\s+/i, '')
    .replace(/^please\s+/i, '')
    .replace(/[\s.!?]+$/, '')
    .trim();
}

function cleanName(s) {
  const n = String(s || '').replace(/^(?:client|customer|my client)\s+/i, '').replace(/['’]s$/i, '').replace(/[.,!?]+$/, '').trim();
  if (!n || n.length > 48 || PRONOUN.test(n) || n.split(/\s+/).length > 4) return null;
  return n;
}

function dayOf(t) {
  const m = t.match(new RegExp(`\\b(today|tonight|tomorrow|yesterday|(?:next |this )?${WEEKDAY}|\\d{4}-\\d{2}-\\d{2})\\b`, 'i'));
  return m ? m[1].toLowerCase() : null;
}

export function routeOwnerIntent(input) {
  const raw = normalize(input);
  if (!raw) return null;
  const t = raw.toLowerCase();

  // ── go somewhere ──
  const nav = t.match(/^(?:open|go to|take me to|show(?: me)?|pull up|bring up|switch to|navigate to|jump to|let me see)\s+(?:up\s+)?(?:my |the |our )?(.+?)(?:\s+(?:page|screen|tab|view))?$/);
  if (nav) {
    const target = nav[1].trim();
    for (const [re, path, label] of PAGES) if (re.test(target)) return { navigate: path, say: `Opening ${label}.` };
  }

  // ── her own health ──
  if (/\b(run (?:a |your )?(?:check|diagnostic|self.?check|test)|diagnose yourself|test yourself|are you (?:ok|okay|working|alright)|is everything working|system check|status check)\b/.test(t)) return { self_check: true };

  // ── confirmations ──
  if (/\b(who(?:'?s| has| have)? (?:not |n'?t )?confirmed|who hasn'?t confirmed|confirmation status|any confirmations|how many confirmed)\b/.test(t)) return { tool: 'confirmation_status', args: { date: dayOf(t) || 'tomorrow' } };
  if (/\b(confirm (?:all )?(?:my |the |our )?(?:today'?s |tomorrow'?s )?(?:appointments|bookings|clients|schedule)|send (?:the |out )?confirmations?|ask (?:everyone|clients) to confirm)\b/.test(t)) return { tool: 'confirm_appointments', args: { date: dayOf(t) || 'tomorrow' } };

  // ── the day ──
  if (/\b(what did i miss|did i miss anything|anything i should know|while i was (?:out|away|gone)|what happened while)\b/.test(t)) return { tool: 'away_brief', args: {} };
  if (/\b(catch me up|brief me|morning brief|daily brief|give me (?:the|my) (?:rundown|brief|update)|how'?s (?:my|the) day|how is (?:my|the) day|what'?s (?:on )?(?:for )?today|what do (?:i|we) have today|what does (?:my|the) day look like|how are we doing today)\b/.test(t)) return { tool: 'today_brief', args: { date: 'today' } };
  if (/\b(who'?s (?:coming|booked|in)|who is (?:coming|booked)|what'?s (?:on )?(?:for )?tomorrow|tomorrow'?s (?:schedule|bookings|appointments)|what do (?:i|we) have tomorrow)\b/.test(t)) {
    return { tool: 'today_brief', args: { date: dayOf(t) || 'today' } };
  }

  // ── money ──
  if (/\b(how much (?:did|have|do) (?:we|i) (?:make|made|earn|earned|book|booked|bring in|brought in)|revenue|sales|money (?:today|this week|this month)|how'?s (?:business|revenue|the money))\b/.test(t) && !/\b(campaign|text|send)\b/.test(t)) {
    const period = /\bmonth\b/.test(t) ? 'month' : /\bweek\b/.test(t) ? 'week' : 'today';
    return { tool: 'revenue_report', args: { period } };
  }
  if (/\b(how (?:are|is|did) (?:my |the |our )?campaigns?|campaign (?:results|report|stats|performance))\b/.test(t)) return { tool: 'campaign_report', args: {} };
  if (/\b(30.day plan|fill plan|fill the chairs|plan to fill)\b/.test(t) && !/\b(open|go to|show me)\b/.test(t)) return { tool: 'fill_plan', args: { action: 'show' } };

  // ── reach a client ──
  const text = raw.match(/^(?:text|sms|message|send (?:a )?(?:text|message|sms) to)\s+(.+?)(?:\s*[:,–-]\s+|\s+(?:that|saying|and say|and tell (?:her|him|them)|to say|telling (?:her|him|them))\s+)(.+)$/i);
  if (text) {
    const client = cleanName(text[1]), message = text[2].trim();
    if (client && message.length >= 2) return { tool: 'text_client', args: { client, message } };
  }
  // "Text Maria I'm running late" — no separator: the capitalised words are the name.
  const bare = raw.match(/^(?:text|message)\s+(.+)$/i);
  if (bare && !text) {
    const words = bare[1].split(/\s+/), name = [];
    const NOT_NAME = /^(?:i|i'm|i'll|i've|i'd|we|we're|we'll|you|your|you're|hi|hey|hello|can|just|please|thanks|thank|the|so|good|see|running|reminder|happy|are|is|do|will|don't|sorry|tomorrow|today)$/i;
    while (words.length > 1 && name.length < 3 && /^[A-Z][\w'’-]*$/.test(words[0]) && !NOT_NAME.test(words[0])) name.push(words.shift());
    const client = cleanName(name.join(' ')), message = words.join(' ').trim();
    if (client && message.length >= 2) return { tool: 'text_client', args: { client, message } };
  }
  const call = raw.match(/^(?:call|ring|phone)\s+(.+?)(?:\s+(?:now|back|right now))?$/i) || raw.match(/^give\s+(.+?)\s+a\s+(?:call|ring)(?:\s+now)?$/i);
  if (call) {
    const client = cleanName(call[1]);
    if (client) return { tool: 'call_client', args: { client } };
  }

  // ── move the book ──
  const cancel = raw.match(/^cancel\s+(?:the\s+|an?\s+)?(?:appointment|booking)\s+(?:for|with)\s+(.+?)(?:\s+(?:on|for)\s+(.+))?$/i)
    || raw.match(/^cancel\s+(.+?)(?:'s|’s|s')?\s+(?:appointment|booking|visit|reservation)(?:\s+(?:for |on )?(.+))?$/i);
  if (cancel) { const client = cleanName(cancel[1]); if (client) return { tool: 'cancel_booking', args: { client, ...(cancel[2] ? { date: dayOf(cancel[2]) || cancel[2] } : {}) } }; }
  const move = raw.match(/^(?:move|reschedule|push)\s+(.+?)(?:'s|’s)?(?:\s+(?:appointment|booking))?\s+to\s+(.+?)\s+at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)$/i)
    || raw.match(/^(?:move|reschedule|push)\s+(.+?)(?:'s|’s)?(?:\s+(?:appointment|booking))?\s+to\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm))(?:\s+(?:on\s+)?(.+))?$/i);
  if (move) {
    const client = cleanName(move[1]);
    const isTimeFirst = /^\d/.test(move[2]);
    const new_time = isTimeFirst ? move[2] : move[3];
    const new_date = isTimeFirst ? (dayOf(move[3] || '') || 'today') : (dayOf(move[2]) || move[2]);
    if (client && new_time) return { tool: 'reschedule_booking', args: { client, new_date, new_time: new_time.replace(/\s+/g, '') } };
  }
  const noShow = raw.match(/^(?:mark\s+)?(.+?)\s+(?:as\s+)?(?:a\s+)?no[- ]?show$/i) || raw.match(/^(.+?)\s+(?:didn'?t|did not|never)\s+show(?:\s+up)?$/i);
  if (noShow) { const client = cleanName(noShow[1]); if (client) return { tool: 'mark_no_show', args: { client } }; }

  // ── look someone up ──
  const find = raw.match(/^(?:find|look up|lookup|search for|who is|tell me about|pull up)\s+(?:client\s+)?(.+)$/i);
  if (find) { const client = cleanName(find[1]); if (client && !/\b(time|slot|opening|gap)\b/i.test(client)) return { tool: 'find_client', args: { client } }; }

  return null;
}

/** The team member each action belongs to — shown on the orb as Lola works. */
export function agentFor(name) {
  if (/booking|no_show|waitlist|fill_gap|list_bookings|check_availability|book_|reschedule|cancel/.test(name)) return { id: 'booking', label: 'Booking' };
  if (/text|call|message/.test(name)) return { id: 'communications', label: 'Communications' };
  if (/campaign|fill_plan|learn|growth/.test(name)) return { id: 'marketing', label: 'Marketing' };
  if (/revenue|brief|away/.test(name)) return { id: 'operations', label: 'Operations' };
  if (/client/.test(name)) return { id: 'crm', label: 'CRM' };
  return { id: 'lola', label: 'Lola' };
}
