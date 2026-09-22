// POST /api/stripe/payments/:id/refund — refund a payment via Stripe.
// The frontend calls the [id]/refund shape; wire this via vercel.json
// rewrites or place at api/stripe/payments/[id]/refund.js if you use
// Vercel's dynamic segments.
import { cors, jsonBody } from '../lib/cors.js';
import { bearer, getUserFromToken } from '../lib/auth.js';
import { resolveTenantForUser } from '../lib/tenant-access.js';
import { db } from '../lib/db.js';
import { connectAccount, stripeFor } from '../lib/stripe.js';

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  try {
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'not_authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no_tenant' });

    // Payment id comes from either req.query.id (Vercel dynamic segment) or the URL path.
    const paymentId = req.query?.id || req.query?.paymentId;
    if (!paymentId) return res.status(400).json({ ok: false, error: 'missing_payment_id' });

    const body = jsonBody(req);
    const c = db();

    // Load the payment and verify tenant ownership.
    const { data: payment } = await c.from('payments')
      .select('id, tenant_id, stripe_id, amount, refunded, kind, status')
      .eq('id', paymentId)
      .eq('tenant_id', tenant.id)
      .maybeSingle();
    if (!payment) return res.status(404).json({ ok: false, error: 'payment_not_found' });
    if (payment.refunded) return res.status(400).json({ ok: false, error: 'already_refunded' });
    if (payment.kind !== 'charge') return res.status(400).json({ ok: false, error: 'only_charges_refundable' });
    if (payment.status !== 'succeeded') return res.status(400).json({ ok: false, error: 'not_settled' });

    const account = await connectAccount(tenant.id);
    if (!account) return res.status(400).json({ ok: false, error: 'not_connected' });
    const stripe = stripeFor(tenant.id, account.stripe_account_id);

    const refund = await stripe.refund(payment.stripe_id, {
      amount: body.amount ? Number(body.amount) : undefined,
      reason: body.reason ? 'requested_by_customer' : undefined,
      metadata: body.reason ? { owner_note: String(body.reason).slice(0, 500) } : undefined
    });

    // Mark the payment refunded and write a refund row for the payments feed.
    await c.from('payments').update({ refunded: true, status: 'refunded' }).eq('id', payment.id);
    await c.from('payments').insert({
      tenant_id: tenant.id,
      stripe_id: refund.id,
      kind: 'refund',
      status: 'succeeded',
      amount: refund.amount,
      currency: refund.currency,
      client_name: null,
      description: 'Refund' + (body.reason ? ' — ' + String(body.reason).slice(0,200) : ''),
      booking_id: null,
      metadata: { original_payment_id: payment.id }
    });

    return res.json({
      ok: true,
      refund_id: refund.id,
      arrival: 'client sees it in 5–10 business days'
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
