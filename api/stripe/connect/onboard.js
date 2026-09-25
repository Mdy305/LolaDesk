// POST /api/stripe/connect/onboard
// Idempotent: creates the Express account if missing, then returns an
// onboarding URL. Frontend redirects the browser to `data.url`.
import { cors, jsonBody } from '../../lib/cors.js';
import { bearer, getUserFromToken } from '../../lib/auth.js';
import { resolveTenantForUser } from '../../lib/tenant-access.js';
import { db } from '../../lib/db.js';
import { stripePlatform, connectAccount } from '../../lib/stripe.js';

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  try {
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'not_authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no_tenant' });

    const stripe = stripePlatform();
    let account = await connectAccount(tenant.id);

    // Create the Express account on first call.
    if (!account) {
      const created = await stripe.createExpressAccount({
        email: user.email,
        country: 'US',
        business_type: 'individual',
        metadata: { tenant_id: tenant.id, tenant_name: tenant.name || '' }
      });
      const { data, error } = await db().from('stripe_connect_accounts').insert({
        tenant_id: tenant.id,
        stripe_account_id: created.id,
        sub_state: 'pending',
        charges_enabled: false,
        payouts_enabled: false
      }).select().single();
      if (error) throw error;
      account = data;
    }

    const body = jsonBody(req) || {};
    const base = process.env.APP_URL || 'https://loladesk.com';
    const returnUrl = body.return_url || `${base}/banking?connected=1`;
    const refreshUrl = body.refresh_url || `${base}/banking?refresh=1`;

    const link = await stripe.createAccountLink({
      account: account.stripe_account_id,
      refresh_url: refreshUrl,
      return_url: returnUrl,
      type: 'account_onboarding'
    });

    return res.json({
      ok: true,
      data: {
        url: link.url,
        expires_at: link.expires_at,
        stripe_account_id: account.stripe_account_id
      }
    });
  } catch (e) {
    console.error('[connect/onboard]', e?.message);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
