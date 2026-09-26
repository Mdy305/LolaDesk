// GET/POST /api/tenant/billing-policies
const DEFAULTS = {
  deposits:    { enabled: false, mode: 'percent', percent: 25, fixed_cents: 2500, services: 'all' },
  no_show:     { enabled: true, fee_cents: 5000, charge_after_minutes: 15 },
  late_cancel: { enabled: true, hours_before: 24, fee_cents: 2500 },
  tips:        { enabled: true, suggested_percents: [15, 18, 20, 25] },
  auto_charge: { enabled: false, require_card_on_file: true }
};
function merge(d, i) {
  if (!i || typeof i !== 'object') return d;
  const out = {}; for (const k of Object.keys(d)) out[k] = { ...d[k], ...(i[k] || {}) }; return out;
}
export default async function handler(req, res) {
  let cors, jsonBody, bearer, getUserFromToken, resolveTenantForUser, dbFn;
  try {
    ({ cors, jsonBody } = await import('../../lib/cors.js'));
    ({ bearer, getUserFromToken } = await import('../../lib/auth.js'));
    ({ resolveTenantForUser } = await import('../../lib/tenant-access.js'));
    ({ db: dbFn } = await import('../../lib/db.js'));
  } catch (e) { return res.status(500).json({ ok: false, error: 'import_failed', message: String(e?.message || e) }); }

  try {
    if (cors && cors(req, res)) return;
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'not_authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no_tenant' });

    const c = dbFn();
    if (req.method === 'GET') {
      let data = null;
      try { ({ data } = await c.from('billing_policies').select('*').eq('tenant_id', tenant.id).maybeSingle()); }
      catch (_) { data = null; }
      const policies = data?.policies ? merge(DEFAULTS, data.policies) : DEFAULTS;
      return res.json({ ok: true, data: policies });
    }
    if (req.method === 'POST') {
      const body = (jsonBody ? jsonBody(req) : null) || {};
      const policies = merge(DEFAULTS, body);
      const row = { tenant_id: tenant.id, policies, updated_at: new Date().toISOString(), updated_by: user.id || null };
      const { data, error } = await c.from('billing_policies').upsert(row, { onConflict: 'tenant_id' }).select().single();
      if (error) throw error;
      return res.json({ ok: true, data: data.policies });
    }
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  } catch (e) { return res.status(500).json({ ok: false, error: String(e?.message || e) }); }
}
