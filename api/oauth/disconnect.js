/**
 * POST /api/oauth/disconnect  (Authorization: Bearer <access_token>)
 * { provider }
 * Disconnects the provider by deleting the integration record for the tenant.
 */
import { getUserFromToken, bearer } from '../lib/auth.js';
import { db } from '../lib/db.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ error: 'not authenticated' });

    const c = db();
    if (!c) return res.status(503).json({ error: 'database not configured' });

    const { data: rows } = await c.from('tenants').select('id').eq('owner_email', user.email).limit(1);
    const tenant = rows && rows[0];
    if (!tenant) return res.status(404).json({ error: 'no tenant found for this account' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { provider } = body;
    if (!provider) return res.status(400).json({ error: 'provider required' });

    const { error } = await c.from('integrations')
      .delete()
      .eq('tenant_id', tenant.id)
      .eq('provider', provider);

    if (error) throw new Error(error.message);

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: String(e && e.message || e) });
  }
}
