// GET /api/stripe/connect/balance
function sumFunds(list) {
  if (!Array.isArray(list) || !list.length) return { amount: 0, currency: 'usd' };
  const currency = list[0].currency || 'usd';
  return { amount: list.reduce((s, f) => s + (f.currency === currency ? f.amount : 0), 0), currency };
}
export default async function handler(req, res) {
  let cors, bearer, getUserFromToken, resolveTenantForUser, connectAccount, stripeFor;
  try {
    ({ cors } = await import('../../lib/cors.js'));
    ({ bearer, getUserFromToken } = await import('../../lib/auth.js'));
    ({ resolveTenantForUser } = await import('../../lib/tenant-access.js'));
    ({ connectAccount, stripeFor } = await import('../../lib/stripe.js'));
  } catch (e) { return res.status(500).json({ ok: false, error: 'import_failed', message: String(e?.message || e) }); }

  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  try {
    if (cors && cors(req, res)) return;
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'not_authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no_tenant' });
    const account = await connectAccount(tenant.id);
    if (!account) return res.status(400).json({ ok: false, error: 'not_connected' });

    const s = stripeFor(tenant.id, account.stripe_account_id);
    const bal = await s.balance();
    const available = sumFunds(bal.available);
    const pending = sumFunds(bal.pending);
    const inTransit = sumFunds(bal.instant_available || []);
    return res.json({
      ok: true,
      data: {
        available_amount: available.amount, pending_amount: pending.amount, in_transit_amount: inTransit.amount,
        currency: available.currency, raw: { available: bal.available, pending: bal.pending }
      }
    });
  } catch (e) { return res.status(500).json({ ok: false, error: String(e?.message || e) }); }
}
