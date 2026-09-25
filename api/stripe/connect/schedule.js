// GET  /api/stripe/connect/schedule → current payout schedule
// POST /api/stripe/connect/schedule → update it
// Body: { interval: 'daily'|'weekly'|'monthly'|'manual', weekly_anchor?, monthly_anchor? }
import { cors, jsonBody } from '../../lib/cors.js';
import { bearer, getUserFromToken } from '../../lib/auth.js';
import { resolveTenantForUser } from '../../lib/tenant-access.js';
import { connectAccount, stripeFor, stripePlatform } from '../../lib/stripe.js';

export default async function handler(req, res) {
  if (cors(req, res)) return;
  try {
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'not_authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no_tenant' });

    const account = await connectAccount(tenant.id);
    if (!account) return res.status(400).json({ ok: false, error: 'not_connected' });

    if (req.method === 'GET') {
      const platform = stripePlatform();
      const acct = await platform.retrieveAccount(account.stripe_account_id);
      const schedule = acct.settings?.payouts?.schedule || {};
      return res.json({
        ok: true,
        data: {
          interval: schedule.interval || 'daily',
          weekly_anchor: schedule.weekly_anchor || null,
          monthly_anchor: schedule.monthly_anchor || null,
          delay_days: schedule.delay_days ?? null
        }
      });
    }

    if (req.method === 'POST') {
      const body = jsonBody(req) || {};
      const patch = { interval: body.interval || 'daily' };
      if (body.weekly_anchor)  patch.weekly_anchor  = body.weekly_anchor;
      if (body.monthly_anchor) patch.monthly_anchor = body.monthly_anchor;

      const s = stripeFor(tenant.id, account.stripe_account_id);
      const updated = await s.updateSchedule(patch);
      const schedule = updated.settings?.payouts?.schedule || {};
      return res.json({
        ok: true,
        data: {
          interval: schedule.interval,
          weekly_anchor: schedule.weekly_anchor || null,
          monthly_anchor: schedule.monthly_anchor || null,
          delay_days: schedule.delay_days ?? null
        }
      });
    }

    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  } catch (e) {
    console.error('[connect/schedule]', e?.message);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
