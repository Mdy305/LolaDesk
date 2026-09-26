// GET /api/stripe/connect/status
export default async function handler(req, res) {
  let cors, bearer, getUserFromToken, resolveTenantForUser, dbFn, stripePlatform, connectAccount;
  try {
    const m1 = await import('../../lib/cors.js');           cors = m1.cors;
    const m2 = await import('../../lib/auth.js');           bearer = m2.bearer; getUserFromToken = m2.getUserFromToken;
    const m3 = await import('../../lib/tenant-access.js');  resolveTenantForUser = m3.resolveTenantForUser;
    const m4 = await import('../../lib/db.js');             dbFn = m4.db;
    const m5 = await import('../../lib/stripe.js');         stripePlatform = m5.stripePlatform; connectAccount = m5.connectAccount;
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'import_failed', message: String(e?.message || e) });
  }

  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  try {
    if (cors && cors(req, res)) return;
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'not_authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no_tenant' });

    const account = await connectAccount(tenant.id);
    if (!account) {
      return res.json({
        ok: true,
        data: { connected: false, charges_enabled: false, payouts_enabled: false, business_name: tenant.name || '', requirements: null }
      });
    }

    const stripe = stripePlatform();
    const remote = await stripe.retrieveAccount(account.stripe_account_id);
    try {
      await dbFn().from('stripe_connect_accounts').update({
        charges_enabled: !!remote.charges_enabled,
        payouts_enabled: !!remote.payouts_enabled,
        sub_state: remote.details_submitted && remote.charges_enabled ? 'active' : 'pending',
        updated_at: new Date().toISOString()
      }).eq('tenant_id', tenant.id);
    } catch (_) { /* non-fatal */ }

    return res.json({
      ok: true,
      data: {
        connected: true,
        charges_enabled: !!remote.charges_enabled,
        payouts_enabled: !!remote.payouts_enabled,
        details_submitted: !!remote.details_submitted,
        business_name: remote.business_profile?.name || tenant.name || '',
        default_currency: remote.default_currency || 'usd',
        country: remote.country || 'US',
        requirements: remote.requirements || null,
        payouts: remote.settings?.payouts || null,
        stripe_account_id: account.stripe_account_id
      }
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
