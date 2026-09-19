/**
 * api/lib/deposits.js — the no-show protection loop (deposits).
 *
 * Revives the previously dead deposit surface end to end: a salon can require
 * a deposit on new bookings, the client gets a Stripe Payment Link by SMS the
 * moment the booking is created, and the hourly sweep enforces the outcome:
 *   • unpaid when the appointment starts        → flagged + one polite text
 *   • paid + cancelled outside the window       → deposit kept
 *   • paid + cancelled inside the window        → deposit refunded via Stripe
 *   • paid + no-show                            → deposit kept
 *   • paid + completed                          → kept silently (it's payment)
 *
 * Policy lives in booking_settings.metadata.deposits (no migration needed —
 * `metadata` is already a writable booking_settings column and the Settings →
 * Booking pane saves it through /api/booking-settings):
 *   { enabled: bool, percent: 1-100, min_cents: >=0, grace_minutes: >=0 }
 *
 * Stripe side uses ONE primitive — POST /v1/payment_links creating a price on
 * the fly — so LolaDesk never charges a card directly: the client pays (or
 * doesn't) through Stripe's hosted page. A paid link flips its deposits row
 * to `paid` in the Stripe webhook (checkout.session.completed carries the
 * payment_link + payment_intent ids), which is also where the PaymentIntent
 * id lands for later refunds.
 *
 * Money moves ONLY on the owner's explicit configuration: the loop is fully
 * off unless metadata.deposits.enabled is true.
 */

import { db } from './db.js';
import { ensureMigrations } from './migrate.js';
import { sendSMS } from './sms.js';
import { createPaymentLink } from './stripe.js';
import { depositRequestText, depositKeptText, depositRefundText, depositUnpaidText } from './lola-persona.js';

export const DEPOSIT_DEFAULTS = Object.freeze({ percent: 25, min_cents: 0, grace_minutes: 0 });
export const DEPOSIT_MAX_PERCENT = 100;

// Parse the salon's policy from booking_settings.metadata.deposits, tolerating
// bad types and stale JSON. Returns null when deposits are simply off.
export function resolvePolicy(settings){
  const raw = settings && settings.metadata && settings.metadata.deposits;
  if(!raw || raw.enabled !== true) return null;
  const pct = Math.round(Number(raw.percent));
  return {
    enabled: true,
    percent: Number.isFinite(pct) && pct >= 1 ? Math.min(DEPOSIT_MAX_PERCENT, pct) : DEPOSIT_DEFAULTS.percent,
    min_cents: Math.max(0, Math.round(Number(raw.min_cents) || 0)),
    grace_minutes: Math.max(0, Math.round(Number(raw.grace_minutes) || 0))
  };
}

// Charge for one booking: percent of the total, floored at min_cents.
// Returns null when the deposit computes to nothing (free service, 0 total).
export function depositAmountCents(totalAmount, policy){
  // total_amount is stored in dollars (repo convention); Stripe wants cents.
  const totalCents = Math.max(0, Math.round((Number(totalAmount) || 0) * 100));
  const pct = Math.min(DEPOSIT_MAX_PERCENT, Math.max(1, Math.round(Number(policy && policy.percent) || DEPOSIT_DEFAULTS.percent)));
  const min = Math.max(0, Math.round(Number(policy && policy.min_cents) || 0));
  return Math.max(Math.round(totalCents * pct / 100), min) || null;
}

const fmtWhen = (iso) => new Date(iso).toLocaleString('en-US', {
  weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
});

