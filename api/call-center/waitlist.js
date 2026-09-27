// POST /api/call-center/waitlist  { phone, client_name?, notes? }
// Adds a caller to the salon's real booking_waitlist (the one gap-fill and
// the freed-slot offer read from).
import { ownerTenant, body } from './_shared.js';
import { addToWaitlist } from '../lib/booking-repository.js';
import { e164 } from '../lib/db.js';

export default async function handler(req, res) {
  try {
    const ctx = await ownerTenant(req, res); if (!ctx) return;
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    const { tenant, c } = ctx;
    const b = body(req);
    const phone = e164(b.phone || b.to || '');
    if (!phone) return res.status(400).json({ ok: false, error: 'phone_required' });
    const { data: existing } = await c.from('clients').select('id, name').eq('tenant_id', tenant.id).eq('phone', phone).maybeSingle();
    const entry = await addToWaitlist({
      tenantId: tenant.id,
      clientId: existing?.id || null,
      clientName: b.client_name || existing?.name || null,
      clientPhone: phone,
      notes: b.notes || 'Added from Call Center',
      source: 'dashboard',
    });
    return res.json({ ok: true, entry });
  } catch (e) {
    console.error('[call-center/waitlist]', e?.message);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
