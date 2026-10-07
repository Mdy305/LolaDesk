/**
 * api/lib/rent.js — monthly line costs (what LolaDesk pays) and add-on rent
 * (what the salon pays), accrued once a month and billed on the next invoice.
 * ════════════════════════════════════════════════════════════════════
 * Included in every plan: the plan's numbers (lib/plans.js numbers — Starter 1,
 * Pro 1, Med-Spa 2). Only lines BEYOND the plan, and eSIMs, are rent.
 *
 *   accrueMonthly(c, { now })   once per calendar month per line (idempotent, safe daily):
 *     • cost_number_month   (cents, every live Lola line — trial salons too: LolaDesk pays)
 *     • cost_esim_month     (cents: active $2.00 / standby $0.20)
 *     • number_rent         (cents, retail, paying salons' extra lines only)
 *     • esim_rent           (cents, retail, paying salons with an active eSIM)
 *   billRent(c, tenant, { now, bill })   unbilled number_rent / esim_rent / esim_data_overage
 *     → ONE Stripe invoice item (rides the next LolaDesk invoice), rows marked billed.
 *
 * Old rows (logged in dollars by telnyx-numbers / telnyx-esim before this file)
 * are read as dollars; new rows carry metadata.unit = 'cents'.
 *
 * ENV (all optional): TELNYX_NUMBER_CENTS (100), TELNYX_ESIM_CENTS (200 active),
 *   TELNYX_ESIM_STANDBY_CENTS (20), NUMBER_RETAIL_MONTHLY (5 $), ESIM_RETAIL_MONTHLY (15 $)
 */
import { createHash } from 'node:crypto';
import { logCost } from './costs.js';
import { numberLimit } from './plans.js';
import { serviceStatus } from './service-gate.js';

const monthKey = (d) => new Date(d).toISOString().slice(0, 7);
const monthStart = (d) => { const x = new Date(d); return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), 1)).toISOString(); };
const n = (v, d) => { const x = Number(v); return Number.isFinite(x) && x >= 0 ? x : d; };
export const RENT_KINDS = ['number_rent', 'esim_rent', 'esim_data_overage'];

export function rentPrices(env = process.env) {
  return {
    number_cost: Math.round(n(env.TELNYX_NUMBER_CENTS, 100)),
    esim_cost: Math.round(n(env.TELNYX_ESIM_CENTS, 200)),
    esim_standby_cost: Math.round(n(env.TELNYX_ESIM_STANDBY_CENTS, 20)),
    number_retail: Math.round(n(env.NUMBER_RETAIL_MONTHLY, 5) * 100),
    esim_retail: Math.round(n(env.ESIM_RETAIL_MONTHLY, 15) * 100),
  };
}

/** Paying (not trial, service on). Comped salons are not billed rent. */
export function paying(t) {
  const s = String(t?.subscription_status || '').toLowerCase();
  return ['active', 'canceling', 'past_due'].includes(s) && serviceStatus(t).ok;
}

export function rentCents(row) {
  const md = row?.metadata || {};
  const u = Number(row?.units) || 0;
  return md.unit === 'cents' ? Math.round(u) : Math.round(u * 100);
}

async function rows(q) { try { const r = await q; return r?.data || []; } catch { return []; } }

