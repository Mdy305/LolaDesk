// GET /api/call-center/calls?limit=100  — call list for the Call Center,
// read straight from the canonical `calls` table (select * so it works with
// whichever columns this database has), enriched with client names.
import { ownerTenant, normalizeCall, clientIndex } from './_shared.js';

export default async function handler(req, res) {
  try {
    const ctx = await ownerTenant(req, res); if (!ctx) return;
    if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    const { tenant, c } = ctx;
    const limit = Math.min(300, parseInt(req.query?.limit || '100', 10) || 100);
    const { data, error } = await c.from('calls').select('*')
      .eq('tenant_id', tenant.id).order('created_at', { ascending: false }).limit(limit);
    if (error) throw error;
    const rows = data || [];
    const idx = await clientIndex(c, tenant.id, rows);
    return res.json({ ok: true, calls: rows.map(r => normalizeCall(r, idx.byId, idx.byPhone)) });
  } catch (e) {
    console.error('[call-center/calls]', e?.message);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