// Fire the deposit request for a freshly created confirmed booking. Never
// throws — a deposit failure must never fail the booking it protects.
// Injectable `send`/`createLink` for tests. Returns { ok, skipped?/reason?, deposit? }.
export async function requestDeposit({ tenantId, booking, policy = null, send = sendSMS, createLink = createPaymentLink } = {}){
  ensureMigrations(); // self-heal the deposits table if the wiring migration never landed
  const c = db();
  if(!c) return { ok: false, skipped: true, reason: 'no_db' };
  if(!policy){
    // Self-serve: resolve the salon's policy (kept injectable for tests).
    const { data: s } = await c.from('booking_settings').select('metadata').eq('tenant_id', tenantId).maybeSingle();
    policy = resolvePolicy(s);
  }
  if(!policy || policy.enabled !== true) return { ok: true, skipped: true, reason: 'policy_off' };
  const start = booking && booking.start_time ? new Date(booking.start_time) : null;
  if(!booking?.id || !start || Number.isNaN(start.getTime()) || start <= new Date()) return { ok: true, skipped: true, reason: 'start_passed' };
  if(!process.env.STRIPE_SECRET_KEY) return { ok: true, skipped: true, reason: 'stripe_not_configured' };

  const cents = depositAmountCents(booking.total_amount, policy);
  if(!cents) return { ok: true, skipped: true, reason: 'zero_amount' };

  try{
    const [{ data: tenant }, { data: client }, { data: svc }] = await Promise.all([
      c.from('tenants').select('name,phone_number').eq('id', tenantId).maybeSingle(),
      booking.client_id ? c.from('clients').select('id,name,phone').eq('id', booking.client_id).maybeSingle() : Promise.resolve({ data: null }),
      booking.service_id ? c.from('services').select('name').eq('id', booking.service_id).maybeSingle() : Promise.resolve({ data: null })
    ]);
    if(!client?.phone) return { ok: true, skipped: true, reason: 'no_client_phone' };
    if(!tenant?.phone_number) return { ok: true, skipped: true, reason: 'no_from_number' };

    const link = await createLink({
      amountCents: cents,
      description: `${svc?.name || 'Appointment'} deposit — ${tenant.name || 'the salon'}`,
      successUrl: `${process.env.APP_URL || 'https://www.loladesk.com'}/bookings.html?deposit=paid&booking=${booking.id}`
    });
    const { data: deposit, error } = await c.from('deposits').insert({
      tenant_id: tenantId, booking_id: booking.id, amount: cents / 100,
      status: 'pending', stripe_payment_intent_id: link?.id || null
    }).select().maybeSingle();
    if(error) throw error;

    const when = fmtWhen(booking.start_time);
    await send({
      from: tenant.phone_number, to: client.phone, tenantId, type: 'SMS',
      text: depositRequestText({
        firstName: client.name, salon: tenant.name, serviceName: svc?.name,
        when, amount: `$${(cents / 100).toFixed(2)}`, link: link?.url || ''
      })
    }).catch(() => {}); // a failed text never fails the deposit; the salon can resend from the dashboard
    return { ok: true, deposit, link_url: link?.url || null, amount_cents: cents };
  }catch(e){
    return { ok: false, reason: String(e?.message || e) };
  }
}

