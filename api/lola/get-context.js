// POST /api/lola/get-context  { to_number, from_number }
// LolaBrain's FIRST tool call at the top of every call.
// Given the "to" number (the tenant's Lola line), returns the tenant's
// business identity + everything LolaBrain needs to speak as them.
// Given the "from" number, returns the caller's client record if known.
//
// This endpoint has NO auth — it's called by Telnyx AI Assistant, not a
// browser. Security is by shared secret in x-lola-tool-secret header.
import { db } from '../lib/db.js';

function verifyToolAuth(req) {
  const secret = process.env.LOLA_TOOL_SECRET;
  if (!secret) return true; // dev: allow while unset
  return req.headers?.['x-lola-tool-secret'] === secret;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!verifyToolAuth(req)) return res.status(401).json({ error: 'unauthorized' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const to = body.to_number || body.to;
    const from = body.from_number || body.from;
    if (!to) return res.status(400).json({ error: 'missing_to_number' });

    const c = db();

    // 1. Find the tenant by the "to" (their Lola number).
    const { data: tn } = await c.from('tenant_numbers')
      .select('tenant_id, phone_e164')
      .eq('phone_e164', to)
      .maybeSingle();

    if (!tn?.tenant_id) {
      return res.json({
        found: false,
        greeting: 'Hi, thank you for calling. How can I help you today?',
        note: 'Number not associated with a tenant.'
      });
    }

    const [tenantRes, settingsRes, servicesRes, staffRes] = await Promise.all([
      c.from('tenants').select('id, name, timezone, business_profile').eq('id', tn.tenant_id).maybeSingle(),
      c.from('booking_settings').select('business_hours, closures').eq('tenant_id', tn.tenant_id).maybeSingle(),
      c.from('services').select('id, name, price, duration_min, category').eq('tenant_id', tn.tenant_id).eq('active', true).order('sort_order', { ascending: true, nullsFirst: false }),
      c.from('staff').select('id, first_name, last_name, name, role').eq('tenant_id', tn.tenant_id).eq('active', true)
    ]);

    const tenant = tenantRes.data;
    if (!tenant) return res.json({ found: false });

    // 2. Look up the caller if we know them.
    let caller = null;
    if (from) {
      const { data } = await c.from('clients')
        .select('id, first_name, last_name, name, visit_count, no_show_count')
        .eq('tenant_id', tenant.id)
        .eq('phone', from)
        .maybeSingle();
      if (data) {
        caller = {
          id: data.id,
          display_name: (data.first_name || data.last_name)
            ? [data.first_name, data.last_name].filter(Boolean).join(' ')
            : data.name,
          visit_count: data.visit_count || 0,
          no_show_count: data.no_show_count || 0,
          returning: (data.visit_count || 0) > 0
        };
      }
    }

    const business = {
      name: tenant.name,
      timezone: tenant.timezone || 'America/New_York',
      hours: settingsRes.data?.business_hours || null,
      closures: settingsRes.data?.closures || [],
      services: (servicesRes.data || []).map(s => ({
        id: s.id, name: s.name,
        price_dollars: Number(s.price || 0),
        duration_min: s.duration_min,
        category: s.category
      })),
      staff: (staffRes.data || []).map(s => ({
        id: s.id,
        name: (s.first_name || s.last_name) ? [s.first_name, s.last_name].filter(Boolean).join(' ') : s.name,
        role: s.role
      }))
    };

    const greeting = caller?.display_name
      ? `Hi ${caller.display_name.split(' ')[0]} — thanks for calling ${tenant.name}. What can I do for you today?`
      : `Hi, thank you for calling ${tenant.name}. This is Lola — how can I help?`;

    return res.json({
      found: true,
      tenant_id: tenant.id,
      business,
      caller,
      greeting
    });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
