/**
 * /api/admin — the platform owner's control plane
 * ════════════════════════════════════════════════════════════════
 * For YOU (the LolaDesk operator), not for salons. Hard-gated:
 * the session's email must appear in the ADMIN_EMAILS env var
 * (comma-separated, case-insensitive). No env var set → nobody is
 * admin → 403 for everyone. Tenant owners can never reach this.
 *
 *   GET  /api/admin            → platform metrics + tenant roster
 *        metrics.by_status   — by subscription_status (what Stripe says: trial / active / past_due …)
 *        metrics.by_billing_status — the admin flags (suspended / active = comped)
 *        metrics.mrr_cents   — MRR from lib/plans.js amounts of paying subscriptions
 *                              (annual counted at its monthly equivalent)
 *        metrics.costs_cents / margin_cents — this month: MRR + booking fees − platform costs
 *        tenants[].mrr_cents / cost_cents / margin_cents / service
 *   POST /api/admin {action:'suspend'|'activate'|'unsuspend'|'uncomp', tenant_id}
 *
 * Suspend flips billing_status only — data is never touched.
 * 'activate' = billing_status 'active': the salon is treated as PAID
 * (comped / paid offline) by the paywall and the service gate, whatever
 * Stripe says. 'unsuspend' / 'uncomp' return it to normal Stripe rules.
 */
import { bearer, getUserFromToken, isAdminEmail } from './lib/auth.js';
import { db } from './lib/db.js';
import { feeSummary } from './lib/booking-fees.js';
import { mrrCents, normalizePlan } from './lib/plans.js';
import { costCents, dollars } from './lib/costs.js';
import { serviceStatus } from './lib/service-gate.js';

const PAYING = ['active', 'canceling', 'past_due'];

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if(req.method === 'OPTIONS') return res.status(200).end();

  const user = await getUserFromToken(bearer(req));
  if(!user) return res.status(401).json({ ok:false, error:'Not signed in' });
  if(!isAdminEmail(user.email)) return res.status(403).json({ ok:false, error:'Not authorized' });

  const c = db();
  if(!c) return res.status(503).json({ ok:false, error:'Database not configured' });

  if(req.method === 'GET'){
    const midnight = new Date(); midnight.setHours(0,0,0,0);
    const d = new Date(); const monthStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
    const [tenants, msgsToday, callsToday, bookingsToday, costRows, feeRows] = await Promise.all([
      c.from('tenants')
        .select('*')
        .order('created_at', { ascending:false }).limit(500)
        .then(r => r.data || []),
      c.from('messages').select('id', { count:'exact' }).gte('created_at', midnight.toISOString()).limit(1)
        .then(r => r.count ?? 0).catch(()=>0),
      c.from('calls').select('id', { count:'exact' }).gte('created_at', midnight.toISOString()).limit(1)
        .then(r => r.count ?? 0).catch(()=>0),
      c.from('bookings').select('id', { count:'exact' }).gte('created_at', midnight.toISOString()).limit(1)
        .then(r => r.count ?? 0).catch(()=>0),
      (() => { let q = c.from('usage_events').select('tenant_id,kind,units,metadata').gte('created_at', monthStart);
               if(typeof q.like === 'function') q = q.like('kind', 'cost_%');
               return Promise.resolve(q.limit(50000)).then(r => (r?.data || []).filter(e => /^cost_/.test(String(e.kind||''))), () => []); })(),
      c.from('booking_fees').select('tenant_id,status,fee_cents').eq('period', monthStart.slice(0, 7)).limit(50000)
        .then(r => r.data || [], () => [])
    ]);
    const costBy = {}, feeBy = {};
    let costTotal = 0;
    for(const e of costRows){ const cents = costCents(e); costBy[e.tenant_id] = (costBy[e.tenant_id] || 0) + cents; costTotal += cents; }
    for(const f of feeRows) if(['pending','earned','billed'].includes(f.status)) feeBy[f.tenant_id] = (feeBy[f.tenant_id] || 0) + (Number(f.fee_cents) || 0);
    const byPlan = {}, byStatus = {}, byBilling = {};
    let mrr = 0, paying = 0;
    const roster = tenants.map(t => {
      const plan = normalizePlan(t.plan) || t.plan || 'none';
      const sub = t.subscription_status || 'trial';
      byPlan[plan] = (byPlan[plan] || 0) + 1;
      byStatus[sub] = (byStatus[sub] || 0) + 1;
      byBilling[t.billing_status || 'trial'] = (byBilling[t.billing_status || 'trial'] || 0) + 1;
      const tMrr = PAYING.includes(String(t.subscription_status || '')) ? mrrCents(plan, t.billing_interval) : 0;
      if(tMrr){ mrr += tMrr; paying++; }
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
    const bookingFees = await feeSummary(c).catch(()=>null);
    const feesTotal = Object.values(feeBy).reduce((a, b) => a + b, 0);
    return res.status(200).json({ ok:true,
      metrics: { tenants: tenants.length, by_plan: byPlan, by_status: byStatus, by_billing_status: byBilling,
                 paying, mrr_cents: mrr, mrr_dollars: dollars(mrr), arr_dollars: dollars(mrr * 12),
                 costs_cents: costTotal, costs_dollars: dollars(costTotal), fees_cents: feesTotal,
                 margin_cents: mrr + feesTotal - costTotal, margin_dollars: dollars(mrr + feesTotal - costTotal), month_start: monthStart,
                 messages_today: msgsToday, calls_today: callsToday, bookings_today: bookingsToday,
                 booking_fees: bookingFees },
      tenants: roster });
  }

  if(req.method === 'POST'){
    const body = typeof req.body === 'string' ? JSON.parse(req.body||'{}') : (req.body||{});
    const { action, tenant_id } = body;
    const NEXT = { suspend:'suspended', activate:'active', unsuspend:'trial', uncomp:'trial' };
    if(!tenant_id || !NEXT[action])
      return res.status(400).json({ ok:false, error:'action must be suspend|activate|unsuspend|uncomp with tenant_id' });
    const { data, error } = await c.from('tenants')
      .update({ billing_status: NEXT[action] })
      .eq('id', tenant_id).select('id,slug,name,billing_status').maybeSingle();
    if(error || !data) return res.status(404).json({ ok:false, error:'tenant not found' });
    return res.status(200).json({ ok:true, tenant: data });
  }

  return res.status(405).json({ ok:false });
}
