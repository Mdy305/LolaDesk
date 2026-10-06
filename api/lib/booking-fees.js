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
 *   waived   → the appointment fell inside the salon's free trial (decided at
 *              SETTLEMENT — when the appointment happens — not at booking time:
 *              a trial booking for a date after the salon subscribed is earned,
 *              and a paid-time booking that lands back in a trial is waived)
 *
 * Reschedules move the fee with the booking (moveFee); cancels / no-shows
 * void it (voidFee). A salon that cancels LolaDesk still pays for the
 * appointments Lola booked that happened: its earned fees go on a one-off
 * invoice, created and finalized right away (Stripe sends no further
 * subscription invoices once a subscription ends).
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
import { serviceStatus } from './service-gate.js';

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
/**
 * Was the salon in its free trial when this appointment happened?
 * Decided at settlement time (the appointment just passed, so "now" ≈ then).
 * A LolaDesk trial that ended before the appointment, without a subscription,
 * is still "trial" — nobody is charged for a salon that never paid.
 */
export function waivedAtSettlement(tenant, fee, now = new Date()) {
  if (!tenant) return false;
  if (String(tenant.billing_status || '').toLowerCase() === 'comped') return true;
  if (!onTrial(tenant)) return false;
  // A Stripe trial ('trialing') ends on its own date; past it the visit counts.
  const end = Date.parse(tenant.trial_ends_at || '');
  const at = Date.parse(fee?.appointment_at || '') || now.getTime();
  if (String(tenant.subscription_status || '') === 'trialing' && Number.isFinite(end) && at > end) return false;
  return true;
}
const monthKey = (iso) => String(iso || new Date().toISOString()).slice(0, 7);

