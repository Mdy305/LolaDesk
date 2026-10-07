/**
 * api/lib/service-gate.js — is this salon's LolaDesk service on?
 * ════════════════════════════════════════════════════════════════════
 * ONE answer for every place that spends money on a salon's behalf (texts,
 * calls, campaigns, reminders, autopilot, rebooking, numbers):
 *
 *   await serviceAllowed(tenant)
 *     → { ok: true }
 *     → { ok: false, reason, say, since }
 *
 * RULES (same fields the paywall already uses — tenants.subscription_status,
 * billing_status, trial_ends_at, current_period_end, past_due_since):
 *   • billing_status 'suspended' (admin)                     → off  (suspended)
 *   • billing_status 'active'   (admin comp / activate)      → ON, whatever Stripe says
 *   • subscription 'active' | 'trialing' (Stripe trial)      → on
 *   • 'canceling'  → on until current_period_end, then off    (canceled)
 *   • 'past_due'   → on for 7 days from the first failure     (Stripe is still retrying),
 *                    then off                                 (unpaid)
 *   • 'unpaid' | 'incomplete_expired'                         → off  (unpaid)
 *   • 'canceled'   → on until current_period_end (if still ahead), then off (canceled)
 *   • LolaDesk trial ('trial' / empty): on while trial_ends_at is ahead, plus
 *     a 3-day grace after it; then off                        (trial_expired)
 *   • anything unknown / missing data                         → on (never strand a salon on a bug)
 *
 * `say` is a short, polite, CLIENT-facing sentence — it never mentions billing.
 * Must never throw.
 */

export const DAY = 864e5;
export const PAST_DUE_GRACE_DAYS = 7;
export const TRIAL_GRACE_DAYS = 3;

export const CLIENT_SAY = "The salon isn't taking requests through this line right now — please contact the salon directly and they'll take care of you.";

const t = (v) => { if (!v) return NaN; const n = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(n) ? n : NaN; };
const off = (reason, since = null) => ({ ok: false, reason, say: CLIENT_SAY, since: Number.isFinite(since) ? new Date(since).toISOString() : null });

/** Is the money autopilot on? Until BILLING_ENFORCE=1 only an admin suspension pauses Lola's calls
 *  and texts — an expired trial or a failed card never silences a live salon by surprise. (The
 *  booking paywall, lib/billing-gate.js, is separate and always on.) */
export function enforcing(env = process.env) { return String(env.BILLING_ENFORCE || '') === '1'; }

/** Synchronous core — pure, for code that can't await. */
export function serviceStatus(tenant, now = Date.now()) {
  const s = rawServiceStatus(tenant, now);
  if (s.ok || s.reason === 'suspended' || enforcing()) return s;
  return { ok: true, would_pause: s.reason, since: s.since };
}

/** The rules without the BILLING_ENFORCE switch (admin views show what WOULD happen). */
export function rawServiceStatus(tenant, now = Date.now()) {
  try {
    if (!tenant || typeof tenant !== 'object') return { ok: true };
    now = typeof now === 'number' ? now : t(now);
    if (!Number.isFinite(now)) now = Date.now();
    const billing = String(tenant.billing_status || '').toLowerCase();
    const sub = String(tenant.subscription_status || '').toLowerCase();
    const periodEnd = t(tenant.current_period_end);

    if (billing === 'suspended') return off('suspended', t(tenant.suspended_at));
    if (billing === 'active' || billing === 'comped' || billing === 'comp') return { ok: true, comped: true };

    if (sub === 'active' || sub === 'trialing') return { ok: true };
    if (sub === 'canceling') {
      if (Number.isFinite(periodEnd) && periodEnd < now) return off('canceled', periodEnd);
      return { ok: true };
    }
    if (sub === 'past_due') {
      const first = Number.isFinite(t(tenant.past_due_since)) ? t(tenant.past_due_since) : periodEnd;
      if (!Number.isFinite(first)) return { ok: true, grace: true };
      if (now - first > PAST_DUE_GRACE_DAYS * DAY) return off('unpaid', first + PAST_DUE_GRACE_DAYS * DAY);
      return { ok: true, grace: true, grace_until: new Date(first + PAST_DUE_GRACE_DAYS * DAY).toISOString() };
    }
    if (sub === 'unpaid' || sub === 'incomplete_expired') return off('unpaid', t(tenant.past_due_since) || periodEnd);
    if (sub === 'canceled' || sub === 'cancelled') {
      if (Number.isFinite(periodEnd) && periodEnd > now) return { ok: true };
      return off('canceled', Number.isFinite(periodEnd) ? periodEnd : t(tenant.canceled_at));
    }
    // LolaDesk's own (no-card) trial.
    if (!sub || sub === 'trial' || sub === 'incomplete') {
      const end = t(tenant.trial_ends_at);
      if (!Number.isFinite(end)) return { ok: true };
      if (now > end + TRIAL_GRACE_DAYS * DAY) return off('trial_expired', end + TRIAL_GRACE_DAYS * DAY);
      return now > end ? { ok: true, grace: true, grace_until: new Date(end + TRIAL_GRACE_DAYS * DAY).toISOString() } : { ok: true };
    }
    return { ok: true };
  } catch (_) { return { ok: true }; }
}

/**
 * serviceAllowed(tenant | tenantId) — async so callers can pass just an id.
 * Never throws; on any missing data → { ok: true }.
 */
export async function serviceAllowed(tenant, { now = Date.now() } = {}) {
  try {
    if (!tenant) return { ok: true };
    if (typeof tenant === 'string') {
      try {
        const { db } = await import('./db.js');
        const c = db();
        if (!c) return { ok: true };
        const { data } = await c.from('tenants').select('*').eq('id', tenant).maybeSingle();
        if (!data) return { ok: true };
        tenant = data;
      } catch (_) { return { ok: true }; }
    }
    return serviceStatus(tenant, now);
  } catch (_) { return { ok: true }; }
}

/** Owner-facing line for dashboards / pulse ("paused because …"). */
export function pausedBecause(reason) {
  switch (reason) {
    case 'trial_expired': return 'your free trial ended';
    case 'canceled': return 'your subscription ended';
    case 'unpaid': return "your last payment didn't go through";
    case 'suspended': return 'your account is suspended';
    default: return 'your plan is inactive';
  }
}

/** Filter a tenant list down to those whose service is on (for crons). */
export function allowedTenants(list, now = Date.now()) {
  return (list || []).filter((x) => serviceStatus(x, now).ok);
}

export default { serviceAllowed, serviceStatus, rawServiceStatus, enforcing, pausedBecause, allowedTenants, CLIENT_SAY };
