/**
 * /api/lola/concierge — Lola on the sign-in page, for real.
 * POST { message, history:[{role:'user'|'lola', text}] }
 *   → { ok, reply, action }  action: none | show_signin | start_signup |
 *                                   call_me | reset_password | open_pricing
 * Her brain is Telnyx inference (lib/llm.js). Public, so: short inputs,
 * short history, per-IP limits, and she never handles passwords.
 */
import { chat } from '../lib/llm.js';

const ACTIONS = ['none', 'show_signin', 'start_signup', 'call_me', 'reset_password', 'open_pricing'];
const hits = new Map();
function limited(ip, max = 40, windowMs = 10 * 60e3) {
  const now = Date.now(), h = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  h.push(now); hits.set(ip, h); return h.length > max;
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
  const r = await chat({ system: SYSTEM, messages: [...history, { role: 'user', content: message }], maxTokens: 220, temperature: 0.5 });
  if (!r || !r.ok) return res.status(200).json({ ok: false, reply: "I can't think clearly right now. You can still sign in below.", action: 'show_signin' });
  let reply = '', action = 'none';
  const raw = String(r.text || '').trim();
  const m = raw.match(/\{[\s\S]*\}/);
  try { const j = JSON.parse(m ? m[0] : raw); reply = String(j.reply || ''); action = ACTIONS.includes(j.action) ? j.action : 'none'; }
  catch (_) { reply = raw.replace(/```[a-z]*|```/g, '').trim(); }
  reply = reply.replace(/[*_#`]/g, '').slice(0, 420) || 'How can I help?';
  return res.status(200).json({ ok: true, reply, action });
}
