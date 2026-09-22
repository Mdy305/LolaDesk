// GET  /api/stripe/connect-account  → current Connect account status
// POST /api/stripe/connect-account  → create a new Connect Express account
//                                     (call once, then POST connect-link)
import { cors } from '../lib/cors.js';
import { bearer, getUserFromToken } from '../lib/auth.js';
import { resolveTenantForUser } from '../lib/tenant-access.js';
import { db } from '../lib/db.js';
import { stripePlatform, connectAccount } from '../lib/stripe.js';

export default async function handler(req, res) {
  if (cors(req, res)) return;
  try {
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'not_authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no_tenant' });

    const c = db();

    if (req.method === 'GET') {
      const account = await connectAccount(tenant.id);
      if (!account) return res.json({ ok: true, connected: false, account: null });

      // Refresh state from Stripe.
      const stripe = stripePlatform();
      const remote = await stripe.retrieveAccount(account.stripe_account_id);

      const patch = {
        charges_enabled: !!remote.charges_enabled,
        payouts_enabled: !!remote.payouts_enabled,
        sub_state: remote.details_submitted && remote.charges_enabled ? 'active' : 'pending',
        updated_at: new Date().toISOString()
      };
      await c.from('stripe_connect_accounts').update(patch).eq('tenant_id', tenant.id);

      return res.json({
        ok: true,
        connected: true,
        account: { ...account, ...patch },
        stripe: {
          details_submitted: remote.details_submitted,
          charges_enabled: remote.charges_enabled,
          payouts_enabled: remote.payouts_enabled,
          requirements: remote.requirements || null
        }
      });
    }

    if (req.method === 'POST') {
      // Idempotent: return existing if already created.
      const existing = await connectAccount(tenant.id);
      if (existing) return res.json({ ok: true, account: existing, already_exists: true });

      const stripe = stripePlatform();
      const created = await stripe.createExpressAccount({
        email: user.email,
        country: 'US',
        business_type: 'individual',
        metadata: { tenant_id: tenant.id, tenant_name: tenant.name || '' }
      });

      const { data, error } = await c.from('stripe_connect_accounts').insert({
        tenant_id: tenant.id,
        stripe_account_id: created.id,
        sub_state: 'pending',
        charges_enabled: false,
        payouts_enabled: false
      }).select().single();
      if (error) throw error;

      return res.json({ ok: true, account: data });
    }

    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
