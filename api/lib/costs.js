/**
 * api/lib/costs.js — every dollar LolaDesk pays on a salon's behalf.
 * ════════════════════════════════════════════════════════════════════
 *   await logCost(tenantId, 'cost_number_month', 100, { phone_number })
 *
 * Writes one usage_events row: kind 'cost_*', units = CENTS (integer),
 * metadata { unit: 'cents', ... }. (The usage_events columns are units /
 * metadata — "quantity" and "meta" in the spec.) Never throws.
 *
 * Older rows (before this file) logged a COUNT in units with no unit tag;
 * costCents() converts those with the same default prices, so admin totals
 * stay honest across the switch.
 *
 * Prices (cents) — env overrides, Telnyx list-price defaults:
 *   TELNYX_NUMBER_CENTS           100   local number, per month
 *   TELNYX_PORT_CENTS             100   per ported number (one-time)
 *   TELNYX_10DLC_BRAND_CENTS      400   brand registration (one-time)
 *   TELNYX_10DLC_VETTING_CENTS   4000   secondary vetting (one-time, if used)
 *   TELNYX_10DLC_CAMPAIGN_CENTS  1000   campaign vetting fee (one-time, TCR $15 ≈ passed at list)
 *   TELNYX_10DLC_CAMPAIGN_MONTH_CENTS 200  campaign, per month (low-volume mixed / standard)
 *   WHATSAPP_TEMPLATE_CENTS         0   template submission (Meta charges per conversation, not per template)
 *   TELNYX_ESIM_CENTS             500   eSIM, per month
 */
const n = (v, d) => { const x = Number(v); return Number.isFinite(x) && x >= 0 ? Math.round(x) : d; };

export function costPrices(env = process.env) {
  return {
    cost_number_month: n(env.TELNYX_NUMBER_CENTS, 100),
    cost_number_purchase: n(env.TELNYX_NUMBER_CENTS, 100),
    cost_port: n(env.TELNYX_PORT_CENTS, 100),
    cost_10dlc_brand: n(env.TELNYX_10DLC_BRAND_CENTS, 400),
    cost_10dlc_vetting: n(env.TELNYX_10DLC_VETTING_CENTS, 4000),
    cost_10dlc_campaign: n(env.TELNYX_10DLC_CAMPAIGN_CENTS, 1000),
    cost_10dlc_campaign_month: n(env.TELNYX_10DLC_CAMPAIGN_MONTH_CENTS, 200),
    cost_whatsapp_template: n(env.WHATSAPP_TEMPLATE_CENTS, 0),
    cost_esim_month: n(env.TELNYX_ESIM_CENTS, 500),
  };
}

/** Default price (cents) for one unit of a cost kind; 0 when unknown. */
export function priceCents(kind, env = process.env) {
  return costPrices(env)[kind] ?? 0;
}

/** Cents of one usage_events row (new rows: units are cents; legacy rows: units are a count). */
export function costCents(row, env = process.env) {
  if (!row || !/^cost_/.test(String(row.kind || ''))) return 0;
  const units = Number(row.units ?? row.quantity ?? 0) || 0;
  const md = row.metadata || row.meta || {};
  if (md && md.unit === 'cents') return Math.round(units);
  return Math.round(units * priceCents(row.kind, env));
}

export async function logCost(tenantId, kind, cents, meta = {}) {
  try {
    if (!tenantId) return { ok: false, skipped: 'no_tenant' };
    const k = String(kind || '').startsWith('cost_') ? String(kind) : 'cost_' + String(kind || 'other');
    const amount = Math.max(0, Math.round(Number(cents) || 0));
    const { db } = await import('./db.js');
    const c = db();
    if (!c) return { ok: false, skipped: 'no_db' };
    const r = await c.from('usage_events').insert({ tenant_id: tenantId, kind: k, units: amount, metadata: { unit: 'cents', ...(meta || {}) } });
    return { ok: !r?.error, error: r?.error?.message };
  } catch (e) { return { ok: false, error: String(e?.message || e) }; }
}

/** Sum cost rows → { by_kind_cents, total_cents, by_tenant_cents }. */
export function sumCosts(rows, env = process.env) {
  const by_kind_cents = {}, by_tenant_cents = {};
  let total_cents = 0;
  for (const r of rows || []) {
    if (!/^cost_/.test(String(r?.kind || ''))) continue;
    const c = costCents(r, env);
    by_kind_cents[r.kind] = (by_kind_cents[r.kind] || 0) + c;
    if (r.tenant_id) by_tenant_cents[r.tenant_id] = (by_tenant_cents[r.tenant_id] || 0) + c;
    total_cents += c;
  }
  return { by_kind_cents, by_tenant_cents, total_cents };
}

export const dollars = (cents) => Math.round(Number(cents) || 0) / 100;

export default { logCost, costCents, priceCents, costPrices, sumCosts, dollars };