/** One ledger row for one booking. Safe to call any number of times. */
export async function recordFee(c, tenant, booking, { policy = feePolicy() } = {}) {
  try {
    if (!c || !tenant?.id || !booking?.id || !isBillable(booking, policy)) return { ok: true, skipped: 'not_billable' };
    const { data: have } = await c.from('booking_fees').select('id,status').eq('booking_id', booking.id).maybeSingle();
    if (have) return { ok: true, existing: have };
    const cents = feeCents(booking, policy);
    if (!cents) return { ok: true, skipped: 'zero_fee' };
    // Provisional only: settlement (runBookingFees) decides waived vs earned at the appointment.
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

/**
 * A cancelled or no-show booking costs the salon nothing (unless already billed).
 * voidFee(c, bookingId, reason) — or voidFee(bookingId, reason) with the default db.
 * Also voids a provisional trial waiver (nothing to settle later).
 */
export async function voidFee(c, bookingId, reason = 'cancelled') {
  try {
    if (typeof c === 'string' || typeof c === 'number') { reason = bookingId || 'cancelled'; bookingId = c; c = await defaultDb(); }
    if (!c || !bookingId) return { ok: true };
    const r = await c.from('booking_fees').update({ status: 'void', reason: String(reason || 'cancelled').slice(0, 40), voided_at: new Date().toISOString() })
      .eq('booking_id', bookingId).in('status', ['pending', 'earned', 'waived']);
    return { ok: !r.error };
  } catch { return { ok: false }; }
}

/**
 * The booking moved: its fee moves with it (settles at the NEW time, in the
 * new month). A fee voided by a cancel that is then rebooked comes back.
 * moveFee(bookingId, newStartsAt, c?) — never throws.
 */
export async function moveFee(bookingId, newStartsAt, c = null) {
  try {
    c = c || await defaultDb();
    if (!c || !bookingId || !newStartsAt) return { ok: true, skipped: true };
    const when = new Date(newStartsAt);
    if (Number.isNaN(when.getTime())) return { ok: false, error: 'bad_time' };
    const at = when.toISOString();
    const r = await c.from('booking_fees').update({ appointment_at: at, period: monthKey(at) })
      .eq('booking_id', bookingId).in('status', ['pending', 'waived']);
    // An already-settled fee (earned) for an appointment that moved into the future goes back to pending.
    if (when.getTime() > Date.now()) {
      await c.from('booking_fees').update({ appointment_at: at, period: monthKey(at), status: 'pending', earned_at: null })
        .eq('booking_id', bookingId).eq('status', 'earned');
    }
    return { ok: !r?.error };
  } catch (e) { return { ok: false, error: String(e?.message || e) }; }
}

async function defaultDb() { try { const { db } = await import('./db.js'); return db(); } catch { return null; } }

/** Keyset paging over a query builder factory, ordered by id. */
async function pageAll(make, { size = 500, max = 200000 } = {}) {
  const out = [];
  let last = null;
  while (out.length < max) {
    let q = make();
    if (last != null) q = q.gt('id', last);
    const { data, error } = await q.order('id', { ascending: true }).limit(size);
    if (error || !data || !data.length) break;
    out.push(...data);
    if (data.length < size) break;
    const next = data[data.length - 1].id;
    if (next == null || next === last) break;
    last = next;
  }
  return out;
}

/**
 * Daily: (1) catch bookings made by any path in the last few days,
 * (2) settle fees whose appointment time has passed — earned, void, or waived
 *     (the trial decision is made HERE, at the appointment),
 * (3) bill earned fees to Stripe (only when BOOKING_FEES_LIVE=1); a salon that
 *     cancelled gets a one-off invoice, finalized now.
 */
export async function runBookingFees(c, { now = new Date(), policy = feePolicy(), lookbackDays = 4, bill = billTenant, finalize = finalInvoice } = {}) {
  const out = { recorded: 0, earned: 0, voided: 0, waived: 0, billed: 0, billed_cents: 0, tenants_billed: 0, final_invoices: 0, held: 0, live: policy.live, errors: [] };
  const tenants = new Map();
  const tenantFor = async (id) => {
    if (!tenants.has(id)) { const { data } = await c.from('tenants').select('*').eq('id', id).maybeSingle(); tenants.set(id, data || null); }
    return tenants.get(id);
  };

  // 1. sweep — every booking of the lookback window, paged in id order (no silent 5000 cap)
  const since = new Date(now.getTime() - lookbackDays * 864e5).toISOString();
  const recent = await pageAll(() => c.from('bookings').select('*').gte('created_at', since));
  const ids = recent.map(b => b.id);
  const known = new Set();
  for (let i = 0; i < ids.length; i += 500) {
    const { data } = await c.from('booking_fees').select('booking_id').in('booking_id', ids.slice(i, i + 500));
    (data || []).forEach(r => known.add(r.booking_id));
  }
  for (const b of recent) {
    if (known.has(b.id) || CANCELLED.test(b.status || '') || !isBillable(b, policy)) continue;
    const t = await tenantFor(b.tenant_id); if (!t) continue;
    const r = await recordFee(c, t, b, { policy });
    if (r.fee) out.recorded++;
  }

  // 2. settle: the appointment happened (or didn't). Wait a day after the
  //    appointment so the salon has time to mark a no-show. Provisional trial
  //    waivers are re-decided too (reason 'trial' = not settled yet).
  const settleBefore = new Date(now.getTime() - 24 * 3600e3).toISOString();
  const duePending = await pageAll(() => c.from('booking_fees').select('*').eq('status', 'pending').lt('appointment_at', settleBefore));
  const dueWaived = await pageAll(() => c.from('booking_fees').select('*').eq('status', 'waived').eq('reason', 'trial').lt('appointment_at', settleBefore));
  const due = [...duePending, ...dueWaived];
  const dueIds = due.map(f => f.booking_id);
  const bookingById = new Map();
  for (let i = 0; i < dueIds.length; i += 500) {
    const { data } = await c.from('bookings').select('id,status,start_time').in('id', dueIds.slice(i, i + 500));
    (data || []).forEach(b => bookingById.set(b.id, b));
  }
  for (const f of due) {
    const b = bookingById.get(f.booking_id);
    if (!b || CANCELLED.test(b.status || '')) {
      await c.from('booking_fees').update({ status: 'void', reason: b ? String(b.status).toLowerCase().slice(0, 40) : 'deleted', voided_at: now.toISOString() }).eq('id', f.id).eq('status', f.status);
      out.voided++;
      continue;
    }
    // Rescheduled to a later time without the hook firing → follow the booking.
    if (b.start_time && Date.parse(b.start_time) > Date.parse(settleBefore) && Date.parse(b.start_time) !== Date.parse(f.appointment_at || '')) {
      await c.from('booking_fees').update({ appointment_at: b.start_time, period: monthKey(b.start_time), status: 'pending', reason: null }).eq('id', f.id).eq('status', f.status);
      continue;
    }
    const t = await tenantFor(f.tenant_id);
    if (waivedAtSettlement(t, f, now)) {
      await c.from('booking_fees').update({ status: 'waived', reason: 'trial_settled', earned_at: null }).eq('id', f.id).eq('status', f.status);
      out.waived++;
    } else {
      await c.from('booking_fees').update({ status: 'earned', reason: null, earned_at: now.toISOString() }).eq('id', f.id).eq('status', f.status);
      out.earned++;
    }
  }

  // 3. bill
  if (!policy.live) return out;
  const earned = await pageAll(() => c.from('booking_fees').select('*').eq('status', 'earned'));
  const byTenant = new Map();
  for (const f of earned) { if (!byTenant.has(f.tenant_id)) byTenant.set(f.tenant_id, []); byTenant.get(f.tenant_id).push(f); }
  for (const [tid, fees] of byTenant) {
    const t = await tenantFor(tid);
    if (!t || !t.stripe_customer_id) continue;
    const mode = billingMode(t, now);
    if (mode === 'skip') continue;
    if (mode === 'hold') { out.held += fees.length; continue; }
    try {
      const r = await bill(t, fees);
      if (r && r.id) {
        const idsToMark = fees.map(f => f.id);
        for (let i = 0; i < idsToMark.length; i += 500) {
          await c.from('booking_fees').update({ status: 'billed', billed_at: now.toISOString(), stripe_invoice_item_id: r.id }).in('id', idsToMark.slice(i, i + 500)).eq('status', 'earned');
        }
        out.billed += fees.length; out.tenants_billed++;
        out.billed_cents += fees.reduce((s, f) => s + (Number(f.fee_cents) || 0), 0);
        if (mode === 'final') {
          try { await finalize(t, fees); out.final_invoices++; }
          catch (e) { out.errors.push({ tenant: tid, error: 'final_invoice: ' + String(e?.message || e).slice(0, 180) }); }
        }
      }
    } catch (e) { out.errors.push({ tenant: tid, error: String(e?.message || e).slice(0, 200) }); }
  }
  return out;
}

/**
 * How to bill a salon's earned fees now:
 *   'next'  — invoice item, rides the next subscription invoice (active / past_due)
 *   'final' — subscription ended (or ends within 36h): invoice items + a one-off
 *             invoice created and finalized now
 *   'hold'  — canceling with the period end still ahead: keep them for the final invoice
 *   'skip'  — never paid (trial / no subscription), comped, or 'unpaid' (Stripe gave up)
 */
export function billingMode(t, now = new Date()) {
  const status = String(t?.subscription_status || '').toLowerCase();
  if (String(t?.billing_status || '').toLowerCase() === 'comped') return 'skip';
  if (status === 'active' || status === 'past_due') return 'next';
  if (status === 'canceling') {
    const end = Date.parse(t.current_period_end || '');
    return Number.isFinite(end) && end - now.getTime() > 36 * 3600e3 ? 'hold' : 'final';
  }
  if (status === 'canceled' || status === 'cancelled') return 'final';
  return 'skip';
}

/** One-off invoice for a cancelling salon's earned fees: create + finalize now. */
export async function finalInvoice(tenant, fees) {
  const { invoiceNow } = await import('./stripe.js');
  const idem = 'fin_' + createHash('sha256').update(fees.map(f => f.id).sort().join(',')).digest('hex').slice(0, 40);
  return invoiceNow(tenant.stripe_customer_id, { description: 'LolaDesk — appointments Lola booked (final)', metadata: { tenant_id: tenant.id, kind: 'final_usage' }, idempotencyKey: idem });
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
