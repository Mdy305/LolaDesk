// PATCH/DELETE /api/team/[id]
export default async function handler(req, res) {
  let cors, jsonBody, bearer, getUserFromToken, resolveTenantForUser, dbFn;
  try {
    ({ cors, jsonBody } = await import('../../lib/cors.js'));
    ({ bearer, getUserFromToken } = await import('../../lib/auth.js'));
    ({ resolveTenantForUser } = await import('../../lib/tenant-access.js'));
    ({ db: dbFn } = await import('../../lib/db.js'));
  } catch (e) { return res.status(500).json({ ok:false, error:'import_failed', message:String(e?.message||e) }); }
  try {
    if (cors && cors(req, res)) return;
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok:false, error:'not_authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok:false, error:'no_tenant' });
    const id = String(req.query.id || '').trim();
    if (!id) return res.status(400).json({ ok:false, error:'id_required' });
    const c = dbFn();
    if (req.method === 'PATCH') {
      const b = (jsonBody ? jsonBody(req) : null) || {};
      const patch = {};
      if (b.name != null) patch.name = String(b.name).trim();
      if (b.role != null) patch.role = String(b.role).trim();
      if (b.phone !== undefined) patch.phone = b.phone;
      if (b.email !== undefined) patch.email = b.email;
      if (b.commission_pct != null) patch.commission_pct = parseInt(b.commission_pct, 10) || 0;
      if (b.color != null) patch.color = b.color;
      if (Array.isArray(b.working_days)) patch.working_days = b.working_days;
      if (b.active !== undefined) patch.active = !!b.active;
      const { data, error } = await c.from('staff_members').update(patch).eq('id', id).eq('tenant_id', tenant.id).select().single();
      if (error) throw error;
      return res.json({ ok:true, data });
    }
    if (req.method === 'DELETE') {
      const { error } = await c.from('staff_members').update({ active: false }).eq('id', id).eq('tenant_id', tenant.id);
      if (error) throw error;
      return res.json({ ok:true });
    }
    return res.status(405).json({ ok:false, error:'method_not_allowed' });
  } catch (e) { console.error('[team/id]', e?.message); return res.status(500).json({ ok:false, error:String(e?.message||e) }); }
}
