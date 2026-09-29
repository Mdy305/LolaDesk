/**
 * api/lib/booking-fees.js — LolaDesk earns on every appointment Lola books.
 * ════════════════════════════════════════════════════════════════════
 * The ledger (booking_fees, sql/booking-fees.sql) gets one row per booking,
 * never two (unique booking_id):
 *
 *   pending  → the appointment is booked and hasn't happened yet
 *   earned   → the appointment time passed and it wasn't cancelled/no-show
 *   billed   → added to the salon's next LolaDesk invoice (Stripe invoice item)
 *   void     → cancelled or no-show before it was billed (the salon pays nothing)
 *   waived   → booked while the salon was on its free trial
 *
 * What counts ("scope"):
 *   lola (default) — bookings Lola brought in: phone, texts, the website/Google
 *                    widget, campaigns, waitlist, gap-fill, rebooking offers.
 *                    Bookings the owner types in, or that sync in from another
 *                    platform, are never charged.
 *   all            — every booking except ones synced in from another platform.
 *
 * Price, from Vercel env (decide later — nothing else changes):
 *   BOOKING_FEE_CENTS    flat fee per appointment         (default 100 = $1.00)
 *   BOOKING_FEE_PERCENT  % of the service price            (default 0)
 *   BOOKING_FEE_MAX_CENTS cap per appointment              (default none)
 *   BOOKING_FEE_SCOPE    lola | all                        (default lola)
 *   BOOKING_FEES_LIVE    1 = actually bill through Stripe  (default off: the
 *                        ledger fills so you see earnings, nobody is charged)
 */
import { createHash } from 'node:crypto';

const MANUAL = /^(dashboard|owner|manual|admin|lola_owner|operator|staff|import|sync|seed|demo|test)/i;
const LOLA = /^(lola|voice|telnyx|phone|call|sms|text|public|widget|website|web|google|gmb|reserve|waitlist|gap|lola_gap|rebook|campaign|missed_call|marketer|strategy|skill|autopilot)/i;
const CANCELLED = /^(cancel|no[-_ ]?show|noshow|declined|rejected|void)/i;

export function feePolicy(env = process.env) {
  const n = (v, d) => { const x = Number(v); return Number.isFinite(x) && x >= 0 ? x : d; };
  return {
    flatCents: Math.round(n(env.BOOKING_FEE_CENTS, 100)),
    percent: Math.min(50, n(env.BOOKING_FEE_PERCENT, 0)),
    maxCents: env.BOOKING_FEE_MAX_CENTS ? Math.round(n(env.BOOKING_FEE_MAX_CENTS, 0)) : null,
    scope: String(env.BOOKING_FEE_SCOPE || 'lola').toLowerCase() === 'all' ? 'all' : 'lola',
    live: String(env.BOOKING_FEES_LIVE || '') === '1' || String(env.BOOKING_FEES_LIVE || '').toLowerCase() === 'true',
  };
}

/** Is this booking one LolaDesk earns on? */
export function isBillable(booking, policy = feePolicy()) {
  if (!booking || !booking.id) return false;
  if (booking.external_id || booking.external_provider) return false;   // synced from another platform
  const src = String(booking.source || '').trim();
  if (policy.scope === 'all') return !/^(import|sync|seed|demo|test)/i.test(src);
  if (!src || MANUAL.test(src)) return false;
  return LOLA.test(src);
}

export function feeCents(booking, policy = feePolicy()) {
  const price = Math.max(0, Number(booking?.total_amount) || 0);
  let cents = policy.flatCents + Math.round(price * 100 * policy.percent / 100);
  if (policy.maxCents != null) cents = Math.min(cents, policy.maxCents);
  return Math.max(0, cents);
}

const onTrial = (t) => {
  const s = String(t?.subscription_status || 'trial').toLowerCase();
  return s === 'trial' || s === 'trialing' || !s;
};
const monthKey = (iso) => String(iso || new Date().toISOString()).slice(0, 7);

