/**
 * api/lib/trial-guard.js — one free trial per salon.
 * ════════════════════════════════════════════════════════════════════
 * "14-day free trial, no card" stays true — but a salon can't restart it by
 * signing up again with another email. A salon is the same salon when ANY of
 * these match an existing workspace:
 *   • the salon's phone (Google listing phone, forwarded salon number, tenants.phone)
 *   • the owner's mobile (operator_phone / owner_phone)
 *   • the Google place id (knowledge.google.place_id)
 *   • the website domain (website_url / knowledge.google.website) — shared hosts
 *     (instagram, facebook, linktr.ee, booksy, vagaro …) never count
 *
 *   trialCheck(c, tenantOrFields, { excludeId })  → { duplicate, reason, match } | { duplicate:false }
 *   endTrial(c, tenant, reason)                    → trial_ends_at = now (account kept, no new trial)
 *   ipAllowed(c, ip, { now })                      → persisted per-IP sign-up limit (signup_attempts table)
 *   recordSignupAttempt(c, ip, meta)
 *
 * Never throws — a guard failure must never block a real salon.
 */

const SHARED_HOSTS = /(^|\.)(instagram\.com|facebook\.com|fb\.com|linktr\.ee|linkin\.bio|tiktok\.com|google\.com|goo\.gl|g\.page|maps\.app\.goo\.gl|business\.site|booksy\.com|vagaro\.com|fresha\.com|squareup\.com|square\.site|glossgenius\.com|styleseat\.com|schedulicity\.com|mindbodyonline\.com|yelp\.com|wixsite\.com|squarespace\.com|godaddysites\.com|weebly\.com|wordpress\.com|carrd\.co|beacons\.ai|loladesk\.com)$/i;

const digits10 = (v) => { const d = String(v || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''); return d.length === 10 ? d : null; };

export function domainOf(url) {
  try {
    const s = String(url || '').trim();
    if (!s) return null;
    const host = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s).hostname.toLowerCase().replace(/^www\./, '');
    if (!host.includes('.') || SHARED_HOSTS.test(host)) return null;
    return host;
  } catch (_) { return null; }
}

function knowledgeOf(t) {
  try { return typeof t?.knowledge === 'string' ? JSON.parse(t.knowledge || '{}') : (t?.knowledge || {}); } catch (_) { return {}; }
}

/** The identifying marks of a salon. */
export function fingerprint(t = {}) {
  const k = knowledgeOf(t);
  const g = k.google || {};
  const salon = new Set([t.salon_phone, t.salonPhone, g.phone, t.business_phone].map(digits10).filter(Boolean));
  const owner = new Set([t.operator_phone, t.owner_phone, t.ownerPhone, t.owner_mobile].map(digits10).filter(Boolean));
  const placeId = String(t.place_id || t.placeId || g.place_id || '').trim() || null;
  const domain = domainOf(t.website_url || t.websiteUrl || g.website);
  return { salon, owner, placeId, domain };
}

function sameSalon(a, b) {
  for (const p of a.salon) if (b.salon.has(p) || b.owner.has(p)) return 'salon_phone';
  for (const p of a.owner) if (b.owner.has(p) || b.salon.has(p)) return 'owner_phone';
  if (a.placeId && b.placeId && a.placeId === b.placeId) return 'google_place';
  if (a.domain && b.domain && a.domain === b.domain) return 'website';
  return null;
}

/**
 * Has this salon had a LolaDesk trial before (another workspace)?
 * Paying / comped workspaces count too — a paying salon doesn't get a second free trial.
 */
export async function trialCheck(c, t, { excludeId = null } = {}) {
  try {
    if (!c || !t) return { duplicate: false };
    const fp = fingerprint(t);
    if (!fp.salon.size && !fp.owner.size && !fp.placeId && !fp.domain) return { duplicate: false };
    const me = excludeId || t.id || null;
    const { data } = await c.from('tenants').select('id,name,operator_phone,owner_phone,website_url,knowledge,created_at,trial_ends_at,subscription_status').limit(10000);
    // Salon numbers that were forwarded to Lola are a strong mark too.
    let fwd = [];
    try { fwd = (await c.from('tenant_channels').select('tenant_id,account_id').eq('channel', 'forwarding').limit(10000)).data || []; } catch (_) {}
    const fwdBy = new Map();
    for (const f of fwd) { const d = digits10(f.account_id); if (d) { if (!fwdBy.has(f.tenant_id)) fwdBy.set(f.tenant_id, []); fwdBy.get(f.tenant_id).push(d); } }
    for (const other of data || []) {
      if (!other?.id || other.id === me) continue;
      const ofp = fingerprint(other);
      for (const d of fwdBy.get(other.id) || []) ofp.salon.add(d);
      const why = sameSalon(fp, ofp);
      if (why) return { duplicate: true, reason: why, match: { id: other.id, name: other.name || null } };
    }
    return { duplicate: false };
  } catch (_) { return { duplicate: false }; }
}

/** The account stays; the free trial is simply over. */
export async function endTrial(c, tenant, reason = 'repeat_trial') {
  try {
    if (!c || !tenant?.id) return false;
    const now = new Date().toISOString();
    let r = await c.from('tenants').update({ trial_ends_at: now, trial_denied_reason: reason }).eq('id', tenant.id);
    if (r?.error) r = await c.from('tenants').update({ trial_ends_at: now }).eq('id', tenant.id);
    return !r?.error;
  } catch (_) { return false; }
}

/**
 * Persisted per-IP brake (survives cold starts, unlike the in-memory one):
 * at most SIGNUP_IP_DAILY sign-ups per IP per 24h (default 5) and
 * SIGNUP_IP_TRIALS_30D trials per IP per 30 days (default 3).
 * → { allowed, trial } — allowed:false → refuse; trial:false → account without a new trial.
 */
export async function ipAllowed(c, ip, { now = Date.now(), env = process.env } = {}) {
  try {
    if (!c || !ip || ip === 'unknown') return { allowed: true, trial: true };
    const daily = Math.max(1, Number(env.SIGNUP_IP_DAILY) || 5);
    const trials = Math.max(1, Number(env.SIGNUP_IP_TRIALS_30D) || 3);
    const { data, error } = await c.from('signup_attempts').select('created_at,trial').eq('ip', ip).gte('created_at', new Date(now - 30 * 864e5).toISOString()).limit(500);
    if (error) return { allowed: true, trial: true };
    const rows = data || [];
    const day = rows.filter((r) => Date.parse(r.created_at) > now - 864e5).length;
    const trialCount = rows.filter((r) => r.trial !== false).length;
    return { allowed: day < daily, trial: trialCount < trials };
  } catch (_) { return { allowed: true, trial: true }; }
}

export async function recordSignupAttempt(c, ip, meta = {}) {
  try {
    if (!c || !ip) return;
    await c.from('signup_attempts').insert({ ip, email: meta.email || null, tenant_id: meta.tenant_id || null, trial: meta.trial !== false, created_at: new Date().toISOString() });
  } catch (_) {}
}

export default { trialCheck, endTrial, ipAllowed, recordSignupAttempt, fingerprint, domainOf };
