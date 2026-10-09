/**
 * POST /api/stripe-webhook — the ONE Stripe webhook (api/billing/webhook.js re-exports it).
 * ════════════════════════════════════════════════════════════════════
 * Two kinds of events arrive here:
 *   • Your account (LolaDesk billing + booking deposits):
 *       checkout.session.completed      → activate the salon's plan; deposit link paid → deposit 'paid'
 *       customer.subscription.updated   → active / canceling / past_due …
 *       customer.subscription.deleted   → canceled
 *       invoice.payment_succeeded       → active (never overwrites a pending cancel)
 *       invoice.payment_failed          → past_due (+ past_due_since: the 7-day grace starts here)
 *       customer.subscription.trial_will_end → text + email the owner
 *       checkout.session.async_payment_failed → deposit/sub payment failed: logged, owner told
 *       charge.dispute.created          → deposit/payment at risk, admin alerted
 *       charge.refunded                 → deposit / payment marked refunded
 *     Plan comes from the subscription's PRICE (lib/plans.js planFromPrice), metadata as fallback.
 *     Deposit links: only a PENDING deposit can be paid; a second / late payment
 *     (already paid, released, booking cancelled) is refunded automatically.
 *   • Connected accounts (salon Stripe Connect): payment_intent.*, charge.*, account.updated, payout.paid
 * The Sep 22 rewrite kept only the Connect half, so paying salons were never
 * activated and deposits were never marked paid. Both halves live here now.
 *
 * Stripe dashboard: add this URL twice — once for "Your account" events and
 * once for "Connected accounts" events. Put the first signing secret in
 * STRIPE_WEBHOOK_SECRET and the second in STRIPE_CONNECT_WEBHOOK_SECRET.
 */
import { db } from './lib/db.js';
import { stripe as stripeClient, stripeApi, stripeRefund, deactivatePaymentLink } from './lib/stripe.js';
import { planFromPrice, normalizePlan } from './lib/plans.js';
import { studioDepositPaid } from './lib/studio-server.js';

export const config = { api: { bodyParser: false } };

// Read the raw bytes Stripe signed BEFORE anything touches req.body (reading
// req.body makes the runtime parse — and consume — the stream).
async function readRawBody(req) {
  const chunks = [];
  try { for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk); } catch (_) {}
  if (chunks.length) return Buffer.concat(chunks).toString('utf8');
  const b = req.body;
  if (typeof b === 'string') return b;
  if (Buffer.isBuffer(b)) return b.toString('utf8');
  return b ? JSON.stringify(b) : '';
}

function verifyEvent(raw, sig) {
  const secrets = [process.env.STRIPE_WEBHOOK_SECRET, process.env.STRIPE_CONNECT_WEBHOOK_SECRET].filter(Boolean);
  if (!secrets.length || !sig) return null;
  let s; try { s = stripeClient(); } catch { return null; }
  for (const secret of secrets) {
    try { return s.webhooks.constructEvent(raw, sig, secret); } catch (_) { /* try the next secret */ }
  }
  return null;
}

// Checkout sets metadata.tenant_id (or tenantId / client_reference_id).
function tenantIdFrom(obj) {
  const md = obj.metadata || {}, sd = obj.subscription_details?.metadata || {};
  return md.tenant_id || md.tenantId || obj.client_reference_id || sd.tenant_id || sd.tenantId || null;
}
async function tenantBy(c, key, value) {
  if (!value) return null;
  const { data, error } = await c.from('tenants').select('*').eq(key, value).limit(1);
  if (error) return null;
  return (data || [])[0] || null;
}
async function saveTenant(c, id, patch) {
  // stripe_subscription_id / current_period_end / past_due_since / billing_interval
  // may be missing on older databases (migrations add them) — retry without them.
  let r = await c.from('tenants').update(patch).eq('id', id);
  if (r.error) {
    const core = { ...patch };
    for (const k of ['stripe_subscription_id', 'current_period_end', 'past_due_since', 'billing_interval', 'canceled_at']) delete core[k];
    r = await c.from('tenants').update(core).eq('id', id);
    if (r.error) console.error('[stripe-webhook] tenant update failed:', r.error.message);
  }
}

const iso = (sec) => (sec ? new Date(sec * 1000).toISOString() : null);

