// GET  /api/provision-number?areaCode=305        → list buyable numbers
// GET  /api/provision-number                     → auto-pick first available
// GET  /api/provision-number?owned=1             → list numbers already on the account
// POST /api/provision-number { phone_number }    → buy + attach to LolaBrain
//
// ARCHITECTURE: one LolaBrain Assistant serves every tenant.
// This handler buys the number and attaches it to the shared LolaBrain
// (id in TELNYX_LOLA_ASSISTANT_ID). LolaBrain figures out which tenant
// is calling via the /api/lola/get-context tool, keyed by phone number.
import { cors, jsonBody } from './lib/cors.js';
import { bearer, getUserFromToken } from './lib/auth.js';
import { resolveTenantForUser } from './lib/tenant-access.js';
import { db } from './lib/db.js';
import {
  searchNumbers, orderNumber, findPhoneNumberRecord, linkNumberToAssistant
} from './lib/telnyx-assistant.js';

export default async function handler(req, res) {
  if (cors(req, res)) return;
  try {
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'not_authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no_tenant' });

    const lolaBrainId = process.env.TELNYX_LOLA_ASSISTANT_ID;
    if (!lolaBrainId && req.method === 'POST') {
      return res.status(500).json({ ok: false, error: 'lolabrain_not_configured' });
    }

    const c = db();

    if (req.method === 'GET') {
      if (req.query?.owned) {
        const list = await searchNumbers({});
        return res.json({ ok: true, owned: list });
      }
      const areaCode = req.query?.areaCode;
      if (areaCode) {
        const list = await searchNumbers({ area_code: String(areaCode), limit: 8 });
        return res.json({ ok: true, numbers: list });
      }
      const list = await searchNumbers({ area_code: '305', limit: 3 });
      const suggested = list[0] || (await searchNumbers({ limit: 3 }))[0] || null;
      return res.json({ ok: true, suggested });
    }

    if (req.method === 'POST') {
      const { phone_number, use_existing } = jsonBody(req);
      if (!phone_number) return res.status(400).json({ ok: false, error: 'missing_phone_number' });

      // 1. Buy the number (skip if attaching one already owned).
      if (!use_existing) await orderNumber({ phone_number });

      // 2. Fetch the number record (Telnyx propagation can lag ~seconds).
      let record = null;
      for (let i = 0; i < 5; i++) {
        try { record = await findPhoneNumberRecord({ phone_number }); if (record?.id) break; } catch {}
        await new Promise(r => setTimeout(r, 1500));
      }
      if (!record?.id) throw new Error('number_not_ready');

      // 3. Attach the number to the shared LolaBrain Assistant.
      await linkNumberToAssistant({ phone_number_id: record.id, assistant_id: lolaBrainId });

      // 4. Persist on the tenant. NOTE: no per-tenant assistant_id — every
      //    tenant points at the shared LolaBrain. Tenant isolation lives in
      //    the /api/lola/* tool endpoints, which key everything on phone_number.
      await c.from('tenants').update({
        phone_e164: phone_number,
        telnyx_number_id: record.id,
        telnyx_assistant_id: lolaBrainId,
        setup_step: 'live'
      }).eq('id', tenant.id);

      await c.from('tenant_numbers').upsert({
        tenant_id: tenant.id,
        phone_e164: phone_number,
        telnyx_number_id: record.id,
        active: true
      }, { onConflict: 'phone_e164' });

      return res.json({
        ok: true,
        phone_number,
        assistant_id: lolaBrainId,
        message: 'Number attached to LolaBrain. Call it now.',
        provisioned_at: new Date().toISOString()
      });
    }

    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