/** One ledger row for one booking. Safe to call any number of times. */
export async function recordFee(c, tenant, booking, { policy = feePolicy() } = {}) {
  try {
    if (!c || !tenant?.id || !booking?.id || !isBillable(booking, policy)) return { ok: true, skipped: 'not_billable' };
    const { data: have } = await c.from('booking_fees').select('id,status').eq('booking_id', booking.id).maybeSingle();
    if (have) return { ok: true, existing: have };
    const cents = feeCents(booking, policy);
    if (!cents) return { ok: true, skipped: 'zero_fee' };
    const waived = onTrial(tenant);
    const row = {
      tenant_id: tenant.id, booking_id: booking.id, source: String(booking.source || '').slice(0, 40),
      service_amount: Number(booking.total_amount) || 0, fee_cents: cents,
      status: waived ? 'waived' : 'pending', reason: waived ? 'trial' : null,
      appointment_at: booking.start_time || null, period: monthKey(booking.start_time),
    };
    const ins = await c.from('booking_fees').insert(row).select().maybeSingle();
    if (ins.error) {
      if (/duplicate|unique/i.test(ins.error.message || '')) return { ok: true, existing: true };
      return { ok: false, error: ins.error.message };
    }
    return { ok: true, fee: ins.data };
  } catch (e) { return { ok: false, error: String(e?.message || e) }; }
}

/** Same, when only the booking row is at hand (loads the salon). */
export async function recordFeeFor(c, booking, opts = {}) {
  try {
    if (!c || !booking?.tenant_id || !isBillable(booking, opts.policy || feePolicy())) return { ok: true, skipped: 'not_billable' };
    const { data: tenant } = await c.from('tenants').select('*').eq('id', booking.tenant_id).maybeSingle();
    return tenant ? recordFee(c, tenant, booking, opts) : { ok: true, skipped: 'no_tenant' };
  } catch (e) { return { ok: false, error: String(e?.message || e) }; }
}

/** A cancelled or no-show booking costs the salon nothing (unless already billed). */
export async function voidFee(c, bookingId, reason = 'cancelled') {
  try {
    if (!c || !bookingId) return { ok: true };
    const r = await c.from('booking_fees').update({ status: 'void', reason, voided_at: new Date().toISOString() })
      .eq('booking_id', bookingId).in('status', ['pending', 'earned']);
    return { ok: !r.error };
  } catch { return { ok: false }; }
}

/**
 * Daily: (1) catch bookings made by any path in the last few days,
 * (2) settle pending fees whose appointment time has passed,
 * (3) bill earned fees to Stripe (only when BOOKING_FEES_LIVE=1).
 */
export async function runBookingFees(c, { now = new Date(), policy = feePolicy(), lookbackDays = 4, bill = billTenant } = {}) {
  const out = { recorded: 0, earned: 0, voided: 0, billed: 0, billed_cents: 0, tenants_billed: 0, live: policy.live, errors: [] };
  const tenants = new Map();
  const tenantFor = async (id) => {
    if (!tenants.has(id)) { const { data } = await c.from('tenants').select('*').eq('id', id).maybeSingle(); tenants.set(id, data || null); }
    return tenants.get(id);
  };

  // 1. sweep
  const since = new Date(now.getTime() - lookbackDays * 864e5).toISOString();
  const { data: recent } = await c.from('bookings').select('*').gte('created_at', since).limit(5000);
  const ids = (recent || []).map(b => b.id);
  const known = new Set();
  for (let i = 0; i < ids.length; i += 500) {
    const { data } = await c.from('booking_fees').select('booking_id').in('booking_id', ids.slice(i, i + 500));
    (data || []).forEach(r => known.add(r.booking_id));
  }
  for (const b of recent || []) {
    if (known.has(b.id) || CANCELLED.test(b.status || '') || !isBillable(b, policy)) continue;
    const t = await tenantFor(b.tenant_id); if (!t) continue;
    const r = await recordFee(c, t, b, { policy });
    if (r.fee) out.recorded++;
  }

  // 2. settle: the appointment happened (or didn't). Wait a day after the
  //    appointment so the salon has time to mark a no-show.
  const settleBefore = new Date(now.getTime() - 24 * 3600e3).toISOString();
  const { data: due } = await c.from('booking_fees').select('*').eq('status', 'pending').lt('appointment_at', settleBefore).limit(5000);
  const dueIds = (due || []).map(f => f.booking_id);
  const bookingById = new Map();
  for (let i = 0; i < dueIds.length; i += 500) {
    const { data } = await c.from('bookings').select('id,status').in('id', dueIds.slice(i, i + 500));
    (data || []).forEach(b => bookingById.set(b.id, b));
  }
  for (const f of due || []) {
    const b = bookingById.get(f.booking_id);
    if (!b || CANCELLED.test(b.status || '')) {
      await c.from('booking_fees').update({ status: 'void', reason: b ? String(b.status).toLowerCase() : 'deleted', voided_at: now.toISOString() }).eq('id', f.id).eq('status', 'pending');
      out.voided++;
    } else {
      await c.from('booking_fees').update({ status: 'earned', earned_at: now.toISOString() }).eq('id', f.id).eq('status', 'pending');
      out.earned++;
    }
  }

  // 3. bill
  if (!policy.live) return out;
  const { data: earned } = await c.from('booking_fees').select('*').eq('status', 'earned').limit(10000);
  const byTenant = new Map();
  for (const f of earned || []) { if (!byTenant.has(f.tenant_id)) byTenant.set(f.tenant_id, []); byTenant.get(f.tenant_id).push(f); }
  for (const [tid, fees] of byTenant) {
    const t = await tenantFor(tid);
    if (!t) continue;
    const status = String(t.subscription_status || '').toLowerCase();
    if (!t.stripe_customer_id || !['active', 'canceling', 'past_due'].includes(status)) continue;   // bill paying salons only
    try {
      const r = await bill(t, fees);
      if (r && r.id) {
        const idsToMark = fees.map(f => f.id);
        for (let i = 0; i < idsToMark.length; i += 500) {
          await c.from('booking_fees').update({ status: 'billed', billed_at: now.toISOString(), stripe_invoice_item_id: r.id }).in('id', idsToMark.slice(i, i + 500)).eq('status', 'earned');
        }
        out.billed += fees.length; out.tenants_billed++;
        out.billed_cents += fees.reduce((s, f) => s + (Number(f.fee_cents) || 0), 0);
      }
    } catch (e) { out.errors.push({ tenant: tid, error: String(e?.message || e).slice(0, 200) }); }
  }
  return out;
}

