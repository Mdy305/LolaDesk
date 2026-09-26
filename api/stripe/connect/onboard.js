// POST /api/stripe/connect/onboard
export default async function handler(req, res) {
  let cors, jsonBody, bearer, getUserFromToken, resolveTenantForUser, dbFn, stripePlatform, connectAccount;
  try {
    const m1 = await import('../../lib/cors.js');           cors = m1.cors; jsonBody = m1.jsonBody;
    const m2 = await import('../../lib/auth.js');           bearer = m2.bearer; getUserFromToken = m2.getUserFromToken;
    const m3 = await import('../../lib/tenant-access.js');  resolveTenantForUser = m3.resolveTenantForUser;
    const m4 = await import('../../lib/db.js');             dbFn = m4.db;
    const m5 = await import('../../lib/stripe.js');         stripePlatform = m5.stripePlatform; connectAccount = m5.connectAccount;
  } catch (e) { return res.status(500).json({ ok: false, error: 'import_failed', message: String(e?.message || e) }); }

  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  try {
    if (cors && cors(req, res)) return;
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'not_authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no_tenant' });

    const stripe = stripePlatform();
    let account = await connectAccount(tenant.id);
    if (!account) {
      const created = await stripe.createExpressAccount({
        email: user.email, country: 'US', business_type: 'individual',
        metadata: { tenant_id: tenant.id, tenant_name: tenant.name || '' }
      });
      const { data, error } = await dbFn().from('stripe_connect_accounts').insert({
        tenant_id: tenant.id, stripe_account_id: created.id,
        sub_state: 'pending', charges_enabled: false, payouts_enabled: false
      }).select().single();
      if (error) throw error;
      account = data;
    }

    const body = (jsonBody ? jsonBody(req) : null) || {};
    const base = process.env.APP_URL || 'https://loladesk.com';
    const link = await stripe.createAccountLink({
      account: account.stripe_account_id,
      refresh_url: body.refresh_url || `${base}/banking?refresh=1`,
      return_url: body.return_url || `${base}/banking?connected=1`,
      type: 'account_onboarding'
    });

    return res.json({ ok: true, data: { url: link.url, expires_at: link.expires_at, stripe_account_id: account.stripe_account_id } });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
