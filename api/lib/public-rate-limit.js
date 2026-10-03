/**
 * api/lib/public-rate-limit.js — basic per-IP limits for the public booking
 * endpoints (lookup / cancel / reschedule / book / client_lookup).
 *
 * In-memory, per serverless instance: it stops a single browser or script
 * from hammering confirmation codes or phone lookups from one warm instance.
 * It is deliberately simple (fixed window) — not a distributed limiter.
 */
const buckets = new Map();
const MAX_KEYS = 20000;

export function clientIp(req){
  const h = req?.headers || {};
  const fwd = String(h['x-forwarded-for'] || h['x-real-ip'] || '').split(',')[0].trim();
  return fwd || req?.socket?.remoteAddress || 'unknown';
}

/** true when allowed; false when the caller is over `limit` hits in `windowMs`. */
export function allow(key, limit, windowMs, now = Date.now()){
  let b = buckets.get(key);
  if(!b || now - b.start >= windowMs){
    if(buckets.size > MAX_KEYS){ for(const [k, v] of buckets){ if(now - v.start >= windowMs) buckets.delete(k); } if(buckets.size > MAX_KEYS) buckets.clear(); }
    b = { start: now, n: 0 };
    buckets.set(key, b);
  }
  b.n += 1;
  return b.n <= limit;
}

// Per action: [hits, window]. Generous for real people, tight for scripts.
export const PUBLIC_LIMITS = {
  lookup: [20, 10 * 60e3],
  cancel: [10, 10 * 60e3],
  reschedule: [15, 10 * 60e3],
  book: [12, 10 * 60e3],
  hold: [60, 10 * 60e3],
  client_lookup: [8, 10 * 60e3],
  deposit_quote: [40, 10 * 60e3],
  waitlist_add: [10, 10 * 60e3],
};

export function limitPublic(req, action, tenantKey = ''){
  const rule = PUBLIC_LIMITS[action];
  if(!rule) return true;
  return allow(`${action}:${tenantKey}:${clientIp(req)}`, rule[0], rule[1]);
}

export function resetRateLimits(){ buckets.clear(); }
