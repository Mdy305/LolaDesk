// GET /api/stripe/connect/payouts?limit=25
// Recent payouts on the tenant's Connect account.
import { cors } from '../../lib/cors.js';
import { bearer, getUserFromToken } from '../../lib/auth.js';
import { resolveTenantForUser } from '../../lib/tenant-access.js';
import { connectAccount, stripeFor } from '../../lib/stripe.js';

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

    const limit = Math.min(parseInt(req.query.limit || '25', 10) || 25, 100);
    const s = stripeFor(tenant.id, account.stripe_account_id);
    const list = await s.payouts(limit);

    const rows = (list.data || []).map(p => ({
      id: p.id,
      amount: p.amount,
      currency: p.currency,
      status: p.status,                              // 'paid' | 'pending' | 'in_transit' | 'failed' | 'canceled'
      arrival_date: p.arrival_date,                  // unix
      created: p.created,                            // unix
      method: p.method,                              // 'standard' | 'instant'
      type: p.type,                                  // 'bank_account' | 'card'
      description: p.description || '',
      failure_message: p.failure_message || null
    }));

    return res.json({
      ok: true,
      data: {
        rows,
        has_more: !!list.has_more,
        count: rows.length
      }
    });
  } catch (e) {
    console.error('[connect/payouts]', e?.message);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
