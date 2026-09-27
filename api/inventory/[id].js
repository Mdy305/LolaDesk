// PATCH/DELETE /api/inventory/[id]
export default async function handler(req, res) {
  let cors, jsonBody, bearer, getUserFromToken, resolveTenantForUser, dbFn;
  try {
    ({ cors, jsonBody } = await import('../lib/cors.js'));
    ({ bearer, getUserFromToken } = await import('../lib/auth.js'));
    ({ resolveTenantForUser } = await import('../lib/tenant-access.js'));
    ({ db: dbFn } = await import('../lib/db.js'));
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
      if (b.brand !== undefined) patch.brand = b.brand;
      if (b.sku !== undefined) patch.sku = b.sku;
      if (b.price_cents != null) patch.price_cents = parseInt(b.price_cents, 10) || 0;
      if (b.cost_cents != null) patch.cost_cents = parseInt(b.cost_cents, 10) || 0;
      if (b.stock != null) patch.stock = parseInt(b.stock, 10) || 0;
      if (b.min_stock != null) patch.min_stock = parseInt(b.min_stock, 10) || 0;
      const { data, error } = await c.from('inventory_items').update(patch).eq('id', id).eq('tenant_id', tenant.id).select().single();
      if (error) throw error;
      return res.json({ ok:true, data });
    }
    if (req.method === 'DELETE') {
      const { error } = await c.from('inventory_items').delete().eq('id', id).eq('tenant_id', tenant.id);
      if (error) throw error;
      return res.json({ ok:true });
    }
    return res.status(405).json({ ok:false, error:'method_not_allowed' });
  } catch (e) { console.error('[inventory/id]', e?.message); return res.status(500).json({ ok:false, error:String(e?.message||e) }); }
}
