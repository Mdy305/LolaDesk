// POST /api/widget/client-lookup { tenant, phone }
// Returns the client's name if we already know them (for smart widget prefill).
// Never returns email or other PII — just first/last name if present.
import { corsPublic, jsonBody } from '../lib/cors.js';
import { db } from '../lib/db.js';
import { resolveTenantFromRequest } from '../lib/widget-tenant.js';

export default async function handler(req, res) {
  if (corsPublic(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  try {
    const tenant = await resolveTenantFromRequest(req);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no_tenant' });

    const { phone } = jsonBody(req);
    if (!phone) return res.status(400).json({ ok: false, error: 'missing_phone' });

    const c = db();
    const { data } = await c.from('clients')
      .select('id, first_name, last_name, name')
      .eq('tenant_id', tenant.id)
      .eq('phone', phone)
      .maybeSingle();

    if (!data) return res.json({ ok: true, found: false });

    return res.json({
      ok: true,
      found: true,
      first_name: data.first_name || null,
      last_name: data.last_name || null,
      display_name: (data.first_name || data.last_name)
        ? [data.first_name, data.last_name].filter(Boolean).join(' ')
        : data.name
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
