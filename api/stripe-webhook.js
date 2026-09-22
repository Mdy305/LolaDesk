// POST /api/stripe-webhook
// Handles Stripe Connect webhook events. Verifies signature via raw body.
import { db } from './lib/db.js';
import { verifyStripeSig } from './lib/stripe.js';

export const config = { api: { bodyParser: false } };

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

  const raw = await readRawBody(req);
  const sig = req.headers['stripe-signature'];
  const event = verifyStripeSig(raw, sig);
  if (!event) return res.status(401).json({ ok: false, error: 'invalid_signature' });

  const c = db();
  const obj = event.data?.object || {};

  try {
    // Locate tenant by connected account id.
    const connectedAccountId = event.account || null;
    let tenantId = null;
    if (connectedAccountId) {
      const { data: acct } = await c.from('stripe_connect_accounts')
        .select('tenant_id')
        .eq('stripe_account_id', connectedAccountId)
        .maybeSingle();
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

    return res.status(200).json({ ok: true, received: event.type });
  } catch (e) {
    console.error('stripe-webhook error', e);
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
