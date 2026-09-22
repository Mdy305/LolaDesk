// POST /api/stripe/connect-link
// Generates a one-time onboarding URL. Frontend redirects the browser to it.
import { cors, jsonBody } from '../lib/cors.js';
import { bearer, getUserFromToken } from '../lib/auth.js';
import { resolveTenantForUser } from '../lib/tenant-access.js';
import { stripePlatform, connectAccount } from '../lib/stripe.js';

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  try {
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'not_authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no_tenant' });

    const account = await connectAccount(tenant.id);
    if (!account) return res.status(400).json({ ok: false, error: 'not_connected', hint: 'POST /api/stripe/connect-account first' });

    const body = jsonBody(req);
    const base = process.env.APP_URL || 'https://loladesk.com';
    const returnUrl = body.return_url || `${base}/banking.html?connected=1`;
    const refreshUrl = body.refresh_url || `${base}/banking.html?refresh=1`;

    const stripe = stripePlatform();
    const link = await stripe.createAccountLink({
      account: account.stripe_account_id,
      refresh_url: refreshUrl,
      return_url: returnUrl,
      type: 'account_onboarding'
    });

    return res.json({ ok: true, url: link.url, expires_at: link.expires_at });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