/** plan + interval from a subscription object (price first, metadata second). */
function planOfSubscription(sub, fallback) {
  const price = sub?.items?.data?.[0]?.price || sub?.plan || null;
  const fromPrice = planFromPrice(price);
  if (fromPrice) return fromPrice;
  const md = normalizePlan(sub?.metadata?.plan);
  if (md) return { plan: md, interval: sub?.metadata?.interval === 'annual' ? 'annual' : (price?.recurring?.interval === 'year' ? 'annual' : 'monthly') };
  return fallback ? { plan: normalizePlan(fallback) || fallback, interval: null } : null;
}

function subscriptionIdOf(obj) {
  return obj.subscription || obj.parent?.subscription_details?.subscription || obj.lines?.data?.[0]?.subscription || null;
}

async function logMoney(c, tenantId, kind, meta) {
  if (!tenantId) { console.warn('[stripe-webhook]', kind, JSON.stringify(meta || {})); return; }
  try { await c.from('usage_events').insert({ tenant_id: tenantId, kind, units: 1, metadata: meta || {} }); } catch (_) {}
}

async function enforce() { return import('./lib/billing-enforce.js'); }

/**
 * A deposit Payment Link was paid. Only a PENDING deposit may be paid; any
 * other state (paid already, expired/released, void, refunded) — or a booking
 * that is cancelled — means the money goes straight back.
 */
async function depositPaid(c, obj) {
  const link = obj.payment_link;
  const pi = obj.payment_intent || null;
  const claimed = await c.from('deposits').update({ status: 'paid', stripe_payment_intent_id: pi })
    .eq('stripe_payment_intent_id', link).eq('status', 'pending').select().maybeSingle();
  if (claimed.error) console.error('[stripe-webhook] deposit paid update failed:', claimed.error.message);
  let dep = claimed.data || null;
  let refundWhy = null;
  if (!dep) {
    // Same payment delivered again (another event for this session) → nothing to do.
    if (pi) {
      const { data: same } = await c.from('deposits').select('id').eq('stripe_payment_intent_id', pi).limit(1);
      if ((same || []).length) return;
    }
    // The link's deposit is no longer pending (expired / released / void) → refund.
    const { data: rows } = await c.from('deposits').select('*').eq('stripe_payment_intent_id', link).limit(1);
    const known = (rows || [])[0] || null;
    if (known) refundWhy = `deposit_${known.status}`;
    // A deposit link (tagged at creation) whose deposit was already paid → a second payment.
    else if (obj.metadata?.kind === 'deposit') refundWhy = 'deposit_already_paid';
    else {
      await logMoney(c, null, 'deposit_payment_unmatched', { payment_intent: pi, payment_link: link, amount: obj.amount_total ?? null });
      const { alertAdmin } = await enforce();
      await alertAdmin('Unmatched deposit payment', `Payment ${pi || '?'} on link ${link} matches no deposit — check it in Stripe.`);
      return;
    }
    dep = known || { tenant_id: obj.metadata?.tenant_id || null };
  } else if (dep.booking_id) {
    const { data: b } = await c.from('bookings').select('id,status').eq('id', dep.booking_id).maybeSingle();
    if (!b || /^(cancel|declined|no[-_ ]?show)/i.test(String(b.status || ''))) refundWhy = b ? 'booking_' + String(b.status).toLowerCase() : 'booking_missing';
  }
  await deactivatePaymentLink(link);
  if (!refundWhy || !pi) return;
  try {
    await stripeRefund(pi, { metadata: { reason: refundWhy, payment_link: link } });
    if (claimed.data) await c.from('deposits').update({ status: 'refunded' }).eq('id', claimed.data.id).eq('status', 'paid');
    await logMoney(c, dep?.tenant_id, 'deposit_auto_refund', { payment_intent: pi, payment_link: link, reason: refundWhy, amount: obj.amount_total ?? null });
  } catch (e) {
    await logMoney(c, dep?.tenant_id, 'deposit_refund_failed', { payment_intent: pi, payment_link: link, reason: refundWhy, error: String(e?.message || e).slice(0, 200) });
    const { alertAdmin } = await enforce();
    await alertAdmin('Deposit refund failed', `Payment ${pi} on link ${link} (${refundWhy}) could not be refunded automatically: ${String(e?.message || e).slice(0, 200)}`);
  }
}

async function tenantForObj(c, obj) {
  return (await tenantBy(c, 'stripe_subscription_id', subscriptionIdOf(obj) || (String(obj.id || '').startsWith('sub_') ? obj.id : null)))
    || (await tenantBy(c, 'stripe_customer_id', obj.customer))
    || (tenantIdFrom(obj) && (await tenantBy(c, 'id', tenantIdFrom(obj))));
}

