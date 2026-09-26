// POST /api/stripe/connect/dashboard
export default async function handler(req, res) {
  let cors, bearer, getUserFromToken, resolveTenantForUser, connectAccount, stripePlatform;
  try {
    ({ cors } = await import('../../lib/cors.js'));
    ({ bearer, getUserFromToken } = await import('../../lib/auth.js'));
    ({ resolveTenantForUser } = await import('../../lib/tenant-access.js'));
    ({ connectAccount, stripePlatform } = await import('../../lib/stripe.js'));
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

    const link = await stripePlatform().createDashboardLink(account.stripe_account_id);
    return res.json({ ok: true, data: { url: link.url, created: link.created } });
  } catch (e) { return res.status(500).json({ ok: false, error: String(e?.message || e) }); }
}
