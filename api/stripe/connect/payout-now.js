// POST /api/stripe/connect/payout-now
export default async function handler(req, res) {
  let cors, jsonBody, bearer, getUserFromToken, resolveTenantForUser, connectAccount, stripeFor, stripe;
  try {
    ({ cors, jsonBody } = await import('../../lib/cors.js'));
    ({ bearer, getUserFromToken } = await import('../../lib/auth.js'));
    ({ resolveTenantForUser } = await import('../../lib/tenant-access.js'));
    ({ connectAccount, stripeFor, stripe } = await import('../../lib/stripe.js'));
  } catch (e) { return res.status(500).json({ ok: false, error: 'import_failed', message: String(e?.message || e) }); }

  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  try {
    if (cors && cors(req, res)) return;
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'not_authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no_tenant' });
    const account = await connectAccount(tenant.id);
    if (!account) return res.status(400).json({ ok: false, error: 'not_connected' });

    const body = (jsonBody ? jsonBody(req) : null) || {};
    const s = stripeFor(tenant.id, account.stripe_account_id);
    const raw = stripe();
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

    const payout = await raw.payouts.create({ amount, currency, method }, { stripeAccount: account.stripe_account_id });
    return res.json({ ok: true, data: {
      id: payout.id, amount: payout.amount, currency: payout.currency,
      method: payout.method, status: payout.status, arrival_date: payout.arrival_date
    }});
  } catch (e) { return res.status(500).json({ ok: false, error: String(e?.message || e) }); }
}