async function handleAccountEvent(c, event) {
  const obj = event.data?.object || {};
  switch (event.type) {
    case 'checkout.session.completed': {
      // A booking deposit paid through its Payment Link: pending → paid, and
      // keep the real PaymentIntent id (refunds need it).
      if (obj.payment_link && obj.metadata?.kind === 'no_show_fee') {
        // A missed-appointment fee link (cron/no-show-scan) was paid: the salon's Payments row → succeeded.
        try { await c.from('payments').update({ status: 'succeeded', at_risk: false }).eq('stripe_id', obj.payment_link).eq('sub_kind', 'no_show_fee'); } catch (_) {}
        await deactivatePaymentLink(obj.payment_link);
      } else if (obj.payment_link) await depositPaid(c, obj);
      const tid = tenantIdFrom(obj);
      if (tid && (obj.mode === 'subscription' || obj.subscription)) {
        const { data: t } = await c.from('tenants').select('*').eq('id', tid).maybeSingle();
        if (t) {
          let sub = null;
          if (obj.subscription && typeof obj.subscription === 'object') sub = obj.subscription;
          else if (obj.subscription && process.env.STRIPE_SECRET_KEY) { try { sub = await stripeApi('/subscriptions/' + encodeURIComponent(obj.subscription)); } catch (_) {} }
          const p = planOfSubscription(sub, obj.metadata?.plan) || { plan: normalizePlan(t.plan) || 'starter', interval: null };
          const patch = {
            stripe_customer_id: obj.customer || t.stripe_customer_id || null,
            stripe_subscription_id: (sub?.id || obj.subscription) || t.stripe_subscription_id || null,
            subscription_status: sub?.status === 'trialing' ? 'trialing' : 'active',
            plan: p.plan || 'starter',
            past_due_since: null,
          };
          if (p.interval || obj.metadata?.interval) patch.billing_interval = p.interval || (obj.metadata.interval === 'annual' ? 'annual' : 'monthly');
          if (sub?.current_period_end) patch.current_period_end = iso(sub.current_period_end);
          await saveTenant(c, t.id, patch);
        } else console.error('[stripe-webhook] checkout for unknown tenant', tid);
      }
      break;
    }
    case 'checkout.session.async_payment_failed': {
      if (obj.payment_link) {
        await logMoney(c, null, 'deposit_payment_failed', { payment_link: obj.payment_link, session: obj.id });
        break;
      }
      const t = await tenantForObj(c, obj);
      if (t) {
        await logMoney(c, t.id, 'subscription_payment_failed', { session: obj.id });
        const { notifyOwner, keepLolaLink } = await enforce();
        await notifyOwner(t, `LolaDesk: your payment for ${t.name || 'your salon'} didn't go through. Try another payment method here: ${keepLolaLink()}`, { subject: 'Your LolaDesk payment did not go through' });
      }
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const t = await tenantForObj(c, obj);
      if (t) {
        const p = planOfSubscription(obj, t.plan);
        const status = obj.cancel_at_period_end && obj.status !== 'canceled' ? 'canceling' : (obj.status === 'trialing' ? 'trialing' : obj.status || t.subscription_status);
        const patch = {
          subscription_status: status,
          stripe_subscription_id: obj.id,
          current_period_end: obj.current_period_end ? iso(obj.current_period_end) : (obj.items?.data?.[0]?.current_period_end ? iso(obj.items.data[0].current_period_end) : null),
          plan: p?.plan || normalizePlan(t.plan) || t.plan,
        };
        if (p?.interval) patch.billing_interval = p.interval;
        if (status === 'past_due' && !t.past_due_since) patch.past_due_since = new Date().toISOString();
        if (['active', 'trialing', 'canceling'].includes(status)) patch.past_due_since = null;
        await saveTenant(c, t.id, patch);
      }
      break;
    }
    case 'customer.subscription.deleted': {
      const t = (await tenantBy(c, 'stripe_subscription_id', obj.id)) || (await tenantBy(c, 'stripe_customer_id', obj.customer));
      // Ended now (period end for a scheduled cancel, or immediately after dunning).
      if (t) await saveTenant(c, t.id, { subscription_status: 'canceled', current_period_end: iso(obj.ended_at) || new Date().toISOString(), canceled_at: new Date().toISOString() });
      break;
    }
    case 'customer.subscription.trial_will_end': {
      const t = await tenantForObj(c, obj);
      if (t) {
        const end = obj.trial_end ? new Date(obj.trial_end * 1000) : null;
        const when = end ? end.toLocaleDateString('en-US', { month: 'long', day: 'numeric' }) : 'in a few days';
        const { notifyOwner, keepLolaLink } = await enforce();
        await notifyOwner(t, `Lola here. Your LolaDesk free trial ends ${when}; your card on file will be charged for your ${normalizePlan(t.plan) || 'starter'} plan then. Review or change your plan: ${keepLolaLink()}`, { subject: 'Your LolaDesk trial ends soon' });
      }
      break;
    }
    case 'invoice.paid':
    case 'invoice.payment_succeeded': {
      const t = await tenantBy(c, 'stripe_customer_id', obj.customer);
      if (!t) break;
      const subId = subscriptionIdOf(obj);
      const oneOff = obj.billing_reason === 'manual' || obj.metadata?.kind === 'final_usage';
      if (oneOff) break; // a final-usage invoice never reactivates a cancelled salon
      const cur = String(t.subscription_status || '');
      if (cur === 'canceling') { await saveTenant(c, t.id, { past_due_since: null }); break; }   // respect cancel_at_period_end
      if (cur === 'canceled' && subId && t.stripe_subscription_id && subId !== t.stripe_subscription_id) break;
      if (subId && t.stripe_subscription_id && subId !== t.stripe_subscription_id) break;
      await saveTenant(c, t.id, { subscription_status: 'active', past_due_since: null });
      break;
    }
    case 'invoice.payment_failed': {
      const t = await tenantBy(c, 'stripe_customer_id', obj.customer);
      if (!t) break;
      const oneOff = obj.billing_reason === 'manual' || obj.metadata?.kind === 'final_usage';
      if (oneOff) { await logMoney(c, t.id, 'final_invoice_failed', { invoice: obj.id, amount: obj.amount_due ?? null }); break; }
      if (String(t.subscription_status || '') === 'canceled') break;
      const patch = { subscription_status: 'past_due' };
      if (!t.past_due_since) patch.past_due_since = new Date().toISOString();
      await saveTenant(c, t.id, patch);
      break;
    }
    case 'charge.dispute.created': {
      const pi = obj.payment_intent || null;
      let tenantId = null;
      if (pi) {
        const { data: d } = await c.from('deposits').select('id,tenant_id,booking_id,status').eq('stripe_payment_intent_id', pi).maybeSingle();
        if (d) { tenantId = d.tenant_id; await c.from('deposits').update({ status: 'disputed' }).eq('id', d.id); }
        const r = await c.from('payments').update({ at_risk: true, sub_kind: 'dispute' }).eq('stripe_id', pi).select('tenant_id').maybeSingle();
        tenantId = tenantId || r?.data?.tenant_id || null;
      }
      if (!tenantId && obj.customer) tenantId = (await tenantBy(c, 'stripe_customer_id', obj.customer))?.id || null;
      await logMoney(c, tenantId, 'payment_disputed', { charge: obj.charge || obj.id, payment_intent: pi, amount: obj.amount ?? null, reason: obj.reason || null });
      const { alertAdmin } = await enforce();
      await alertAdmin('Stripe dispute opened', `Dispute ${obj.id} on ${pi || obj.charge || 'a charge'} for $${((Number(obj.amount) || 0) / 100).toFixed(2)} (${obj.reason || 'no reason'})${tenantId ? ' — tenant ' + tenantId : ''}. Respond in the Stripe dashboard before the deadline.`);
      break;
    }
    case 'charge.refunded': {
      const pi = obj.payment_intent || null;
      if (!pi) break;
      const full = obj.refunded === true || (Number(obj.amount_refunded) >= Number(obj.amount) && Number(obj.amount) > 0);
      if (full) await c.from('deposits').update({ status: 'refunded' }).eq('stripe_payment_intent_id', pi).in('status', ['paid', 'kept', 'refunding', 'disputed', 'flagged']);
      await c.from('payments').update({ refunded: true, status: full ? 'refunded' : 'partially_refunded' }).eq('stripe_id', pi);
      break;
    }
  }
}

