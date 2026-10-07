/**
 * /api/lola/concierge — Lola on the sign-in page, for real.
 * POST { message, history:[{role:'user'|'lola', text}] }
 *   → { ok, reply, action }  action: none | show_signin | start_signup |
 *                                   call_me | reset_password | open_pricing
 * Her brain is Telnyx inference (lib/llm.js). Public, so: short inputs,
 * short history, per-IP limits, and she never handles passwords.
 */
import { chat } from '../lib/llm.js';
import { db, recentDemoRequestsByPhone } from '../lib/db.js';
import { placeDemoCall } from '../lib/demo-call.js';

const ACTIONS = ['none', 'show_signin', 'start_signup', 'call_me', 'reset_password', 'open_pricing'];
const hits = new Map();
function limited(ip, max = 40, windowMs = 10 * 60e3) {
  const now = Date.now(), h = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  h.push(now); hits.set(ip, h); return h.length > max;
}

// Demo-call caps. In-memory per-IP brake first (works even without a database), then the
// demo_requests table: ≤5/hour and ≤10/day per address, and a platform-wide daily ceiling.
const callHits = new Map();
const DAY_MS = 24 * 3600e3;
export async function demoCallCapped(c, ip) {
  const now = Date.now();
  const mine = (callHits.get(ip) || []).filter((t) => now - t < DAY_MS);
  if (mine.filter((t) => now - t < 3600e3).length >= 5 || mine.length >= 10) { callHits.set(ip, mine); return 'That’s a lot of calls from here. Try again later.'; }
  mine.push(now); callHits.set(ip, mine);
  if (callHits.size > 5000) for (const [k, v] of callHits) if (!v.length || now - v[v.length - 1] > DAY_MS) callHits.delete(k);
  if (!c) return null;
  try {
    const since = (ms) => new Date(now - ms).toISOString();
    const [hour, day, all] = await Promise.all([
      c.from('demo_requests').select('id', { count: 'exact', head: true }).eq('ip', ip).gte('created_at', since(3600e3)),
      c.from('demo_requests').select('id', { count: 'exact', head: true }).eq('ip', ip).gte('created_at', since(DAY_MS)),
      c.from('demo_requests').select('id', { count: 'exact', head: true }).gte('created_at', since(DAY_MS)),
    ]);
    if ((hour?.count || 0) >= 5 || (day?.count || 0) >= 10) return 'That’s a lot of calls from here. Try again later.';
    const globalMax = Math.max(1, Number(process.env.DEMO_CALLS_PER_DAY || 200));
    if ((all?.count || 0) >= globalMax) return 'I’ve made a lot of demo calls today. Leave your number below and the team will call you.';
  } catch (_) {}
  return null;
}

