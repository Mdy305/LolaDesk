// GET /api/call-center/call?id=<uuid>  — one call with its full conversation.
import { ownerTenant, normalizeCall, clientIndex } from './_shared.js';

export default async function handler(req, res) {
  try {
    const ctx = await ownerTenant(req, res); if (!ctx) return;
    if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    const { tenant, c } = ctx;
    const id = String(req.query?.id || '').trim();
    if (!id) return res.status(400).json({ ok: false, error: 'id_required' });
    const { data: row, error } = await c.from('calls').select('*').eq('tenant_id', tenant.id).eq('id', id).maybeSingle();
    if (error) throw error;
    if (!row) return res.status(404).json({ ok: false, error: 'call_not_found' });
    const idx = await clientIndex(c, tenant.id, [row]);
    return res.json({ ok: true, call: normalizeCall(row, idx.byId, idx.byPhone) });
  } catch (e) {
    console.error('[call-center/call]', e?.message);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
