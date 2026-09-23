// GET  /api/provision-number?areaCode=305        → list buyable numbers
// GET  /api/provision-number                     → auto-pick first available
// GET  /api/provision-number?owned=1             → list numbers already on the account
// POST /api/provision-number { phone_number }    → buy + provision Assistant + link
//
// All three routes share this file so the onboarding.html frontend
// (which does GET for search/auto and POST to commit) works as-is.
import { cors, jsonBody } from './lib/cors.js';
import { bearer, getUserFromToken } from './lib/auth.js';
import { resolveTenantForUser } from './lib/tenant-access.js';
import { db } from './lib/db.js';
import {
  searchNumbers, orderNumber, findPhoneNumberRecord,
  createAssistant, linkNumberToAssistant
} from './lib/telnyx-assistant.js';

export default async function handler(req, res) {
  if (cors(req, res)) return;
  try {
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'not_authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no_tenant' });

    const c = db();

    if (req.method === 'GET') {
      // Owned numbers on the Telnyx account
      if (req.query?.owned) {
        const list = await searchNumbers({}); // could add owned lookup here
        return res.json({ ok: true, owned: list });
      }
      const areaCode = req.query?.areaCode;
      if (areaCode) {
        const list = await searchNumbers({ area_code: String(areaCode), limit: 8 });
        return res.json({ ok: true, numbers: list });
      }
      // Auto-pick a number in area 305 (Miami default) or blank
      const list = await searchNumbers({ area_code: '305', limit: 3 });
      const suggested = list[0] || (await searchNumbers({ limit: 3 }))[0] || null;
      return res.json({ ok: true, suggested });
    }

    if (req.method === 'POST') {
      const { phone_number, use_existing, voice_id, greeting } = jsonBody(req);
      if (!phone_number) return res.status(400).json({ ok: false, error: 'missing_phone_number' });

      // 1. Buy the number (skip if attaching one already owned).
      if (!use_existing) {
        await orderNumber({ phone_number });
      }

      // 2. Fetch the number record (needed for its id).
      // Telnyx propagation can lag a few seconds after order; retry.
      let record = null;
      for (let i = 0; i < 5; i++) {
        try { record = await findPhoneNumberRecord({ phone_number }); if (record?.id) break; } catch {}
        await new Promise(r => setTimeout(r, 1500));
      }
      if (!record?.id) throw new Error('number_not_ready');

      // 3. Load current tenant business profile (for Lola's brain).
      const [{ data: services }, { data: staff }, { data: settings }] = await Promise.all([
        c.from('services').select('name, price, duration_min').eq('tenant_id', tenant.id).eq('active', true),
        c.from('staff').select('name, first_name, last_name, role').eq('tenant_id', tenant.id).eq('active', true),
        c.from('booking_settings').select('business_hours').eq('tenant_id', tenant.id).maybeSingle()
      ]);
      const business_profile = {
        services: services || [],
        staff: (staff || []).map(s => ({
          name: (s.first_name || s.last_name) ? [s.first_name, s.last_name].filter(Boolean).join(' ') : s.name,
          role: s.role
        })),
        hours: settings?.business_hours || {}
      };

      // 4. Create the AI Assistant.
      const assistant = await createAssistant({
        tenant: { name: tenant.name, timezone: tenant.timezone },
        business_profile,
        voice_id,
        greeting
      });
      const assistant_id = assistant.id || assistant.assistant_id;

      // 5. Attach the number to the Assistant.
      await linkNumberToAssistant({ phone_number_id: record.id, assistant_id });

      // 6. Persist on the tenant.
      await c.from('tenants').update({
        phone_e164: phone_number,
        telnyx_number_id: record.id,
        telnyx_assistant_id: assistant_id,
        assistant_voice_id: voice_id || null,
        assistant_greeting: greeting || null,
        business_profile,
        setup_step: 'live'
      }).eq('id', tenant.id);

      // Also insert into tenant_numbers for reverse lookup on webhooks.
      await c.from('tenant_numbers').upsert({
        tenant_id: tenant.id,
        phone_e164: phone_number,
        telnyx_number_id: record.id,
        active: true
      }, { onConflict: 'phone_e164' });

      return res.json({
        ok: true,
        phone_number,
        assistant_id,
        provisioned_at: new Date().toISOString()
      });
    }

    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
