// POST /api/stripe/payments/:id/refund
// Body: { amount?: cents, reason?: 'requested_by_customer'|'duplicate'|'fraudulent' }
// Full refund if amount omitted.
import { cors, jsonBody } from '../../../lib/cors.js';
import { bearer, getUserFromToken } from '../../../lib/auth.js';
import { resolveTenantForUser } from '../../../lib/tenant-access.js';
import { connectAccount, stripeFor } from '../../../lib/stripe.js';

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  try {
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'not_authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no_tenant' });

    const account = await connectAccount(tenant.id);
    if (!account) return res.status(400).json({ ok: false, error: 'not_connected' });

    const id = String(req.query.id || '').trim();
    if (!id.startsWith('pi_')) return res.status(400).json({ ok: false, error: 'bad_id', hint: 'expects a PaymentIntent id (pi_...)' });

    const body = jsonBody(req) || {};
    const s = stripeFor(tenant.id, account.stripe_account_id);

    // Ownership guard.
    const pi = await s.retrievePaymentIntent(id);
    const meta = pi?.metadata || {};
    if (meta.tenant_id && meta.tenant_id !== tenant.id) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }

    const opts = {};
    if (Number.isFinite(+body.amount) && +body.amount > 0) opts.amount = parseInt(body.amount, 10);
    if (body.reason) opts.reason = String(body.reason);

    const refund = await s.refund(id, opts);

    return res.json({
      ok: true,
      data: {
        id: refund.id,
        amount: refund.amount,
        currency: refund.currency,
        status: refund.status,
        reason: refund.reason,
        payment_intent: refund.payment_intent,
        created: refund.created
      }
    });
  } catch (e) {
    console.error('[payments/refund]', e?.message);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
