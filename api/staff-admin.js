// GET   /api/staff-admin              → list all staff
// POST  /api/staff-admin               → create
// PATCH /api/staff-admin?id=uuid      → update
// DELETE /api/staff-admin?id=uuid     → soft-delete (is_active=false — what the engine reads)
// `active` is accepted as an alias of is_active; `services:[id]` also writes
// staff_services (the table the availability engine reads).
//
// NOTE: named staff-admin to avoid colliding with /api/revenue/staff.js.
// Wire your settings page here.
import { cors, jsonBody } from './lib/cors.js';
import { bearer, getUserFromToken } from './lib/auth.js';
import { resolveTenantForUser } from './lib/tenant-access.js';
import { db } from './lib/db.js';
import { tolerantWrite, replaceStaffServices } from './lib/setup-store.js';

const FIELDS = [
  'first_name', 'last_name', 'name', 'role', 'phone', 'email',
  'color', 'services', 'photo_url', 'is_active'
];

function staffRow(body){
  const b = { ...body };
  if(!('is_active' in b) && 'active' in b) b.is_active = b.active;
  const row = {};
  FIELDS.forEach(k => { if (k in b) row[k] = b[k]; });
  if('is_active' in row){ row.is_active = row.is_active !== false && row.is_active !== 'false'; row.active = row.is_active; }
  return row;
}

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
      const row = { tenant_id: tenant.id, ...staffRow(body) };
      if (!row.name && (row.first_name || row.last_name)) {
        row.name = [row.first_name, row.last_name].filter(Boolean).join(' ');
      }
      if (!row.name) return res.status(400).json({ ok: false, error: 'missing_name' });
      const { data, error } = await tolerantWrite(p => c.from('staff').insert(p).select().single(), row, { required: ['name', 'tenant_id'] });
      if (error) throw error;
      if (Array.isArray(body.services)) await replaceStaffServices(c, tenant.id, data.id, body.services);
      return res.json({ ok: true, staff: data });
    }

    if (req.method === 'PATCH') {
      if (!id) return res.status(400).json({ ok: false, error: 'missing_id' });
      const body = jsonBody(req);
      const patch = staffRow(body);
      const { data, error } = await tolerantWrite(p => c.from('staff')
        .update(p)
        .eq('id', id)
        .eq('tenant_id', tenant.id)
        .select().single(), patch, { required: ['name'] });
      if (error) throw error;
      if (data && Array.isArray(body.services)) await replaceStaffServices(c, tenant.id, data.id, body.services);
      return res.json({ ok: true, staff: data });
    }

    if (req.method === 'DELETE') {
      if (!id) return res.status(400).json({ ok: false, error: 'missing_id' });
      const { error } = await tolerantWrite(p => c.from('staff')
        .update(p)
        .eq('id', id)
        .eq('tenant_id', tenant.id), { is_active: false, active: false }, { required: ['is_active'] });
      if (error) throw error;
      return res.json({ ok: true });
    }

    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
