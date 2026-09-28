/**
 * POST /api/stripe-webhook — the ONE Stripe webhook (api/billing/webhook.js re-exports it).
 * ════════════════════════════════════════════════════════════════════
 * Two kinds of events arrive here:
 *   • Your account (LolaDesk billing + booking deposits):
 *       checkout.session.completed      → activate the salon's plan; deposit link paid → deposit 'paid'
 *       customer.subscription.updated   → active / canceling / past_due …
 *       customer.subscription.deleted   → canceled
 *       invoice.payment_succeeded       → active
 *       invoice.payment_failed          → past_due
 *   • Connected accounts (salon Stripe Connect): payment_intent.*, charge.*, account.updated, payout.paid
 * The Sep 22 rewrite kept only the Connect half, so paying salons were never
 * activated and deposits were never marked paid. Both halves live here now.
 *
 * Stripe dashboard: add this URL twice — once for "Your account" events and
 * once for "Connected accounts" events. Put the first signing secret in
 * STRIPE_WEBHOOK_SECRET and the second in STRIPE_CONNECT_WEBHOOK_SECRET.
 */
import { db } from './lib/db.js';
import { stripe as stripeClient } from './lib/stripe.js';

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
  // stripe_subscription_id / current_period_end may be missing on older
  // databases (sql/launch-pack.sql adds them) — retry without them.
  let r = await c.from('tenants').update(patch).eq('id', id);
  if (r.error) {
    const core = { ...patch }; delete core.stripe_subscription_id; delete core.current_period_end;
    r = await c.from('tenants').update(core).eq('id', id);
    if (r.error) console.error('[stripe-webhook] tenant update failed:', r.error.message);
  }
}

async function handleAccountEvent(c, event) {
  const obj = event.data?.object || {};
  switch (event.type) {
    case 'checkout.session.completed': {
      // A booking deposit paid through its Payment Link: pending → paid, and
      // keep the real PaymentIntent id (refunds need it).
      if (obj.payment_link) {
        const r = await c.from('deposits').update({ status: 'paid', stripe_payment_intent_id: obj.payment_intent || null })
          .eq('stripe_payment_intent_id', obj.payment_link);
        if (r.error) console.error('[stripe-webhook] deposit paid update failed:', r.error.message);
      }
      const tid = tenantIdFrom(obj);
      if (tid && (obj.mode === 'subscription' || obj.subscription)) {
        const { data: t } = await c.from('tenants').select('*').eq('id', tid).maybeSingle();
        if (t) await saveTenant(c, t.id, {
          stripe_customer_id: obj.customer || t.stripe_customer_id || null,
          stripe_subscription_id: obj.subscription || t.stripe_subscription_id || null,
          subscription_status: 'active',
          plan: obj.metadata?.plan || t.plan || 'starter',
        });
        else console.error('[stripe-webhook] checkout for unknown tenant', tid);
      }
      break;
    }
    case 'customer.subscription.updated': {
      const t = (await tenantBy(c, 'stripe_subscription_id', obj.id)) || (await tenantBy(c, 'stripe_customer_id', obj.customer)) || (tenantIdFrom(obj) && (await tenantBy(c, 'id', tenantIdFrom(obj))));
      if (t) await saveTenant(c, t.id, {
        subscription_status: obj.cancel_at_period_end ? 'canceling' : (obj.status === 'trialing' ? 'trialing' : obj.status || t.subscription_status),
        stripe_subscription_id: obj.id,
        current_period_end: obj.current_period_end ? new Date(obj.current_period_end * 1000).toISOString() : null,
        plan: obj.metadata?.plan || t.plan,
      });
      break;
    }
    case 'customer.subscription.deleted': {
      const t = (await tenantBy(c, 'stripe_subscription_id', obj.id)) || (await tenantBy(c, 'stripe_customer_id', obj.customer));
      if (t) await saveTenant(c, t.id, { subscription_status: 'canceled' });
      break;
    }
    case 'invoice.payment_succeeded': {
      const t = await tenantBy(c, 'stripe_customer_id', obj.customer);
      if (t) await saveTenant(c, t.id, { subscription_status: 'active' });
      break;
    }
    case 'invoice.payment_failed': {
      const t = await tenantBy(c, 'stripe_customer_id', obj.customer);
      if (t) await saveTenant(c, t.id, { subscription_status: 'past_due' });
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
