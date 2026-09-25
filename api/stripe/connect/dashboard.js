// POST /api/stripe/connect/dashboard
// Returns a one-time URL to the Stripe Express dashboard for this tenant.
import { cors } from '../../lib/cors.js';
import { bearer, getUserFromToken } from '../../lib/auth.js';
import { resolveTenantForUser } from '../../lib/tenant-access.js';
import { connectAccount, stripePlatform } from '../../lib/stripe.js';

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

    const platform = stripePlatform();
    const link = await platform.createDashboardLink(account.stripe_account_id);

    return res.json({ ok: true, data: { url: link.url, created: link.created } });
  } catch (e) {
    console.error('[connect/dashboard]', e?.message);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
