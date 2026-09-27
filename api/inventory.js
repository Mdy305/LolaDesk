// GET/POST /api/inventory
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
      const { data, error } = await c.from('inventory_items').select('*').eq('tenant_id', tenant.id).order('name');
      if (error) throw error;
      return res.json({ ok:true, data: { items: data || [] } });
    }
    if (req.method === 'POST') {
      const b = (jsonBody ? jsonBody(req) : null) || {};
      if (!b.name) return res.status(400).json({ ok:false, error:'name_required' });
      const insert = {
        tenant_id: tenant.id, name: String(b.name).trim(),
        brand: b.brand || null, sku: b.sku || null,
        price_cents: parseInt(b.price_cents, 10) || 0,
        cost_cents: parseInt(b.cost_cents, 10) || 0,
        stock: parseInt(b.stock, 10) || 0,
        min_stock: parseInt(b.min_stock, 10) || 0,
      };
      const { data, error } = await c.from('inventory_items').insert(insert).select().single();
      if (error) throw error;
      return res.json({ ok:true, data });
    }
    return res.status(405).json({ ok:false, error:'method_not_allowed' });
  } catch (e) { console.error('[inventory]', e?.message); return res.status(500).json({ ok:false, error:String(e?.message||e) }); }
}
