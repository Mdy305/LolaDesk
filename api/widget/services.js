// GET /api/widget/services?tenant=<slug or id>
// PUBLIC endpoint — no auth. Powers the booking widget's service list.
import { corsPublic } from '../lib/cors.js';
import { db } from '../lib/db.js';
import { resolveTenantFromRequest } from '../lib/widget-tenant.js';

export default async function handler(req, res) {
  if (corsPublic(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  try {
    const tenant = await resolveTenantFromRequest(req);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no_tenant' });

    const c = db();
    const { data, error } = await c.from('services')
      .select('id, name, category, description, duration_min, price, currency, photo_url, sort_order')
      .eq('tenant_id', tenant.id)
      .eq('active', true)
      .order('sort_order', { ascending: true, nullsFirst: false })
      .order('name', { ascending: true });
    if (error) throw error;

    return res.json({
      ok: true,
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug || null },
      services: data || []
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
