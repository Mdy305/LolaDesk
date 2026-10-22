/**
 * POST /api/oauth/disconnect  (Authorization: Bearer <access_token>)
 * { provider }
 * Disconnects the provider: revokes LolaDesk's access at the provider (Square) and deletes the
 * integration record for the tenant.
 */
import { getUserFromToken, bearer } from '../lib/auth.js';
import { db } from '../lib/db.js';
import { resolveTenantForUser } from '../lib/tenant-access.js';

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

    const tenant = await resolveTenantForUser(user);
    if (!tenant) return res.status(404).json({ error: 'no tenant found for this account' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { provider } = body;
    if (!provider) return res.status(400).json({ error: 'provider required' });

    // Square (and any provider that supports it): revoke LolaDesk's access at the provider first.
    if (provider === 'square') {
      try {
        const { getTenantIntegrations } = await import('../lib/db.js');
        const row = (await getTenantIntegrations(tenant.id, { status: null })).find((i) => i.provider === 'square');
        if (row) { const { revokeAccess } = await import('../lib/connectors/square.js'); await revokeAccess(row); }
      } catch (_) { /* the local disconnect still happens */ }
    }
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
