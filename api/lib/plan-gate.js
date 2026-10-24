/**
 * api/lib/plan-gate.js — the one line between Starter and Pro.
 * ════════════════════════════════════════════════════════════════
 * Starter is "for solo stylists and small studios" (index.html). Pro is "for
 * salons with a team". Until now nothing enforced that, so a $99 salon had every $399
 * feature and no reason to move up.
 *
 * The rule, kept to one sentence so it's obvious to an owner:
 *   On paid Starter, up to two stylists take appointments. A third is Pro.
 *
 *   · Free trial: no limit. Every salon tries the whole product, team and all.
 *   · Existing stylists are never removed or hidden. Only adding (or
 *     re-activating) one more on paid Starter asks for Pro.
 *   · Pro, Med-Spa, Enterprise: no limit.
 *   · Lola learning the salon (Teach Lola, platform sync) is not gated —
 *     only the owner adding someone by hand.
 */
import { normalizePlan } from './plans.js';

export const STARTER_STYLISTS = 2;

/** Has the salon chosen and paid for a plan (as opposed to the free trial)? */
export function onPaidPlan(t) {
  const s = String(t?.subscription_status || '').toLowerCase();
  if (['active', 'canceling', 'past_due', 'unpaid'].includes(s)) return true;
  if (s === 'trialing' && t?.stripe_subscription_id) return true; // checked out with trial days left
  return String(t?.billing_status || '').toLowerCase() === 'active';
}

/** How many bookable stylists this salon's plan allows. null = no limit. */
export function stylistLimit(t) {
  if (!onPaidPlan(t)) return null;
  return (normalizePlan(t?.plan) || 'starter') === 'starter' ? STARTER_STYLISTS : null;
}

/** The seeded "Any available team member" row isn't a person. */
export function isPlaceholderStaff(s) {
  return /^any( available)?( team)?( member| stylist)?$/i.test(String(s?.name || '').trim());
}

export const UPGRADE = {
  ok: false,
  error: 'upgrade_required',
  plan: 'pro',
  message: 'Starter covers two stylists. Move to Pro and Lola books your whole team. Everyone already on the book stays exactly as is.',
  upgrade_url: '/subscription?upgrade=pro',
};

/**
 * May the owner add one more active stylist? Never throws; on any read
 * error it allows (never block an owner because of our own hiccup).
 * → { ok: true } | UPGRADE
 */
export async function canAddStylist(c, tenant) {
  const limit = stylistLimit(tenant);
  if (limit == null || !c || !tenant?.id) return { ok: true };
  try {
    const { data, error } = await c.from('staff').select('*').eq('tenant_id', tenant.id).limit(200);
    if (error) return { ok: true };
    const people = (data || []).filter((s) => s.is_active !== false && s.active !== false && !isPlaceholderStaff(s)).length;
    return people >= limit ? { ...UPGRADE } : { ok: true };
  } catch { return { ok: true }; }
}
