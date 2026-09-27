// POST /api/call-center/handled  { id, handled?: true }
import { ownerTenant, body } from './_shared.js';

export default async function handler(req, res) {
  try {
    const ctx = await ownerTenant(req, res); if (!ctx) return;
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    const { tenant, c } = ctx;
    const b = body(req);
    if (!b.id) return res.status(400).json({ ok: false, error: 'id_required' });
    const value = b.handled === false ? null : new Date().toISOString();
    const { error } = await c.from('calls').update({ handled_at: value }).eq('tenant_id', tenant.id).eq('id', b.id);
    if (error) {
      const missing = /handled_at/.test(String(error.message || ''));
      return res.status(missing ? 409 : 500).json({ ok: false, error: missing ? 'Run sql/call-center.sql in Supabase first (adds calls.handled_at).' : error.message });
    }
    return res.json({ ok: true, handled: !!value });
  } catch (e) {
    console.error('[call-center/handled]', e?.message);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
