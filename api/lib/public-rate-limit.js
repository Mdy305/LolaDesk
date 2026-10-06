/**
 * api/lib/public-rate-limit.js — limits for the public booking endpoints
 * (lookup / cancel / reschedule / book / hold / client_lookup …).
 *
 *   • limitPublicShared — the one calendar.js uses: hits are counted in the
 *     public_rate_hits table, so every serverless instance shares one count
 *     (a script can't dodge the limit by landing on a fresh instance). Falls
 *     back to per-instance memory when the table isn't there yet.
 *   • limitPublic       — the original synchronous, per-instance fixed window
 *     (kept for callers that can't await, e.g. api/widget/client-lookup.js).
 *   • activeHoldsFor / noteHold — how many live holds a device (or a client)
 *     already has, so nobody can hold a salon's whole day.
 */
import { db } from './db.js';
import { sharedHit, resetBookingIntegrity } from './booking-integrity.js';

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
  hold: [20, 10 * 60e3],
  client_lookup: [8, 10 * 60e3],
  deposit_quote: [40, 10 * 60e3],
  waitlist_add: [10, 10 * 60e3],
};

export function limitPublic(req, action, tenantKey = ''){
  const rule = PUBLIC_LIMITS[action];
  if(!rule) return true;
  return allow(`${action}:${tenantKey}:${clientIp(req)}`, rule[0], rule[1]);
}

/** Shared across instances (public_rate_hits); memory fallback. Resolves true when allowed. */
export async function limitPublicShared(req, action, tenantKey = ''){
  const rule = PUBLIC_LIMITS[action];
  if(!rule) return true;
  // The cheap local window still applies first (no DB round trip for an obvious flood).
  if(!limitPublic(req, action, tenantKey)) return false;
  try{ return await sharedHit(`rl:${action}:${tenantKey}:${clientIp(req)}`, rule[0], rule[1]); }
  catch(_){ return true; }
}

// ── holds per device / per client ─────────────────────────────────────────
export const PUBLIC_HOLD_TTL_MAX_S = 300;
export const PUBLIC_MAX_ACTIVE_HOLDS = 2;
export const holdRequesterKey = (req) => 'ip:' + clientIp(req);

const memHolds = new Map(); // requester -> [{ hold_token, expires_at, created_at }]
export function noteHold(requester, hold){
  if(!requester || !hold?.hold_token) return;
  const now = Date.now();
  const list = (memHolds.get(requester) || []).filter(h => new Date(h.expires_at).getTime() > now);
  list.push({ hold_token: hold.hold_token, expires_at: hold.expires_at, created_at: hold.created_at || new Date().toISOString() });
  memHolds.set(requester, list);
  if(memHolds.size > MAX_KEYS) memHolds.clear();
}

/** Live (active, unexpired) holds for a requester key or a client, oldest first. */
export async function activeHoldsFor(tenantId, { requester = null, clientId = null } = {}){
  const now = Date.now();
  const c = db();
  if(c && (requester || clientId)){
    let q = c.from('availability_holds').select('id,hold_token,expires_at,created_at,status').eq('tenant_id', tenantId).eq('status', 'active')
      .gt('expires_at', new Date(now).toISOString());
    q = requester ? q.eq('requester', requester) : q.eq('client_id', clientId);
    const { data, error } = await q;
    if(!error) return (data || []).sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
  }
  if(!requester) return [];
  // Pre-migration (no requester column): this instance's memory of its own holds — re-checked
  // against the table, so a released / converted hold (or another salon's) never counts.
  const mine = (memHolds.get(requester) || []).filter(h => new Date(h.expires_at).getTime() > now);
  if(!mine.length || !c) return mine;
  try{
    const { data, error } = await c.from('availability_holds').select('hold_token,expires_at,created_at,status')
      .eq('tenant_id', tenantId).in('hold_token', mine.map(h => h.hold_token));
    if(error) return [];
    const live = new Set((data || []).filter(h => h.status === 'active' && new Date(h.expires_at).getTime() > now).map(h => h.hold_token));
    return mine.filter(h => live.has(h.hold_token));
  }catch(_){ return []; }
}

/** Tests: forget every count (memory, and the shared ledger rows). */
export function resetRateLimits(){
  buckets.clear(); memHolds.clear();
  try{ resetBookingIntegrity(); }catch(_){}
  try{ const c = db(); if(c) c.from('public_rate_hits').delete().lt('at', '9999-12-31T00:00:00.000Z').then(() => {}, () => {}); }catch(_){}
}
