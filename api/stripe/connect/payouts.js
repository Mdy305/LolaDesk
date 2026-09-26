// GET /api/stripe/connect/payouts?limit=25
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

    const limit = Math.min(parseInt(req.query.limit || '25', 10) || 25, 100);
    const s = stripeFor(tenant.id, account.stripe_account_id);
    const list = await s.payouts(limit);
    const rows = (list.data || []).map(p => ({
      id: p.id, amount: p.amount, currency: p.currency, status: p.status,
      arrival_date: p.arrival_date, created: p.created, method: p.method, type: p.type,
      description: p.description || '', failure_message: p.failure_message || null
    }));
    return res.json({ ok: true, data: { rows, has_more: !!list.has_more, count: rows.length } });
  } catch (e) { return res.status(500).json({ ok: false, error: String(e?.message || e) }); }
}
