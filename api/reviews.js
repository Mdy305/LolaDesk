// GET /api/reviews  — list stored + provider reviews
// POST /api/reviews  — add a manual review
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
      const { data, error } = await c.from('reviews').select('*').eq('tenant_id', tenant.id).order('created_at', { ascending: false }).limit(200);
      if (error) throw error;
      return res.json({ ok:true, data: { reviews: data || [] } });
    }
    if (req.method === 'POST') {
      const b = (jsonBody ? jsonBody(req) : null) || {};
      const insert = {
        tenant_id: tenant.id,
        author: b.author || null, body: b.body || null,
        rating: parseInt(b.rating, 10) || null,
        source: b.source || 'manual',
        external_id: b.external_id || null,
      };
      const { data, error } = await c.from('reviews').insert(insert).select().single();
      if (error) throw error;
      return res.json({ ok:true, data });
    }
    return res.status(405).json({ ok:false, error:'method_not_allowed' });
  } catch (e) { console.error('[reviews]', e?.message); return res.status(500).json({ ok:false, error:String(e?.message||e) }); }
}