/** One Stripe invoice item per salon per run; it rides the next LolaDesk invoice. */
export async function billTenant(tenant, fees) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set');
  const cents = fees.reduce((s, f) => s + (Number(f.fee_cents) || 0), 0);
  if (!cents) return null;
  const dates = fees.map(f => String(f.appointment_at || '').slice(0, 10)).filter(Boolean).sort();
  const span = dates.length ? (dates[0] === dates[dates.length - 1] ? dates[0] : `${dates[0]} – ${dates[dates.length - 1]}`) : '';
  const body = new URLSearchParams({
    customer: tenant.stripe_customer_id, amount: String(cents), currency: 'usd',
    description: `LolaDesk — ${fees.length} appointment${fees.length === 1 ? '' : 's'} booked by Lola${span ? ` (${span})` : ''}`,
    'metadata[tenant_id]': tenant.id, 'metadata[kind]': 'booking_fees', 'metadata[count]': String(fees.length),
  });
  // Same fees → same key, so a retried run can never bill twice.
  const idem = 'bf_' + createHash('sha256').update(fees.map(f => f.id).sort().join(',')).digest('hex').slice(0, 40);
  const r = await fetch('https://api.stripe.com/v1/invoiceitems', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': idem }, body,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error?.message || `Stripe ${r.status}`);
  return d;
}

/** What Lola brought in, and what LolaDesk earned — for the owner and for admin. */
export async function feeSummary(c, { tenantId = null, month = monthKey() } = {}) {
  let q = c.from('booking_fees').select('tenant_id,status,fee_cents,service_amount,period').eq('period', month).limit(20000);
  if (tenantId) q = q.eq('tenant_id', tenantId);
  const { data, error } = await q;
  if (error) return { ready: false, month };
  const rows = data || [];
  const counted = rows.filter(r => ['pending', 'earned', 'billed'].includes(r.status));
  const sum = (list, k) => list.reduce((s, r) => s + (Number(r[k]) || 0), 0);
  return {
    ready: true, month, policy: (({ flatCents, percent, maxCents, scope, live }) => ({ flat_cents: flatCents, percent, max_cents: maxCents, scope, live }))(feePolicy()),
    lola_bookings: counted.length,
    lola_revenue: Math.round(sum(counted, 'service_amount')),
    fees_cents: sum(counted, 'fee_cents'),
    billed_cents: sum(rows.filter(r => r.status === 'billed'), 'fee_cents'),
    waived: rows.filter(r => r.status === 'waived').length,
    waived_cents: sum(rows.filter(r => r.status === 'waived'), 'fee_cents'),
    voided: rows.filter(r => r.status === 'void').length,
    salons: tenantId ? undefined : new Set(counted.map(r => r.tenant_id)).size,
  };
}
