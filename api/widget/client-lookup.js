// POST /api/widget/client-lookup { tenant, phone }
// Returns a returning visitor's FIRST name (for a warm widget prefill).
// PUBLIC (anyone can type any phone number), so — like /api/public-booking client_lookup —
// first name only (never last name, email, id or history) and per-IP rate limited, so a
// script can't walk a salon's client list by phone number.
import { corsPublic, jsonBody } from '../lib/cors.js';
import { db } from '../lib/db.js';
import { resolveTenantFromRequest } from '../lib/widget-tenant.js';
import { limitPublic } from '../lib/public-rate-limit.js';

export default async function handler(req, res) {
  if (corsPublic(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  try {
    const tenant = await resolveTenantFromRequest(req);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no_tenant' });

    const { phone } = jsonBody(req);
    if (!phone) return res.status(400).json({ ok: false, error: 'missing_phone' });
    if (!limitPublic(req, 'client_lookup', tenant.id)) return res.status(429).json({ ok: false, error: 'rate_limited' });

    const c = db();
    const { data } = await c.from('clients')
      .select('first_name, name')
      .eq('tenant_id', tenant.id)
      .eq('phone', phone)
      .maybeSingle();

    const first = String((data && (data.first_name || String(data.name || '').split(' ')[0])) || '').trim().split(' ')[0];
    if (!data || !first || /^(client|website)$/i.test(first)) return res.json({ ok: true, found: false });

    return res.json({ ok: true, found: true, first_name: first, display_name: first });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
