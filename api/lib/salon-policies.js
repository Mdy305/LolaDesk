/**
 * api/lib/salon-policies.js — ONE home for a salon's deposit / no-show /
 * late-cancel / tip policy: booking_settings.metadata.deposits.
 *
 * Before, Settings → Booking rules wrote booking_settings.metadata.deposits
 * (read by Lola and the deposits job) while Banking → Policies wrote a separate
 * billing_policies row (read only by widget/book and no-show-scan) — two
 * switches for one rule that never agreed. Now both pages read and write
 * metadata.deposits; /api/tenant/billing-policies maps to and from it.
 *
 * Stored shape (metadata.deposits):
 *   enabled, type:'percent'|'fixed', percent, fixed_cents, min_cents,
 *   premium_value, premium_threshold, hold_minutes, who, grace_minutes   ← lib/deposits.js resolvePolicy
 *   no_show:     { enabled, type, amount, fee_cents, delay_minutes, waive_first_offense }
 *   late_cancel: { enabled, window_hours, amount, fee_cents }
 *   tips:        { enabled, presets, default_index, suggest_when, base_on }
 *   auto_charge: { deposit_on_booking, no_show_fee, late_cancel_fee, retry_failed, rebook_nudge }
 *
 * The browser copy of this mapping lives in banking-policies.html (same names).
 */

export const POLICY_DEFAULTS = Object.freeze({
  deposits: { enabled: false, type: 'percent', amount: 25, premium_amount: 0, min_amount: 0, hold_minutes: 0, who: 'everyone' },
  no_show: { enabled: false, type: 'fixed', amount: 50, delay_minutes: 15, waive_first_offense: false },
  late_cancel: { enabled: false, window_hours: 24, amount: 25 },
  tips: { enabled: true, presets: [15, 18, 20, 25], default_index: 1, suggest_when: 'checkout', base_on: 'service' },
  auto_charge: { deposit_on_booking: false, no_show_fee: false, late_cancel_fee: false, retry_failed: true, rebook_nudge: false },
});

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

/** metadata.deposits → the Banking → Policies shape (plus the legacy API fields other readers use). */
export function policiesFromMetadata(dep, legacy = null) {
  const d = obj(dep), L = obj(legacy);
  const type = d.type === 'fixed' ? 'fixed' : 'percent';
  const hasDeposit = Object.keys(d).some((k) => !['no_show', 'late_cancel', 'tips', 'auto_charge'].includes(k));
  const legacyDep = obj(L.deposits);
  const deposits = hasDeposit ? {
    enabled: d.enabled === true,
    type,
    amount: type === 'fixed' ? num(d.fixed_cents) / 100 : num(d.percent, 25),
    premium_amount: num(d.premium_value),
    min_amount: num(d.min_cents) / 100,
    hold_minutes: num(d.hold_minutes),
    who: ['risky', 'flaky'].includes(d.who) ? d.who : 'everyone',
    grace_minutes: num(d.grace_minutes),
  } : { ...POLICY_DEFAULTS.deposits, ...legacyDep };
  if (!hasDeposit && legacyDep.mode && legacyDep.amount == null) {
    deposits.type = legacyDep.mode === 'fixed' ? 'fixed' : 'percent';
    deposits.amount = deposits.type === 'fixed' ? num(legacyDep.fixed_cents) / 100 : num(legacyDep.percent, 25);
  }
  // Legacy response fields (kept for older readers of /api/tenant/billing-policies).
  deposits.mode = deposits.type;
  deposits.percent = deposits.type === 'percent' ? num(deposits.amount, 25) : num(d.percent, 25);
  deposits.fixed_cents = deposits.type === 'fixed' ? Math.round(num(deposits.amount) * 100) : num(d.fixed_cents);
  deposits.services = 'all';

  const no_show = { ...POLICY_DEFAULTS.no_show, ...obj(L.no_show), ...obj(d.no_show) };
  if (no_show.fee_cents != null && obj(d.no_show).amount == null && obj(L.no_show).amount == null) no_show.amount = num(no_show.fee_cents) / 100;
  no_show.fee_cents = Math.round(num(no_show.amount) * 100);
  no_show.charge_after_minutes = num(no_show.delay_minutes, 15);

  const late_cancel = { ...POLICY_DEFAULTS.late_cancel, ...obj(L.late_cancel), ...obj(d.late_cancel) };
  if (late_cancel.hours_before != null && obj(d.late_cancel).window_hours == null) late_cancel.window_hours = num(late_cancel.hours_before, 24);
  late_cancel.hours_before = num(late_cancel.window_hours, 24);
  late_cancel.fee_cents = Math.round(num(late_cancel.amount) * 100);

  const tips = { ...POLICY_DEFAULTS.tips, ...obj(L.tips), ...obj(d.tips) };
  if (!Array.isArray(tips.presets) && Array.isArray(tips.suggested_percents)) tips.presets = tips.suggested_percents;
  tips.suggested_percents = Array.isArray(tips.presets) ? tips.presets.slice(0, 3) : [15, 18, 20];

  const auto_charge = { ...POLICY_DEFAULTS.auto_charge, ...obj(L.auto_charge), ...obj(d.auto_charge) };
  auto_charge.enabled = !!(auto_charge.deposit_on_booking || auto_charge.no_show_fee || auto_charge.late_cancel_fee);
  return { deposits, no_show, late_cancel, tips, auto_charge };
}

