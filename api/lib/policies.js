// Deposit + fee calculators. Central so the widget, the backend, and the
// preview endpoint all agree on the same math. Never diverge these three.
import { db } from './db.js';

// Load a tenant's policies (creates default row if missing so callers can
// rely on a non-null return).
export async function loadPolicies(tenant_id) {
  const c = db();
  let { data } = await c.from('billing_policies').select('*').eq('tenant_id', tenant_id).maybeSingle();
  if (!data) {
    const { data: inserted } = await c.from('billing_policies').insert({ tenant_id }).select().single();
    data = inserted;
  }
  return data;
}

// Compute the deposit for a specific service, respecting per-service override
// and the global policy tier ($250+ = premium).
export function depositFor(service, policies) {
  if (!service || !policies) return 0;
  const price = Number(service.price || 0);
  if (service.deposit_override_type === 'none') return 0;
  if (service.deposit_override_type === 'fixed') return Math.max(0, Math.round(Number(service.deposit_override_amount || 0)));
  if (service.deposit_override_type === 'percent') return Math.max(0, Math.round(price * Number(service.deposit_override_amount || 0) / 100));
  const p = policies.deposits || {};
  if (!p.enabled) return 0;
  let amt;
  if (p.type === 'percent') amt = Math.round(price * Number(p.amount || 0) / 100);
  else amt = Number(p.amount || 0);
  if (price >= 250 && p.premium_amount) amt = Number(p.premium_amount);
  if (p.min_amount && amt < Number(p.min_amount)) amt = Number(p.min_amount);
  return Math.max(0, Math.round(amt));
}

// Compute no-show fee for a booking against policy.
export function noShowFee(booking, service, policies) {
  const p = policies?.no_show || {};
  if (!p.enabled) return 0;
  const price = Number(service?.price || 0);
  const deposit_applied = Number(booking?.deposit_applied || 0);
  if (p.type === 'full') return Math.max(0, Math.round(price - deposit_applied));
  if (p.type === 'percent') return Math.max(0, Math.round(price * Number(p.amount || 0) / 100));
  return Math.max(0, Math.round(Number(p.amount || 0)));
}

// Late-cancel fee.
export function lateCancelFee(policies) {
  const p = policies?.late_cancel || {};
  if (!p.enabled) return 0;
  return Math.max(0, Math.round(Number(p.amount || 0)));
}

// Preview handler used by banking-policies.html's sticky save bar.
// Given a proposed policy shape, project against the last 30 days of real
// data (bookings + no-shows + payments) and return the estimated uplift.
export async function previewPolicy(tenant_id, proposed) {
  const c = db();
  const since = new Date(Date.now() - 30 * 86400000).toISOString();

  const { data: services } = await c.from('services').select('id,price,category').eq('tenant_id', tenant_id);
  const svcById = Object.fromEntries((services || []).map(s => [s.id, s]));

  const { data: bookings } = await c.from('bookings')
    .select('id, service_id, outcome, deposit_applied, start_time, no_show_fee_charged')
    .eq('tenant_id', tenant_id)
    .gte('start_time', since);
  const rows = bookings || [];

  let depositsCollected = 0;
  let noShowRecovered = 0;
  let noShowCount = 0;
  for (const b of rows) {
    const svc = svcById[b.service_id];
    if (!svc) continue;
    depositsCollected += depositFor(svc, proposed);
    if (String(b.outcome || '').toLowerCase() === 'no_show') {
      noShowCount++;
      noShowRecovered += noShowFee(b, svc, proposed);
    }
  }

  // Actual tips-and-payments totals for the tips micro projection.
  const { data: pays } = await c.from('payments')
    .select('kind, amount')
    .eq('tenant_id', tenant_id)
    .gte('created_at', since);
  const paylist = pays || [];
  const tipsPaid = paylist.filter(p => p.kind === 'tip').reduce((s,p) => s + Number(p.amount||0), 0);
  const chargeCount = paylist.filter(p => p.kind === 'charge').length || 1;
  const avgTip = Math.round(tipsPaid / chargeCount);

  // Rough projected uplift: sum of deposits + no-show recoveries.
  // Not the same as revenue — depositsCollected already applies to service
  // when the client shows up. This preview surfaces incremental $ owner
  // would have captured vs. current policy.
  const projected_monthly_uplift = depositsCollected + noShowRecovered;

  return {
    currency: 'usd',
    deposits: {
      collected: depositsCollected,
      prevented_loss: Math.round(depositsCollected * 0.4)  // industry deltas — 30–60% no-show drop
    },
    no_show: {
      count: noShowCount,
      recovered: noShowRecovered
    },
    tips: {
      avg: avgTip
    },
    projected_monthly_uplift
  };
}