const SYSTEM = `You are Lola, the AI front desk inside LolaDesk (loladesk.com), speaking with someone on the LolaDesk sign-in page. They may be a salon owner signing in, or someone curious about you.
What LolaDesk is: Lola answers a salon's, spa's or med spa's phone 24/7 on its own local number, books appointments straight into the salon's calendar (LolaDesk's calendar, or Boulevard, Square, Mindbody, Vagaro, Fresha, Google Calendar), texts confirmations, answers texts and website chat, fills open chairs with campaigns she plans and the owner approves, handles reviews, and runs checkout. Setup takes about five minutes: the owner gives her salon name, and Lola learns services, prices, team and hours from the website, menu or files. There is a 14-day free trial with no credit card.
How you speak: warm, confident, brief. One or two short sentences, because your words are spoken aloud. No lists, no markdown, no emojis. Never invent prices, features, discounts or promises; for prices, offer to open the pricing page.
You can DO things on this page. Choose one action:
- show_signin: they want to sign in or log in.
- reset_password: they forgot or can't remember their password, or sign-in keeps failing.
- start_signup: they want to try LolaDesk, set up their salon, or start a trial.
- call_me: they want to hear you on a real phone call (you will call their phone).
- open_pricing: they ask about price or plans.
- none: anything else.
Never ask for or repeat a password. You cannot sign anyone in by voice; you open the sign-in for them.
If they say the call never came, didn't ring, or ask you to call again, choose call_me.
Never say you did something (called, sent, booked) — the page does the action and tells them the result. Say what will happen, e.g. "Sure — what's your number?" or "Opening sign-in." 
Answer ONLY with JSON: {"reply":"...","action":"none"}`;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'ip';
  if (limited(ip)) return res.status(429).json({ ok: false, reply: 'I need a short breather. Try me again in a few minutes.', action: 'none' });
  const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const message = String(b.message || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  if (!message) return res.status(400).json({ ok: false, error: 'empty' });
  const history = (Array.isArray(b.history) ? b.history : []).slice(-8)
    .map((m) => ({ role: m && m.role === 'lola' ? 'assistant' : 'user', content: String(m && m.text || '').slice(0, 400) }))
    .filter((m) => m.content);
  // A phone number in what they said (or just before) + "call me" → actually call.
  const phoneIn = (t) => { const m = String(t || '').match(/(?:\+?1[\s.-]?)?\(?([2-9]\d{2})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})/); return m ? `+1${m[1]}${m[2]}${m[3]}` : null; };
  const userTurns = [message, ...(Array.isArray(b.history) ? b.history : []).filter((m) => m && m.role !== 'lola').map((m) => m.text).reverse()];
  const knownPhone = userTurns.map(phoneIn).find(Boolean) || phoneIn(b.phone) || null;
  const wantsCall = /\b(call (me|my (phone|cell|number))|ring me|call again|try again|didn'?t (ring|get|receive)|no call|never (rang|came|got))\b/i.test(message);
  if (wantsCall || (phoneIn(message) && /call|phone|ring/i.test(message + ' ' + userTurns.slice(1, 3).join(' ')))) {
    if (!knownPhone) return res.status(200).json({ ok: true, reply: 'Happy to call you. What’s your number? Type it below.', action: 'call_me' });
    const c = db();
    if (c && (await recentDemoRequestsByPhone(knownPhone, 60).catch(() => 0)) >= 3) return res.status(200).json({ ok: true, reply: 'I’ve called that number a few times already. Try again in an hour.', action: 'none' });
    // Real phone calls cost money: per-address (hour + day) and platform-wide daily caps, like /api/demo-call.
    const capped = await demoCallCapped(c, ip);
    if (capped) return res.status(200).json({ ok: true, reply: capped, action: 'none' });
    try { if (c) await c.from('demo_requests').insert({ phone_number: knownPhone, ip }); } catch (_) {}
    const r = c ? await placeDemoCall(c, knownPhone).catch(() => null) : null;
    if (r && r.ok) return res.status(200).json({ ok: true, reply: 'Calling you now — pick up and talk to me.', action: 'none', called: true, phone: knownPhone });
    return res.status(200).json({ ok: true, reply: (r && r.say) || 'I couldn’t place the call right now. Leave your number below and the team will call you.', action: 'call_me', called: false });
  }
  const r = await chat({ system: SYSTEM, messages: [...history, { role: 'user', content: message }], maxTokens: 220, temperature: 0.5, fast: true, deadlineMs: 9000 });
  if (!r || !r.ok) return res.status(200).json({ ok: false, reply: "I can't think clearly right now. You can still sign in below.", action: 'show_signin' });
  let reply = '', action = 'none';
  const raw = String(r.text || '').trim();
  const m = raw.match(/\{[\s\S]*\}/);
  try { const j = JSON.parse(m ? m[0] : raw); reply = String(j.reply || ''); action = ACTIONS.includes(j.action) ? j.action : 'none'; }
  catch (_) { reply = raw.replace(/```[a-z]*|```/g, '').trim(); }
  reply = reply.replace(/[*_#`]/g, '').slice(0, 420) || 'How can I help?';
  return res.status(200).json({ ok: true, reply, action });
}