/** Banking → Policies shape → metadata.deposits (merged over what's stored, so no field is lost). */
export function metadataFromPolicies(p, prev = {}) {
  const P = obj(p), D = obj(P.deposits), was = obj(prev);
  const type = (D.type || D.mode) === 'fixed' ? 'fixed' : (D.type || D.mode) === 'percent' ? 'percent' : (was.type === 'fixed' ? 'fixed' : 'percent');
  const amount = D.amount != null ? num(D.amount) : (type === 'fixed' ? (D.fixed_cents != null ? num(D.fixed_cents) / 100 : num(was.fixed_cents) / 100) : num(D.percent ?? was.percent, 25));
  const out = { ...was };
  if (Object.keys(D).length) {
    Object.assign(out, {
      enabled: D.enabled != null ? D.enabled === true : was.enabled === true,
      type,
      percent: type === 'percent' ? Math.max(1, Math.min(100, Math.round(amount || 25))) : num(was.percent, 25),
      fixed_cents: type === 'fixed' ? Math.max(0, Math.round(amount * 100)) : num(was.fixed_cents),
      premium_value: D.premium_amount != null ? Math.max(0, num(D.premium_amount)) : num(was.premium_value),
      min_cents: D.min_amount != null ? Math.max(0, Math.round(num(D.min_amount) * 100)) : num(was.min_cents),
      hold_minutes: D.hold_minutes != null ? Math.max(0, Math.min(1440, Math.round(num(D.hold_minutes)))) : num(was.hold_minutes),
      who: ['risky', 'flaky', 'everyone'].includes(D.who) ? D.who : (was.who || 'everyone'),
    });
    if (D.grace_minutes != null) out.grace_minutes = Math.max(0, Math.round(num(D.grace_minutes)));
  }
  const pick = (src, keys) => { const o = {}; for (const k of keys) if (src[k] !== undefined) o[k] = src[k]; return o; };
  if (P.no_show) {
    const n = { ...obj(was.no_show), ...pick(obj(P.no_show), ['enabled', 'type', 'amount', 'delay_minutes', 'waive_first_offense']) };
    if (P.no_show.amount == null && P.no_show.fee_cents != null) n.amount = num(P.no_show.fee_cents) / 100;
    if (P.no_show.delay_minutes == null && P.no_show.charge_after_minutes != null) n.delay_minutes = num(P.no_show.charge_after_minutes);
    n.enabled = n.enabled === true; n.fee_cents = Math.round(num(n.amount) * 100);
    out.no_show = n;
  }
  if (P.late_cancel) {
    const l = { ...obj(was.late_cancel), ...pick(obj(P.late_cancel), ['enabled', 'window_hours', 'amount']) };
    if (P.late_cancel.window_hours == null && P.late_cancel.hours_before != null) l.window_hours = num(P.late_cancel.hours_before);
    if (P.late_cancel.amount == null && P.late_cancel.fee_cents != null) l.amount = num(P.late_cancel.fee_cents) / 100;
    l.enabled = l.enabled === true; l.fee_cents = Math.round(num(l.amount) * 100);
    out.late_cancel = l;
  }
  if (P.tips) out.tips = { ...obj(was.tips), ...pick(obj(P.tips), ['enabled', 'presets', 'default_index', 'suggest_when', 'base_on']) };
  if (P.auto_charge) out.auto_charge = { ...obj(was.auto_charge), ...pick(obj(P.auto_charge), ['deposit_on_booking', 'no_show_fee', 'late_cancel_fee', 'retry_failed', 'rebook_nudge']) };
  return out;
}

/** The salon's policies, from the one source (legacy billing_policies only fills gaps never saved since). */
export async function readSalonPolicies(c, tenantId) {
  const { data: row } = await c.from('booking_settings').select('metadata').eq('tenant_id', tenantId).maybeSingle();
  const dep = obj(obj(row && row.metadata).deposits);
  let legacy = null;
  if (!dep.no_show || !dep.late_cancel) {
    try { const { data } = await c.from('billing_policies').select('*').eq('tenant_id', tenantId).maybeSingle(); legacy = data ? (data.policies || data) : null; } catch (_) { legacy = null; }
  }
  return policiesFromMetadata(dep, legacy);
}

/** Save into metadata.deposits (merging, never clobbering other metadata keys). Returns the stored deposits object. */
export async function writeSalonPolicies(c, tenantId, policies) {
  const { data: row } = await c.from('booking_settings').select('tenant_id,metadata').eq('tenant_id', tenantId).maybeSingle();
  const md = obj(row && row.metadata);
  const deposits = metadataFromPolicies(policies, obj(md.deposits));
  const metadata = { ...md, deposits };
  const r = row
    ? await c.from('booking_settings').update({ metadata }).eq('tenant_id', tenantId)
    : await c.from('booking_settings').insert({ tenant_id: tenantId, metadata });
  if (r && r.error) throw r.error;
  return deposits;
}
