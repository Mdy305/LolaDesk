/**
 * /api/forwarding — keep your salon number, forward what you miss to Lola.
 *   GET  ?carrier=att|tmobile|verizon|landline → { plan, status }
 *   POST { salon_number }                      → LolaDesk calls it to prove forwarding works
 */
import { getUserFromToken, bearer } from './lib/auth.js';
import { resolveTenantForUser } from './lib/tenant-access.js';
import { db } from './lib/db.js';
import { forwardingPlan, forwardingStatus, startForwardingTest, CARRIERS } from './lib/forwarding.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const user = await getUserFromToken(bearer(req)).catch(() => null);
  if (!user) return res.status(401).json({ ok: false, error: 'not signed in' });
  const tenant = await resolveTenantForUser(user).catch(() => null);
  const c = db();
  if (!tenant?.id || !c) return res.status(404).json({ ok: false, error: 'no salon' });
  if (req.method === 'GET') {
    const carrier = String((req.query && req.query.carrier) || 'att');
    return res.json({ ok: true, carriers: Object.fromEntries(Object.entries(CARRIERS).map(([k, v]) => [k, v.name])), plan: forwardingPlan(tenant.phone_number, carrier), status: await forwardingStatus(c, tenant.id) });
  }
  if (req.method === 'POST') {
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    return res.json(await startForwardingTest(c, tenant, b.salon_number));
  }
  return res.status(405).json({ ok: false });
}
