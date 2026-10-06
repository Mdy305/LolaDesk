// Anonymous text-to-speech costs real money per character. Signed-in owners
// (a Bearer token that VERIFIES as a real LolaDesk user) get a generous
// per-user allowance; everyone else (the landing page and the "hear your Lola"
// onboarding preview) gets a strict per-address allowance. A made-up
// "Bearer xxxxxxxx…" header is just an anonymous caller.
// Instance-local by design: a cheap brake that needs no table, not a vault.
import { getUserFromToken, bearer } from './auth.js';

const WINDOW_MS = 60 * 60 * 1000;
const ANON_PER_HOUR = 30;
const OWNER_PER_HOUR = 600;
const hits = new Map();

export function clientIp(req) {
  return String(req.headers?.['x-forwarded-for'] || req.headers?.['x-real-ip'] || req.socket?.remoteAddress || '').split(',')[0].trim() || 'unknown';
}
/** Syntactic check only — NEVER use it to grant anything. Kept for callers that only log. */
export function hasBearer(req) {
  const h = String(req.headers?.authorization || '');
  return /^Bearer\s+\S{20,}/i.test(h);
}

function take(key, limit, now = Date.now()) {
  const list = (hits.get(key) || []).filter(t => now - t < WINDOW_MS);
  if (list.length >= limit) { hits.set(key, list); return false; }
  list.push(now); hits.set(key, list);
  if (hits.size > 5000) for (const [k, v] of hits) { if (!v.length || now - v[v.length - 1] > WINDOW_MS) hits.delete(k); }
  return true;
}

/** The verified signed-in user behind the request's Bearer token, or null. Never throws. */
export async function speechUser(req) {
  try {
    if (req.__lolaSpeechUser !== undefined) return req.__lolaSpeechUser;
    const tok = bearer(req);
    const u = tok ? await getUserFromToken(tok).catch(() => null) : null;
    req.__lolaSpeechUser = u || null;
    return req.__lolaSpeechUser;
  } catch { return null; }
}

// Strict per-address allowance for anonymous callers. true → allowed. Never throws.
export function allowAnonymousSpeech(req) {
  try { return take('ip:' + clientIp(req), ANON_PER_HOUR); } catch { return true; }
}

// true → allowed. A verified owner gets a per-user allowance; anyone else the per-IP one.
export async function allowSpeech(req) {
  const user = await speechUser(req);
  if (user && (user.id || user.email)) {
    try { return take('user:' + (user.id || user.email), OWNER_PER_HOUR); } catch { return true; }
  }
  return allowAnonymousSpeech(req);
}
