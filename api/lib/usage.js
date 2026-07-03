/**
 * api/lib/usage.js — Usage aggregation against plan quotas
 * ════════════════════════════════════════════════════════════════
 * Sums this billing-period's usage_events per tenant, compares
 * against their plan's quotas (lib/plans.js), and returns a simple
 * shape the dashboard can render as a warning banner.
 *
 * This is intentionally NOT an enforcement/throttling layer — going
 * over quota never blocks a call or text from being answered. Lola
 * should never refuse to help a client because of a billing limit;
 * that would be a terrible failure mode (a missed call is exactly
 * what this product exists to prevent). It's purely informational:
 * surface it to the owner so they can upgrade before they're
 * unknowingly costing you margin on overage.
 */
import { db } from './db.js';
import { planFor, USAGE_LABELS } from './plans.js';

// Start of the current calendar month, UTC. Simple and predictable;
// swap for actual Stripe billing-period anchors later if plans ever
// start mid-month and quotas should reset on signup date instead.
function periodStart(){
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

/**
 * Returns: {
 *   plan, quotas, usage: { voice_call: 42, sms_sent: 310, ai_token: 1850 },
 *   percentages: { voice_call: 28, sms_sent: 62, ai_token: 92 },
 *   mostUsedKind: 'ai_token', mostUsedPercent: 92,
 *   nearLimit: boolean (>=80% on any tracked kind),
 *   overLimit: boolean (>=100% on any tracked kind)
 * }
 * Returns null if usage can't be computed (no DB, no tenant, enterprise plan).
 */
export async function getUsageStatus(tenantId, planSlug){
  const plan = planFor(planSlug);
  if(!plan.quotas) return null; // enterprise / custom — never soft-capped
  const c = db();
  if(!c || !tenantId) return null;

  const since = periodStart();
  const kinds = Object.keys(plan.quotas);
  const { data, error } = await c.from('usage_events')
    .select('kind, units')
    .eq('tenant_id', tenantId)
    .in('kind', kinds)
    .gte('created_at', since);
  if(error) return null;

  const usage = Object.fromEntries(kinds.map(k => [k, 0]));
  for(const row of (data || [])){
    if(usage[row.kind] !== undefined) usage[row.kind] += Number(row.units || 1);
  }

  const percentages = {};
  let mostUsedKind = kinds[0], mostUsedPercent = 0;
  for(const k of kinds){
    const pct = plan.quotas[k] ? Math.round((usage[k] / plan.quotas[k]) * 100) : 0;
    percentages[k] = pct;
    if(pct > mostUsedPercent){ mostUsedPercent = pct; mostUsedKind = k; }
  }

  return {
    plan: planSlug, planName: plan.name, quotas: plan.quotas,
    usage, percentages, mostUsedKind, mostUsedPercent,
    mostUsedLabel: USAGE_LABELS[mostUsedKind] || mostUsedKind,
    nearLimit: mostUsedPercent >= 80,
    overLimit: mostUsedPercent >= 100,
    periodStart: since
  };
}
