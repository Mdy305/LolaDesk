/**
 * api/lib/platform-admin.js — the platform owner's numbers and switches, shared by
 * /api/admin (the technical Command page) and /api/console (LolaDesk Console).
 * ════════════════════════════════════════════════════════════════════
 *   platformSnapshot(c)                 → { metrics, tenants, raw } — exactly what GET /api/admin returns
 *                                          (+ raw: the tenant rows, for the console's extra views)
 *   setBillingStatus(c, tenant_id, act) → { status, body } — exactly what POST /api/admin returns
 *
 * Suspend flips billing_status only — data is never touched. 'activate' = billing_status 'active':
 * the salon is treated as PAID (comped / paid offline) by the paywall and the service gate, whatever
 * Stripe says. 'unsuspend' / 'uncomp' return it to normal Stripe rules.
 */
import { feeSummary } from './booking-fees.js';
import { mrrCents, normalizePlan } from './plans.js';
import { costCents, dollars } from './costs.js';
import { serviceStatus } from './service-gate.js';

export const PAYING = ['active', 'canceling', 'past_due'];
export const BILLING_NEXT = { suspend: 'suspended', activate: 'active', unsuspend: 'trial', uncomp: 'trial' };

export async function platformSnapshot(c) {
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const d = new Date(); const monthStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
  const [tenants, msgsToday, callsToday, bookingsToday, costRows, feeRows] = await Promise.all([
    c.from('tenants')
      .select('*')
      .order('created_at', { ascending: false }).limit(500)
      .then(r => r.data || []),
    c.from('messages').select('id', { count: 'exact' }).gte('created_at', midnight.toISOString()).limit(1)
      .then(r => r.count ?? 0).catch(() => 0),
    c.from('calls').select('id', { count: 'exact' }).gte('created_at', midnight.toISOString()).limit(1)
      .then(r => r.count ?? 0).catch(() => 0),
    c.from('bookings').select('id', { count: 'exact' }).gte('created_at', midnight.toISOString()).limit(1)
      .then(r => r.count ?? 0).catch(() => 0),
    (() => { let q = c.from('usage_events').select('tenant_id,kind,units,metadata').gte('created_at', monthStart);
             if (typeof q.like === 'function') q = q.like('kind', 'cost_%');
             return Promise.resolve(q.limit(50000)).then(r => (r?.data || []).filter(e => /^cost_/.test(String(e.kind || ''))), () => []); })(),
    c.from('booking_fees').select('tenant_id,status,fee_cents').eq('period', monthStart.slice(0, 7)).limit(50000)
      .then(r => r.data || [], () => [])
  ]);
  const costBy = {}, feeBy = {};
  let costTotal = 0;
  for (const e of costRows) { const cents = costCents(e); costBy[e.tenant_id] = (costBy[e.tenant_id] || 0) + cents; costTotal += cents; }
  for (const f of feeRows) if (['pending', 'earned', 'billed'].includes(f.status)) feeBy[f.tenant_id] = (feeBy[f.tenant_id] || 0) + (Number(f.fee_cents) || 0);
  const byPlan = {}, byStatus = {}, byBilling = {};
  let mrr = 0, paying = 0;
  const roster = tenants.map(t => {
    const plan = normalizePlan(t.plan) || t.plan || 'none';
    const sub = t.subscription_status || 'trial';
    byPlan[plan] = (byPlan[plan] || 0) + 1;
    byStatus[sub] = (byStatus[sub] || 0) + 1;
    byBilling[t.billing_status || 'trial'] = (byBilling[t.billing_status || 'trial'] || 0) + 1;
    const tMrr = PAYING.includes(String(t.subscription_status || '')) ? mrrCents(plan, t.billing_interval) : 0;
    if (tMrr) { mrr += tMrr; paying++; }
    const cost = costBy[t.id] || 0, fees = feeBy[t.id] || 0;
    const svc = serviceStatus(t);
    return {
      id: t.id, slug: t.slug, name: t.name, owner_email: t.owner_email, plan, billing_status: t.billing_status || 'trial',
      subscription_status: sub, billing_interval: t.billing_interval || null, trial_ends_at: t.trial_ends_at || null,
      current_period_end: t.current_period_end || null, phone_number: t.phone_number, business_mode: t.business_mode, created_at: t.created_at,
      service: svc.ok ? 'on' : svc.reason,
      mrr_cents: tMrr, fees_cents: fees, cost_cents: cost, cost_dollars: dollars(cost), margin_cents: tMrr + fees - cost, margin_dollars: dollars(tMrr + fees - cost)
    };
  });
  const bookingFees = await feeSummary(c).catch(() => null);
  const feesTotal = Object.values(feeBy).reduce((a, b) => a + b, 0);
  return {
    metrics: { tenants: tenants.length, by_plan: byPlan, by_status: byStatus, by_billing_status: byBilling,
               paying, mrr_cents: mrr, mrr_dollars: dollars(mrr), arr_dollars: dollars(mrr * 12),
               costs_cents: costTotal, costs_dollars: dollars(costTotal), fees_cents: feesTotal,
               margin_cents: mrr + feesTotal - costTotal, margin_dollars: dollars(mrr + feesTotal - costTotal), month_start: monthStart,
               messages_today: msgsToday, calls_today: callsToday, bookings_today: bookingsToday,
               booking_fees: bookingFees },
    tenants: roster,
    raw: tenants,
  };
}

/** Comp / Uncomp / Suspend / Unsuspend. → { status, body } (the HTTP answer /api/admin has always given). */
export async function setBillingStatus(c, tenant_id, action) {
  if (!tenant_id || !BILLING_NEXT[action])
    return { status: 400, body: { ok: false, error: 'action must be suspend|activate|unsuspend|uncomp with tenant_id' } };
  const { data, error } = await c.from('tenants')
    .update({ billing_status: BILLING_NEXT[action] })
    .eq('id', tenant_id).select('id,slug,name,billing_status').maybeSingle();
  if (error || !data) return { status: 404, body: { ok: false, error: 'tenant not found' } };
  return { status: 200, body: { ok: true, tenant: data } };
}
