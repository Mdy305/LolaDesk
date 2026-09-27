// GET/PATCH /api/tenant — read/write current tenant meta (hours, lead times, etc.)
export default async function handler(req, res) {
  let cors, jsonBody, bearer, getUserFromToken, resolveTenantForUser, dbFn;
  try {
    ({ cors, jsonBody } = await import('./lib/cors.js'));
    ({ bearer, getUserFromToken } = await import('./lib/auth.js'));
    ({ resolveTenantForUser } = await import('./lib/tenant-access.js'));
    ({ db: dbFn } = await import('./lib/db.js'));
  } catch (e) { return res.status(500).json({ ok:false, error:'import_failed', message:String(e?.message||e) }); }
  try {
    if (cors && cors(req, res)) return;
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok:false, error:'not_authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok:false, error:'no_tenant' });
    const c = dbFn();

    if (req.method === 'GET') {
      const { data, error } = await c.from('tenants').select('*').eq('id', tenant.id).maybeSingle();
      if (error) throw error;
      return res.json({ ok:true, data });
    }
    if (req.method === 'PATCH') {
      const b = (jsonBody ? jsonBody(req) : null) || {};
      const patch = {};
      const allowed = ['name','phone','address','timezone','working_hours','lead_max_days','lead_min_hours','slot_minutes','auto_confirm','owner_phone','brand_color'];
      for (const k of allowed) if (b[k] !== undefined) patch[k] = b[k];
      if (!Object.keys(patch).length) return res.status(400).json({ ok:false, error:'no_updates' });
      const { data, error } = await c.from('tenants').update(patch).eq('id', tenant.id).select().single();
      if (error) throw error;
      return res.json({ ok:true, data });
    }
    return res.status(405).json({ ok:false, error:'method_not_allowed' });
  } catch (e) { console.error('[tenant]', e?.message); return res.status(500).json({ ok:false, error:String(e?.message||e) }); }
}
