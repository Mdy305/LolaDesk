/**
 * api/lib/human-touch.js — what makes Lola feel like a person, not a program.
 * ════════════════════════════════════════════════════════════════════════
 * One craft, every surface: the phone and website Lola (appended to her Telnyx
 * instructions under HUMAN_MARK), the owner's Lola in the app and by text, the
 * client brain (texts, DMs, web chat) and LolaDesk's own support line.
 *
 *   humanCraft({ audience, channel }) → the conversation craft for a prompt
 *   humanize(text, { channel })       → strips what no person says ("Certainly!",
 *                                       "As an AI…", "Is there anything else…"),
 *                                       markdown on spoken/texted channels, and
 *                                       exclamation storms — never the facts.
 *
 * Honesty is part of being human: she still says she's an AI when asked, and
 * the recorded-call disclosure in her greeting is never touched here.
 */

export const HUMAN_MARK = '[LolaDesk human]';

const CRAFT_CORE = [
  'Listen first. Answer what they actually asked, in their words ("trim" stays "trim"), before anything else.',
  'Feel the room: rushed → be brief and fast; worried or upset → slow down, own it, then fix it ("Oh no, I\'m sorry — let\'s sort it out."); excited → share it.',
  'Talk like a person: contractions, short sentences, one thought at a time, ONE question at a time. Vary how you start — never the same opener twice in a row.',
  'Small human touches, sparingly: "mm, got it", "okay, perfect", "oh nice", a light laugh when something is funny. Never fake typing sounds or stalling.',
  'Remember and refer back: a name, what they said a minute ago, what you know from before. That is what listening sounds like.',
  'Be specific: a real time, a real price, a real name — never "various options" or "some availability".',
  'Never say: "Certainly!", "Absolutely!", "Great question", "I\'d be happy to", "As an AI", "I understand your concern", "I apologize for any inconvenience", "Is there anything else I can help you with?", "Feel free to…". Say what a warm, sharp person at a great salon would say instead.',
  'When something can\'t be done, say what CAN be done, in the same breath.',
  'End the moment cleanly: a clear next step or a warm close ("See you Friday, Maria!") — not a menu of offers.',
];

/** The phone + website Lola (Telnyx assistant): appended once to her instructions. */
export const HUMAN_RULES = `\n\n${HUMAN_MARK}\n${CRAFT_CORE.map((l) => '- ' + l).join('\n')}\n- On the phone: say times and prices the way people do ("two thirty", "a hundred and twenty"), never read lists, never spell out links. If you didn't catch something, say so simply ("Sorry, I missed that — what day?").\n- If they ask whether you're a real person, say warmly that you're the salon's AI assistant — and keep helping.`;

/**
 * The craft as a prompt block.
 * audience: 'client' (a salon's client) | 'owner' (the salon owner) | 'support' (LolaDesk's own line)
 * channel: 'voice' | 'sms' | 'chat' | 'app'
 */
export function humanCraft({ audience = 'client', channel = 'chat' } = {}) {
  const lines = [...CRAFT_CORE];
  if (audience === 'owner') {
    lines.push('With the owner you are a trusted right hand, not a help desk: candid, on their side, a step ahead. If they sound stressed, say the one thing that helps most first.');
    lines.push('When something in LolaDesk isn\'t working or you can\'t do what they ask, say so plainly and offer to pass it to the LolaDesk team (contact_support) — never leave them stuck.');
  }
  if (audience === 'support') lines.push('They may be frustrated with the software: acknowledge it in one line, then get them unstuck or to the team.');
  if (channel === 'voice') lines.push('This is spoken aloud: no lists, no markdown, no links, no emojis; one to three short sentences.');
  else if (channel === 'sms') lines.push('This is a text message: plain text, no markdown, short — like a person texting, not an email.');
  return `HOW YOU SOUND HUMAN:\n${lines.map((l) => '- ' + l).join('\n')}`;
}

// What no person at a front desk says. Order matters: whole-sentence fillers first, then openers.
const DROP_SENTENCES = [
  /\bis there anything else (?:i can (?:help|do) (?:you )?with|you(?:'d| would) like(?: me to help with)?|i can help you with)(?: today)?\s*\??/gi,
  /\b(?:please )?(?:don['’]?t hesitate to|feel free to) (?:reach out|ask|let me know|contact (?:us|me))[^.!?]*[.!?]?/gi,
  /\bi hope (?:this|that) helps[.!]?/gi,
  /\bas an ai(?: language model| assistant)?,?\s*(?:i\s+(?:don['’]?t|do not|can['’]?t|cannot)[^.!?,]*(?:,\s*but\s+|[.!?]\s*))?/gi,
  /\bi apologi[sz]e for any inconvenience(?: (?:this|that) (?:may have )?caused)?[.!]?/gi,
];
const OPENERS = /^(?:(?:certainly|absolutely|of course|sure thing|great question|that['’]?s a great question|excellent question|good question|i['’]?d be (?:happy|glad|delighted) to help(?: (?:you )?with that)?|i['’]?m (?:happy|glad) to help(?: with that)?)[!.,—–-]*\s+)+/i;
const SWAPS = [
  [/\bI understand your (?:concern|frustration)s?[.,]?\s*/gi, ''],
  [/\bI apologi[sz]e\b/g, 'I\'m sorry'],
  [/\bplease be advised that\s*/gi, ''],
  [/\bkindly\s+/gi, ''],
  [/\butilize\b/gi, 'use'],
];

/** Strip markdown that would be read aloud or show as symbols in a text. */
function plain(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1')
    .replace(/(^|\s)\*([^*\n]+)\*(?=\s|[.,!?]|$)/g, '$1$2')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, '')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1 $2')
    .replace(/`([^`]+)`/g, '$1');
}

/**
 * humanize — clean a reply so it sounds like Lola, not a model. Never changes facts, numbers,
 * names, times or links; only filler, markdown (on voice/sms) and punctuation storms.
 * channel: 'voice' | 'sms' strip markdown and join lines; 'app' / 'chat' keep line breaks.
 */
export function humanize(text, { channel = 'chat' } = {}) {
  const original = String(text || '').trim();
  if (!original) return original;
  let t = original;
  for (const re of DROP_SENTENCES) t = t.replace(re, ' ');
  for (const [re, to] of SWAPS) t = t.replace(re, to);
  t = t.replace(OPENERS, '');
  if (channel === 'voice' || channel === 'sms') t = plain(t).replace(/\s*\n+\s*/g, ' ');
  else t = t.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/^\s{0,3}#{1,6}\s+/gm, '');   // the app shows plain text: no stray ** or #
  t = t.replace(/!{2,}/g, '!').replace(/\?{2,}/g, '?').replace(/\.{4,}/g, '…');
  // At most two exclamation marks in one reply — warmth, not a cheerleader.
  let bangs = 0;
  t = t.replace(/!/g, () => (++bangs > 2 ? '.' : '!'));
  t = t.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+([.,!?])/g, '$1').replace(/([.!?])\s*[.,]+/g, '$1').trim();
  t = t.replace(/^[,.;:]+\s*/, '');
  if (t && /^[a-z]/.test(t)) t = t[0].toUpperCase() + t.slice(1);
  // Never return something emptier than what came in (a reply that was only filler keeps its words).
  return t.length >= 2 ? t : original;
}
