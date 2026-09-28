// Anonymous text-to-speech costs real money per character. Signed-in owners
// (Bearer token) speak freely; anonymous visitors (the landing page and the
// "hear your Lola" onboarding preview) get a per-address allowance.
// Instance-local by design: a cheap brake that needs no table, not a vault.
const WINDOW_MS = 60 * 60 * 1000;
const ANON_PER_HOUR = 30;
const hits = new Map();

export function clientIp(req) {
  return String(req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim() || 'unknown';
}
export function hasBearer(req) {
  const h = String(req.headers?.authorization || '');
  return /^Bearer\s+\S{20,}/i.test(h);
}
// true → allowed. Never throws.
export function allowAnonymousSpeech(req) {
  try {
    if (hasBearer(req)) return true;
    const ip = clientIp(req), now = Date.now();
    const list = (hits.get(ip) || []).filter(t => now - t < WINDOW_MS);
    if (list.length >= ANON_PER_HOUR) { hits.set(ip, list); return false; }
    list.push(now); hits.set(ip, list);
    if (hits.size > 5000) for (const [k, v] of hits) { if (!v.length || now - v[v.length - 1] > WINDOW_MS) hits.delete(k); }
    return true;
  } catch { return true; }
}
