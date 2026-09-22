// GET   /api/staff-admin              → list all staff
// POST  /api/staff-admin               → create
// PATCH /api/staff-admin?id=uuid      → update
// DELETE /api/staff-admin?id=uuid     → soft-delete (active=false)
//
// NOTE: named staff-admin to avoid colliding with /api/revenue/staff.js.
// Wire your settings page here.
import { cors, jsonBody } from './lib/cors.js';
import { bearer, getUserFromToken } from './lib/auth.js';
import { resolveTenantForUser } from './lib/tenant-access.js';
import { db } from './lib/db.js';

const FIELDS = [
  'first_name', 'last_name', 'name', 'role', 'phone', 'email',
  'color', 'services', 'photo_url', 'active'
];

export default async function handler(req, res) {
  if (cors(req, res)) return;
  try {
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'not_authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no_tenant' });

    const c = db();
    const id = req.query?.id;

    if (req.method === 'GET') {
      const { data, error } = await c.from('staff')
        .select('*')
        .eq('tenant_id', tenant.id)
        .order('first_name', { ascending: true, nullsFirst: false })
        .order('name', { ascending: true });
      if (error) throw error;
      return res.json({ ok: true, staff: data || [] });
    }

    if (req.method === 'POST') {
      const body = jsonBody(req);
      const row = { tenant_id: tenant.id };
      FIELDS.forEach(k => { if (k in body) row[k] = body[k]; });
      if (!row.name && (row.first_name || row.last_name)) {
        row.name = [row.first_name, row.last_name].filter(Boolean).join(' ');
      }
      if (!row.name) return res.status(400).json({ ok: false, error: 'missing_name' });
      const { data, error } = await c.from('staff').insert(row).select().single();
      if (error) throw error;
      return res.json({ ok: true, staff: data });
    }

    if (req.method === 'PATCH') {
      if (!id) return res.status(400).json({ ok: false, error: 'missing_id' });
      const body = jsonBody(req);
      const patch = {};
      FIELDS.forEach(k => { if (k in body) patch[k] = body[k]; });
      const { data, error } = await c.from('staff')
        .update(patch)
        .eq('id', id)
        .eq('tenant_id', tenant.id)
        .select().single();
      if (error) throw error;
      return res.json({ ok: true, staff: data });
    }

    if (req.method === 'DELETE') {
      if (!id) return res.status(400).json({ ok: false, error: 'missing_id' });
      const { error } = await c.from('staff')
        .update({ active: false })
        .eq('id', id)
        .eq('tenant_id', tenant.id);
      if (error) throw error;
      return res.json({ ok: true });
    }

    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
