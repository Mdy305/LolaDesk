// GET /api/stripe/connect/balance
// Current available + pending balance on the tenant's Connect account.
import { cors } from '../../lib/cors.js';
import { bearer, getUserFromToken } from '../../lib/auth.js';
import { resolveTenantForUser } from '../../lib/tenant-access.js';
import { connectAccount, stripeFor } from '../../lib/stripe.js';

function sumFundsList(list) {
  if (!Array.isArray(list) || list.length === 0) return { amount: 0, currency: 'usd' };
  const currency = list[0].currency || 'usd';
  const amount = list.reduce((s, f) => s + (f.currency === currency ? f.amount : 0), 0);
  return { amount, currency };
}

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

    const s = stripeFor(tenant.id, account.stripe_account_id);
    const bal = await s.balance();

    const available = sumFundsList(bal.available);
    const pending = sumFundsList(bal.pending);
    const inTransit = sumFundsList(bal.instant_available || []);

    return res.json({
      ok: true,
      data: {
        available_amount: available.amount,
        pending_amount: pending.amount,
        in_transit_amount: inTransit.amount,
        currency: available.currency,
        raw: { available: bal.available, pending: bal.pending }
      }
    });
  } catch (e) {
    console.error('[connect/balance]', e?.message);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
