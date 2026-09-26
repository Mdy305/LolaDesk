// POST /api/pos/cash
// Body: same as /charge, plus given_cents.
export default async function handler(req, res) {
  let cors, jsonBody, bearer, getUserFromToken, resolveTenantForUser, dbFn;
  try {
    ({ cors, jsonBody } = await import('../lib/cors.js'));
    ({ bearer, getUserFromToken } = await import('../lib/auth.js'));
    ({ resolveTenantForUser } = await import('../lib/tenant-access.js'));
    ({ db: dbFn } = await import('../lib/db.js'));
  } catch (e) { return res.status(500).json({ ok: false, error: 'import_failed', message: String(e?.message || e) }); }

  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  try {
    if (cors && cors(req, res)) return;
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'not_authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no_tenant' });

    const body = (jsonBody ? jsonBody(req) : null) || {};
    const total = parseInt(body.total_cents, 10) || 0;
    if (total <= 0) return res.status(400).json({ ok: false, error: 'total_required' });
    const given = parseInt(body.given_cents, 10) || total;
    const change = Math.max(0, given - total);

    const { data, error } = await dbFn().from('pos_transactions').insert({
      tenant_id: tenant.id,
      payment_method: 'cash',
      subtotal_cents: parseInt(body.subtotal_cents, 10) || 0,
      tax_cents: parseInt(body.tax_cents, 10) || 0,
      tip_cents: parseInt(body.tip_cents, 10) || 0,
      total_cents: total,
      cash_given_cents: given,
      cash_change_cents: change,
      items: body.items || [],
      client_id: body.client?.id || null,
      client_name: body.client?.name || null,
      client_phone: body.client?.phone || null,
      client_email: body.client?.email || null,
      status: 'paid',
      cashier_user_id: user.id || null,
      paid_at: new Date().toISOString()
    }).select().single();
    if (error) throw error;

    return res.json({ ok: true, data });
  } catch (e) {
    console.error('[pos/cash]', e?.message);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
