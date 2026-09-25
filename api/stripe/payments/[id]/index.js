// GET /api/stripe/payments/:id
// Details for a single PaymentIntent on the tenant's Connect account.
import { cors } from '../../../lib/cors.js';
import { bearer, getUserFromToken } from '../../../lib/auth.js';
import { resolveTenantForUser } from '../../../lib/tenant-access.js';
import { connectAccount, stripeFor } from '../../../lib/stripe.js';

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  try {
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'not_authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no_tenant' });

    const account = await connectAccount(tenant.id);
    if (!account) return res.status(400).json({ ok: false, error: 'not_connected' });

    const id = String(req.query.id || '').trim();
    if (!id.startsWith('pi_') && !id.startsWith('ch_')) {
      return res.status(400).json({ ok: false, error: 'bad_id' });
    }

    const s = stripeFor(tenant.id, account.stripe_account_id);
    const pi = id.startsWith('pi_') ? await s.retrievePaymentIntent(id)
                                    : await s.raw.charges.retrieve(id, { stripeAccount: account.stripe_account_id });

    // Guard tenant ownership via metadata when possible.
    const meta = pi?.metadata || {};
    if (meta.tenant_id && meta.tenant_id !== tenant.id) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }

    // Also fetch any refunds against this payment_intent.
    let refunds = [];
    try {
      const list = await s.raw.refunds.list(
        { payment_intent: id.startsWith('pi_') ? id : undefined, charge: id.startsWith('ch_') ? id : undefined, limit: 20 },
        { stripeAccount: account.stripe_account_id }
      );
      refunds = list.data || [];
    } catch { /* ignore */ }

    return res.json({
      ok: true,
      data: {
        id: pi.id,
        amount: pi.amount,
        amount_received: pi.amount_received ?? pi.amount_captured ?? pi.amount,
        currency: pi.currency,
        status: pi.status,
        description: pi.description || '',
        created: pi.created,
        customer: pi.customer || null,
        receipt_email: pi.receipt_email || null,
        latest_charge: pi.latest_charge || null,
        metadata: meta,
        refunds: refunds.map(r => ({
          id: r.id, amount: r.amount, reason: r.reason, status: r.status, created: r.created
        }))
      }
    });
  } catch (e) {
    console.error('[payments/:id]', e?.message);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
