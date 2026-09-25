// GET  /api/tenant/billing-policies → the tenant's saved billing policies
// POST /api/tenant/billing-policies → replace them
// Body: full policy object; shape:
//   { deposits: {...}, no_show: {...}, late_cancel: {...}, tips: {...}, auto_charge: {...} }
import { cors, jsonBody } from '../../lib/cors.js';
import { bearer, getUserFromToken } from '../../lib/auth.js';
import { resolveTenantForUser } from '../../lib/tenant-access.js';
import { db } from '../../lib/db.js';

// Sensible defaults if a tenant has never saved policies before.
const DEFAULTS = {
  deposits: {
    enabled: false,
    mode: 'percent',            // 'percent' | 'fixed'
    percent: 25,                // 0..100
    fixed_cents: 2500,
    services: 'all'             // 'all' | list of service_ids
  },
  no_show: {
    enabled: true,
    fee_cents: 5000,
    charge_after_minutes: 15
  },
  late_cancel: {
    enabled: true,
    hours_before: 24,
    fee_cents: 2500
  },
  tips: {
    enabled: true,
    suggested_percents: [15, 18, 20, 25]
  },
  auto_charge: {
    enabled: false,
    require_card_on_file: true
  }
};

function merge(defaults, incoming) {
  if (!incoming || typeof incoming !== 'object') return defaults;
  const out = {};
  for (const k of Object.keys(defaults)) {
    out[k] = { ...defaults[k], ...(incoming[k] || {}) };
  }
  return out;
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  try {
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'not_authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no_tenant' });

    const c = db();

    if (req.method === 'GET') {
      const { data } = await c.from('billing_policies').select('*').eq('tenant_id', tenant.id).maybeSingle();
      const policies = data?.policies ? merge(DEFAULTS, data.policies) : DEFAULTS;
      return res.json({ ok: true, data: policies });
    }

    if (req.method === 'POST') {
      const body = jsonBody(req) || {};
      const policies = merge(DEFAULTS, body);
      const row = {
        tenant_id: tenant.id,
        policies,
        updated_at: new Date().toISOString(),
        updated_by: user.id || null
      };
      // Upsert on tenant_id.
      const { data, error } = await c.from('billing_policies')
        .upsert(row, { onConflict: 'tenant_id' })
        .select().single();
      if (error) throw error;
      return res.json({ ok: true, data: data.policies });
    }

    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  } catch (e) {
    console.error('[billing-policies]', e?.message);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
