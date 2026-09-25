// POST /api/stripe/connect/payout-now
// Body: { amount?: cents, currency?: 'usd', method?: 'standard'|'instant' }
// If amount is omitted, pays out the full instant_available amount.
import { cors, jsonBody } from '../../lib/cors.js';
import { bearer, getUserFromToken } from '../../lib/auth.js';
import { resolveTenantForUser } from '../../lib/tenant-access.js';
import { connectAccount, stripe, stripeFor } from '../../lib/stripe.js';

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

    const body = jsonBody(req) || {};
    const s = stripeFor(tenant.id, account.stripe_account_id);
    const raw = stripe();

    // Resolve amount from body OR from current available balance.
    let amount = parseInt(body.amount, 10);
    let currency = (body.currency || 'usd').toLowerCase();
    const method = body.method === 'instant' ? 'instant' : 'standard';

    if (!amount || amount <= 0) {
      const bal = await s.balance();
      const pool = method === 'instant' ? (bal.instant_available || []) : (bal.available || []);
      if (!pool.length) return res.status(400).json({ ok: false, error: 'no_available_balance' });
      currency = pool[0].currency;
      amount = pool.reduce((n, f) => n + (f.currency === currency ? f.amount : 0), 0);
      if (amount <= 0) return res.status(400).json({ ok: false, error: 'no_available_balance' });
    }

    const payout = await raw.payouts.create(
      { amount, currency, method },
      { stripeAccount: account.stripe_account_id }
    );

    return res.json({
      ok: true,
      data: {
        id: payout.id,
        amount: payout.amount,
        currency: payout.currency,
        method: payout.method,
        status: payout.status,
        arrival_date: payout.arrival_date
      }
    });
  } catch (e) {
    console.error('[connect/payout-now]', e?.message);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
