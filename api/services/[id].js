// PATCH/DELETE /api/services/[id]
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
      const num = (k, dst) => { if (b[k] != null) patch[dst || k] = parseInt(b[k], 10) || 0; };
      const str = (k, dst) => { if (b[k] !== undefined) patch[dst || k] = b[k] == null ? null : String(b[k]).trim(); };
      const bool= (k, dst) => { if (b[k] !== undefined) patch[dst || k] = !!b[k]; };
      str('name'); str('category'); str('description');
      num('duration_minutes'); num('price_cents'); num('deposit_cents'); num('buffer_minutes'); num('sort_order');
      bool('active'); bool('online_bookable'); bool('staff_only');
      const { data, error } = await c.from('services').update(patch).eq('id', id).eq('tenant_id', tenant.id).select().single();
      if (error) throw error;
      return res.json({ ok:true, data });
    }
    if (req.method === 'DELETE') {
      const { error } = await c.from('services').delete().eq('id', id).eq('tenant_id', tenant.id);
      if (error) throw error;
      return res.json({ ok:true });
    }
    return res.status(405).json({ ok:false, error:'method_not_allowed' });
  } catch (e) {
    console.error('[services/id]', e?.message);
    return res.status(500).json({ ok:false, error:String(e?.message||e) });
  }
}
