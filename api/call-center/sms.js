// POST /api/call-center/sms  { to, text }  — text a caller from the salon's line.
import { ownerTenant, body } from './_shared.js';
import { sendSms } from '../lib/sms.js';

export default async function handler(req, res) {
  try {
    const ctx = await ownerTenant(req, res); if (!ctx) return;
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    const { tenant } = ctx;
    const b = body(req);
    const to = String(b.to || b.phone || '').trim();
    const text = String(b.text || b.body || b.message || '').trim().slice(0, 1600);
    if (!to || !text) return res.status(400).json({ ok: false, error: 'to_and_text_required' });
    const r = await sendSms({ tenant, tenantId: tenant.id, to, text });
    if (r?.skipped) return res.status(400).json({ ok: false, error: r.reason === 'opted_out' ? 'This client opted out of texts.' : r.reason });
    if (r?.errors?.length) return res.status(502).json({ ok: false, error: r.errors[0]?.detail || 'Telnyx rejected the message' });
    return res.json({ ok: true, id: r?.data?.id || null });
  } catch (e) {
    console.error('[call-center/sms]', e?.message);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