export async function accrueMonthly(c, { now = new Date(), env = process.env } = {}) {
  const out = { period: monthKey(now), number_costs: 0, esim_costs: 0, number_rent: 0, esim_rent: 0, errors: 0 };
  if (!c) return out;
  const P = rentPrices(env);
  const since = monthStart(now);
  const [tenants, numbers, esims, logged] = await Promise.all([
    rows(c.from('tenants').select('*').limit(10000)),
    rows(c.from('tenant_numbers').select('tenant_id,phone_number,status,kind,created_at').limit(20000)),
    rows(c.from('integrations').select('tenant_id,status,metadata').eq('provider', 'telnyx_esim').limit(5000)),
    rows(c.from('usage_events').select('tenant_id,kind,metadata').in('kind', ['cost_number_month', 'cost_esim_month', 'number_rent', 'esim_rent']).gte('created_at', since).limit(50000)),
  ]);
  const seen = new Set(logged.map((e) => `${e.tenant_id}|${e.kind}|${e.metadata?.phone_number || e.metadata?.sim_card_id || ''}`));
  const linesBy = new Map();
  for (const r of numbers) {
    if (!r?.tenant_id || !r.phone_number || ['released', 'parked'].includes(String(r.status || ''))) continue;
    if (!linesBy.has(r.tenant_id)) linesBy.set(r.tenant_id, []);
    const list = linesBy.get(r.tenant_id);
    if (!list.some((x) => x.phone_number === r.phone_number)) list.push(r);
  }
  for (const t of tenants) {
    if (!t?.id) continue;
    const list = linesBy.get(t.id) || [];
    if (t.phone_number && !list.some((x) => x.phone_number === t.phone_number)) list.push({ phone_number: t.phone_number, kind: 'primary' });
    if (!list.length) continue;
    try {
      list.sort((a, b) => (a.kind === 'primary' ? -1 : 0) - (b.kind === 'primary' ? -1 : 0));
      const limit = numberLimit(t.plan);
      for (let i = 0; i < list.length; i++) {
        const num = list[i].phone_number;
        if (!seen.has(`${t.id}|cost_number_month|${num}`)) {
          await logCost(t.id, 'cost_number_month', P.number_cost, { phone_number: num, accrual: out.period });
          seen.add(`${t.id}|cost_number_month|${num}`); out.number_costs++;
        }
        if (i >= limit && paying(t) && !seen.has(`${t.id}|number_rent|${num}`)) {
          await c.from('usage_events').insert({ tenant_id: t.id, kind: 'number_rent', units: P.number_retail, metadata: { unit: 'cents', phone_number: num, accrual: out.period, extra_line: true } });
          seen.add(`${t.id}|number_rent|${num}`); out.number_rent++;
        }
      }
    } catch (_) { out.errors++; }
  }
  const tById = new Map(tenants.map((t) => [t.id, t]));
  for (const e of esims) {
    const sim = e?.metadata?.sim_card_id;
    if (!e?.tenant_id || !sim) continue;
    try {
      const active = String(e.status || '') !== 'suspended';
      if (!seen.has(`${e.tenant_id}|cost_esim_month|${sim}`)) {
        await logCost(e.tenant_id, 'cost_esim_month', active ? P.esim_cost : P.esim_standby_cost, { sim_card_id: sim, accrual: out.period, standby: !active });
        out.esim_costs++;
      }
      const t = tById.get(e.tenant_id);
      if (active && t && paying(t) && !seen.has(`${e.tenant_id}|esim_rent|${sim}`)) {
        await c.from('usage_events').insert({ tenant_id: e.tenant_id, kind: 'esim_rent', units: P.esim_retail, metadata: { unit: 'cents', sim_card_id: sim, accrual: out.period } });
        out.esim_rent++;
      }
    } catch (_) { out.errors++; }
  }
  return out;
}

/** Bill one salon's unbilled rent as a single Stripe invoice item. */
export async function billRent(c, tenant, { now = new Date(), bill = rentInvoiceItem } = {}) {
  const out = { billed: 0, cents: 0 };
  if (!c || !tenant?.id || !tenant.stripe_customer_id) return out;
  const list = (await rows(c.from('usage_events').select('*').eq('tenant_id', tenant.id).in('kind', RENT_KINDS).limit(2000)))
    // Only rows this accrual wrote (metadata.unit 'cents'): older usage rows logged a count for every
    // salon's included first line and must never turn into a surprise invoice.
    .filter((r) => r.metadata?.unit === 'cents' && !r.metadata?.billed_at && !r.metadata?.unbillable);
  if (!list.length) return out;
  const cents = list.reduce((s, r) => s + rentCents(r), 0);
  if (!cents) return out;
  const item = await bill(tenant, list, cents);
  if (!item?.id) return out;
  for (const r of list) {
    await c.from('usage_events').update({ metadata: { ...(r.metadata || {}), billed_at: now.toISOString(), stripe_invoice_item_id: item.id } }).eq('id', r.id);
  }
  out.billed = list.length; out.cents = cents;
  return out;
}

export async function rentInvoiceItem(tenant, list, cents) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set');
  const nums = list.filter((r) => r.kind === 'number_rent').length, sims = list.filter((r) => r.kind !== 'number_rent').length;
  const what = [nums ? `${nums} extra line${nums === 1 ? '' : 's'}` : '', sims ? `eSIM (${sims})` : ''].filter(Boolean).join(' + ');
  const body = new URLSearchParams({
    customer: tenant.stripe_customer_id, amount: String(cents), currency: 'usd',
    description: `LolaDesk — ${what || 'add-ons'}`,
    'metadata[tenant_id]': tenant.id, 'metadata[kind]': 'rent', 'metadata[count]': String(list.length),
  });
  const idem = 'rent_' + createHash('sha256').update(list.map((r) => r.id).sort().join(',')).digest('hex').slice(0, 40);
  const r = await fetch('https://api.stripe.com/v1/invoiceitems', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': idem }, body });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error?.message || `Stripe ${r.status}`);
  return d;
}

/** Daily: bill rent for every paying salon (BOOKING_FEES_LIVE switch, same as fees). */
export async function runRentBilling(c, { now = new Date(), live = false, bill = rentInvoiceItem } = {}) {
  const out = { live, tenants_billed: 0, items: 0, cents: 0, errors: [] };
  if (!live || !c) return out;
  const tenants = await rows(c.from('tenants').select('*').in('subscription_status', ['active', 'past_due', 'canceling']).limit(10000));
  for (const t of tenants) {
    if (!t.stripe_customer_id) continue;
    try { const r = await billRent(c, t, { now, bill }); if (r.billed) { out.tenants_billed++; out.items += r.billed; out.cents += r.cents; } }
    catch (e) { out.errors.push({ tenant: t.id, error: String(e?.message || e).slice(0, 200) }); }
  }
  return out;
}

export default { accrueMonthly, billRent, runRentBilling, rentPrices, paying, rentCents };
