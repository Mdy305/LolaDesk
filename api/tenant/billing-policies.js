// GET/POST /api/tenant/billing-policies — read + write the tenant's
// revenue-lever policies. Consumed by banking-policies.html.
import { cors, jsonBody } from '../lib/cors.js';
import { bearer, getUserFromToken } from '../lib/auth.js';
import { resolveTenantForUser } from '../lib/tenant-access.js';
import { db } from '../lib/db.js';
import { loadPolicies } from '../lib/policies.js';

// Fields the client may write. Anything else in the body is ignored so a
// stray field never lands in a JSONB blob.
const WRITABLE = new Set(['deposits','no_show','late_cancel','tips','auto_charge','currency']);

export default async function handler(req, res) {
  if (cors(req, res)) return;
  try {
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'not_authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no_tenant' });

    if (req.method === 'GET') {
      const p = await loadPolicies(tenant.id);
      return res.json({ ok: true, ...p });
    }

    if (req.method === 'POST' || req.method === 'PATCH') {
      const body = jsonBody(req);
      const patch = { tenant_id: tenant.id, updated_at: new Date().toISOString() };
      for (const [k, v] of Object.entries(body)) if (WRITABLE.has(k)) patch[k] = v;
      const c = db();
      const { data, error } = await c.from('billing_policies').upsert(patch, { onConflict: 'tenant_id' }).select().single();
      if (error) throw error;
      return res.json({ ok: true, ...data });
    }

    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
