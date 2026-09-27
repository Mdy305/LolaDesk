// POST /api/reviews/[id]/reply — record a reply
export default async function handler(req, res) {
  let cors, jsonBody, bearer, getUserFromToken, resolveTenantForUser, dbFn;
  try {
    ({ cors, jsonBody } = await import('../../lib/cors.js'));
    ({ bearer, getUserFromToken } = await import('../../lib/auth.js'));
    ({ resolveTenantForUser } = await import('../../lib/tenant-access.js'));
    ({ db: dbFn } = await import('../../lib/db.js'));
  } catch (e) { return res.status(500).json({ ok:false, error:'import_failed', message:String(e?.message||e) }); }
  if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'method_not_allowed' });
  try {
    if (cors && cors(req, res)) return;
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok:false, error:'not_authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok:false, error:'no_tenant' });
    const id = String(req.query.id || '').trim();
    if (!id) return res.status(400).json({ ok:false, error:'id_required' });
    const b = (jsonBody ? jsonBody(req) : null) || {};
    if (!b.text) return res.status(400).json({ ok:false, error:'text_required' });
    const c = dbFn();
    const { data, error } = await c.from('reviews').update({
      reply: String(b.text).trim(),
      replied_at: new Date().toISOString(),
      replied_by: user.id || null,
    }).eq('id', id).eq('tenant_id', tenant.id).select().single();
    if (error) throw error;
    return res.json({ ok:true, data });
  } catch (e) { console.error('[reviews/reply]', e?.message); return res.status(500).json({ ok:false, error:String(e?.message||e) }); }
}