async function handleConnectEvent(c, event) {
  const obj = event.data?.object || {};
  const connectedAccountId = event.account || null;
  let tenantId = null;
  if (connectedAccountId) {
    const { data: acct } = await c.from('stripe_connect_accounts').select('tenant_id').eq('stripe_account_id', connectedAccountId).maybeSingle();
    tenantId = acct?.tenant_id || null;
  }
  // MMA Studio: a $500 hair deposit paid on the salon's own account (the tenant must match the account).
  if (event.type === 'checkout.session.completed' && obj.metadata?.source === 'mma-studio' && tenantId && obj.metadata.tenant_id === tenantId) {
    await studioDepositPaid(c, obj).catch((e) => console.error('[studio] deposit paid', e.message));
  }
    switch (event.type) {
      // ── Payment lifecycle ──────────────────────────────────
      case 'payment_intent.succeeded': {
        if (!tenantId) break;
        await c.from('payments').upsert({
          tenant_id: tenantId,
          stripe_id: obj.id,
          kind: 'charge',
          status: 'succeeded',
          amount: obj.amount_received || obj.amount || 0,
          currency: obj.currency || 'usd',
          stripe_fee: obj.application_fee_amount || 0,
          card_brand: obj.charges?.data?.[0]?.payment_method_details?.card?.brand || null,
          card_last4: obj.charges?.data?.[0]?.payment_method_details?.card?.last4 || null,
          receipt_url: obj.charges?.data?.[0]?.receipt_url || null,
          description: obj.description || null,
          booking_id: obj.metadata?.booking_id || null,
          client_id: obj.metadata?.client_id || null,
          metadata: obj.metadata || {},
          at_risk: false
        }, { onConflict: 'stripe_id' });
        break;
      }

      case 'payment_intent.payment_failed': {
        if (!tenantId) break;
        await c.from('payments').upsert({
          tenant_id: tenantId,
          stripe_id: obj.id,
          kind: 'charge',
          status: 'failed',
          amount: obj.amount || 0,
          currency: obj.currency || 'usd',
          description: obj.last_payment_error?.message || 'Payment failed',
          booking_id: obj.metadata?.booking_id || null,
          client_id: obj.metadata?.client_id || null,
          metadata: obj.metadata || {},
          at_risk: true
        }, { onConflict: 'stripe_id' });
        break;
      }

      case 'charge.refunded': {
        if (!tenantId) break;
        await c.from('payments').update({
          refunded: true,
          status: 'refunded'
        }).eq('stripe_id', obj.payment_intent).eq('tenant_id', tenantId);
        break;
      }

      case 'charge.dispute.created': {
        if (!tenantId) break;
        await c.from('payments').update({ at_risk: true, sub_kind: 'dispute' })
          .eq('stripe_id', obj.payment_intent).eq('tenant_id', tenantId);
        break;
      }

      // ── Connect account lifecycle ──────────────────────────
      case 'account.updated': {
        if (!tenantId) break;
        await c.from('stripe_connect_accounts').update({
          charges_enabled: !!obj.charges_enabled,
          payouts_enabled: !!obj.payouts_enabled,
          sub_state: obj.details_submitted && obj.charges_enabled ? 'active' : 'pending',
          updated_at: new Date().toISOString()
        }).eq('stripe_account_id', obj.id);
        break;
      }

      // ── Payouts ────────────────────────────────────────────
      case 'payout.paid': {
        if (!tenantId) break;
        // Optionally persist to a payouts table; for now, just log.
        console.log('payout.paid', { tenantId, amount: obj.amount, arrival: obj.arrival_date });
        break;
      }
    }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  const c = db();
  if (!c) return res.status(503).json({ ok: false, error: 'database_not_configured' });
  const raw = await readRawBody(req);
  const event = verifyEvent(raw, req.headers['stripe-signature']);
  if (!event) return res.status(400).json({ ok: false, error: 'invalid_signature_or_secret_missing' });

  // One event, one effect (Stripe retries).
  const seen = await c.from('billing_events').select('id').eq('stripe_event_id', event.id).maybeSingle();
  if (!seen.error && seen.data) return res.json({ received: true, duplicate: true });

  try {
    if (event.account) await handleConnectEvent(c, event);
    else await handleAccountEvent(c, event);
  } catch (e) {
    console.error('[stripe-webhook]', event.type, e?.message || e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) }); // Stripe will retry
  }

  const obj = event.data?.object || {};
  let logTenant = tenantIdFrom(obj);
  if (!logTenant && obj.customer) logTenant = (await tenantBy(c, 'stripe_customer_id', obj.customer))?.id || null;
  const logged = await c.from('billing_events').insert({
    tenant_id: logTenant || null, stripe_event_id: event.id, type: event.type,
    amount: obj.amount_total || obj.amount_paid || obj.amount || null, currency: obj.currency || 'usd',
    status: obj.status || null, data: { customer: obj.customer || null, subscription: obj.subscription || null, account: event.account || null },
  });
  if (logged.error) console.warn('[stripe-webhook] event log failed:', logged.error.message);
  return res.json({ received: true, type: event.type });
}
