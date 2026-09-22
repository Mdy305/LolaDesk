// GET /api/widget/staff?tenant=<slug>&service_id=<uuid>
// PUBLIC. Returns staff qualified for the chosen service (or all active if no service_id).
import { corsPublic } from '../lib/cors.js';
import { db } from '../lib/db.js';
import { resolveTenantFromRequest } from '../lib/widget-tenant.js';

export default async function handler(req, res) {
  if (corsPublic(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  try {
    const tenant = await resolveTenantFromRequest(req);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no_tenant' });

    const service_id = String(req.query?.service_id || '');
    const c = db();

    const { data, error } = await c.from('staff')
      .select('id, first_name, last_name, name, role, color, photo_url, services')
      .eq('tenant_id', tenant.id)
      .eq('active', true)
      .order('first_name', { ascending: true, nullsFirst: false });
    if (error) throw error;

    let list = data || [];
    if (service_id) {
      list = list.filter(s => !s.services || s.services.length === 0 || s.services.includes(service_id));
    }

    const rows = list.map(s => ({
      id: s.id,
      name: (s.first_name || s.last_name) ? [s.first_name, s.last_name].filter(Boolean).join(' ') : s.name,
      role: s.role,
      color: s.color,
      photo_url: s.photo_url
    }));

    return res.json({ ok: true, staff: rows });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
