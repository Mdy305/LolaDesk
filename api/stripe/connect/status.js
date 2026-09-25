// GET /api/stripe/connect/status
// Whether this tenant has a connected Stripe account, and its readiness.
// Refreshes charges_enabled / payouts_enabled from Stripe on every call.
import { cors } from '../../lib/cors.js';
import { bearer, getUserFromToken } from '../../lib/auth.js';
import { resolveTenantForUser } from '../../lib/tenant-access.js';
import { db } from '../../lib/db.js';
import { stripePlatform, connectAccount } from '../../lib/stripe.js';

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  try {
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'not_authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no_tenant' });

    const account = await connectAccount(tenant.id);
    if (!account) {
      return res.json({
        ok: true,
        data: {
          connected: false,
          charges_enabled: false,
          payouts_enabled: false,
          business_name: tenant.name || '',
          requirements: null
        }
      });
    }

    const stripe = stripePlatform();
    const remote = await stripe.retrieveAccount(account.stripe_account_id);

    const patch = {
      charges_enabled: !!remote.charges_enabled,
      payouts_enabled: !!remote.payouts_enabled,
      sub_state: remote.details_submitted && remote.charges_enabled ? 'active' : 'pending',
      updated_at: new Date().toISOString()
    };
    await db().from('stripe_connect_accounts').update(patch).eq('tenant_id', tenant.id);

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
    console.error('[connect/status]', e?.message);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