// Hourly sweep (cron/deposits). Reviews every pending (unpaid) and paid
// deposit against its booking's outcome. Each row is claimed with a
// status-conditional update (… .eq('status', expected)) BEFORE acting, so two
// overlapping cron ticks can never double-refund or double-text. Sends and
// refunds are injectable for tests; individual failures never abort the run.
export async function runDepositSweep(now = new Date(), { send = sendSMS, refund = refundDepositIntent } = {}){
  ensureMigrations(); // self-heal the deposits table if the wiring migration never landed
  const c = db();
  if(!c) throw new Error('database not configured');
  const result = { checked: 0, refunded: 0, kept: 0, flagged: 0, voided: 0, failed: 0, skipped: 0 };

  const [{ data: pending }, { data: paid }] = await Promise.all([
    c.from('deposits').select('id,tenant_id,booking_id,amount,status,stripe_payment_intent_id').eq('status', 'pending').order('created_at').limit(200),
    c.from('deposits').select('id,tenant_id,booking_id,amount,status,stripe_payment_intent_id').eq('status', 'paid').order('created_at').limit(200)
  ]);
  const rows = [...(pending || []), ...(paid || [])];
  if(!rows.length) return result;

  const bookingIds = [...new Set(rows.map(d => d.booking_id).filter(Boolean))];
  const { data: bookings } = bookingIds.length
    ? await c.from('bookings').select('id,tenant_id,client_id,status,start_time,updated_at').in('id', bookingIds) : { data: [] };
  const bMap = Object.fromEntries((bookings || []).map(b => [b.id, b]));
  const tenantIds = [...new Set(rows.map(d => d.tenant_id).filter(Boolean))];
  const [settingsR, tenantsR] = await Promise.all([
    tenantIds.length ? c.from('booking_settings').select('tenant_id,metadata').in('tenant_id', tenantIds) : Promise.resolve({ data: [] }),
    tenantIds.length ? c.from('tenants').select('id,name,phone_number').in('id', tenantIds) : Promise.resolve({ data: [] })
  ]);
  const sMap = Object.fromEntries((settingsR.data || []).map(s => [s.tenant_id, s]));
  const tMap = Object.fromEntries((tenantsR.data || []).map(t => [t.id, t]));
  const clientIds = [...new Set((bookings || []).map(b => b.client_id).filter(Boolean))];
  const { data: clients } = clientIds.length
    ? await c.from('clients').select('id,name,phone').in('id', clientIds) : { data: [] };
  const clMap = Object.fromEntries((clients || []).map(cl => [cl.id, cl]));

  const graceMs = (tenantId) => (resolvePolicy(sMap[tenantId])?.grace_minutes ?? DEPOSIT_DEFAULTS.grace_minutes) * 60000;

  for(const d of rows){
    result.checked++;
    const b = bMap[d.booking_id];
    if(!b){ result.skipped++; continue; } // booking gone — nothing to enforce
    const st = new Date(b.start_time).getTime();
    const cutoff = st - graceMs(d.tenant_id); // refunds allowed until here
    const status = String(b.status || '').toLowerCase();
    const unpaid = d.status === 'pending';

    // ── UNPAID deposits ────────────────────────────────────────────────
    if(unpaid){
      if(now.getTime() < cutoff){ result.skipped++; continue; } // window still open
      const claimed = await setDepositStatus(c, d.id, 'flagged', 'pending');
      if(!claimed){ result.skipped++; continue; }
      if(['cancelled', 'canceled', 'declined', 'no_show', 'completed', 'arrived', 'in_progress'].includes(status)){
        // Booking ended/abandoned without payment — nothing to enforce.
        await setDepositStatus(c, d.id, 'void', 'flagged');
        result.voided++;
        continue;
      }
      // Still live at start time: surface it to the client (once) and leave
      // the row flagged for the owner — the booking is never auto-cancelled.
      const cl = clMap[b.client_id]; const t = tMap[d.tenant_id];
      if(cl?.phone && t?.phone_number){
        const { data: svc } = b.service_id
          ? await c.from('services').select('name').eq('id', b.service_id).maybeSingle() : { data: null };
        await send({ from: t.phone_number, to: cl.phone, tenantId: d.tenant_id, type: 'SMS',
          text: depositUnpaidText({ firstName: cl.name, salon: t.name, serviceName: svc?.name, when: fmtWhen(b.start_time) }) }).catch(() => {});
      }
      result.flagged++;
      continue;
    }

    // ── PAID deposits ──────────────────────────────────────────────────
    if(['completed', 'arrived', 'in_progress'].includes(status)){
      const claimed = await setDepositStatus(c, d.id, 'kept', 'paid');
      if(claimed) result.kept++; else result.skipped++; // applied to the visit — silent
      continue;
    }
    if(status === 'no_show'){
      const claimed = await setDepositStatus(c, d.id, 'kept', 'paid');
      if(!claimed){ result.skipped++; continue; }
      const cl = clMap[b.client_id]; const t = tMap[d.tenant_id];
      if(cl?.phone && t?.phone_number){
        await send({ from: t.phone_number, to: cl.phone, tenantId: d.tenant_id, type: 'SMS',
          text: depositKeptText({ firstName: cl.name, salon: t.name, amount: `$${Number(d.amount).toFixed(2)}` }) }).catch(() => {});
      }
      result.kept++;
      continue;
    }
    if(['cancelled', 'canceled', 'declined'].includes(status)){
      const cancelledAt = new Date(b.updated_at || b.start_time).getTime();
      if(cancelledAt <= cutoff){
        // In-window cancellation: refund.
        const claimed = await setDepositStatus(c, d.id, 'refunding', 'paid');
        if(!claimed){ result.skipped++; continue; }
        try{
          await refund(d.stripe_payment_intent_id, d.tenant_id);
          await setDepositStatus(c, d.id, 'refunded', 'refunding');
          const cl = clMap[b.client_id]; const t = tMap[d.tenant_id];
          if(cl?.phone && t?.phone_number){
            await send({ from: t.phone_number, to: cl.phone, tenantId: d.tenant_id, type: 'SMS',
              text: depositRefundText({ firstName: cl.name, salon: t.name, amount: `$${Number(d.amount).toFixed(2)}` }) }).catch(() => {});
          }
          result.refunded++;
        }catch(e){
          await setDepositStatus(c, d.id, 'paid', 'refunding'); // retry next tick
          result.failed++;
        }
      }else{
        // Late cancellation: deposit kept.
        const claimed = await setDepositStatus(c, d.id, 'kept', 'paid');
        if(!claimed){ result.skipped++; continue; }
        const cl = clMap[b.client_id]; const t = tMap[d.tenant_id];
        if(cl?.phone && t?.phone_number){
          await send({ from: t.phone_number, to: cl.phone, tenantId: d.tenant_id, type: 'SMS',
            text: depositKeptText({ firstName: cl.name, salon: t.name, amount: `$${Number(d.amount).toFixed(2)}` }) }).catch(() => {});
        }
        result.kept++;
      }
      continue;
    }
    // Confirmed but before start — nothing due yet.
    result.skipped++;
  }
  return result;
}

// Status-conditional update: returns the row only when it still had the
// expected status (the claim). On the fake and real Postgres alike, a lost
// race returns no row and the caller skips.
async function setDepositStatus(c, id, status, expected){
  const { data, error } = await c.from('deposits').update({ status }).eq('id', id).eq('status', expected).select().maybeSingle();
  if(error) return null;
  return data || null;
}

// Refund a paid deposit's PaymentIntent through Stripe (/v1/refunds).
// Injectable in tests; live path requires the webhook to have recorded the
// PaymentIntent id (see stripe-webhook.js checkout.session.completed).
export async function refundDepositIntent(intentId, _tenantId){
  if(!intentId || !String(intentId).startsWith('pi_')) throw new Error('no payment intent recorded on deposit');
  const { stripeRefund } = await import('./stripe.js');
  return stripeRefund(intentId);
}
