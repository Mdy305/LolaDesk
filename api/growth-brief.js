/**
 * GET  /api/growth-brief[?refresh=1]   (Authorization: Bearer <owner token>)
 *   → { ok, brief }   Lola's growth plan: where the salon stands on Google
 *     Maps vs the salons around it, the calendar's open chairs, the client
 *     book — and the moves ranked by money. Cached 24h.
 * POST /api/growth-brief { action: 'enable_reviews' | 'refresh' }
 */
import { bearer, getUserFromToken } from './lib/auth.js';
import { resolveTenantForUser } from './lib/tenant-access.js';
import { db } from './lib/db.js';
import { growthBrief, enableReviews } from './lib/growth-brief.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ ok: false, error: 'GET or POST' });
  try {
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'not authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no salon for this account' });
    const c = db();
    if (!c) return res.status(503).json({ ok: false, error: 'database not configured' });
    let body = req.body || {};
    if (typeof body === 'string') { try { body = JSON.parse(body || '{}'); } catch { body = {}; } }
    if (req.method === 'POST' && body.action === 'enable_reviews') {
      const out = await enableReviews(c, tenant);
      if (out.ok) {
        const { data: fresh } = await c.from('tenants').select('*').eq('id', tenant.id).maybeSingle();
        out.brief = await growthBrief(c, fresh || tenant, { refresh: true, llm: null }).catch(() => null);
      }
      return res.status(out.ok ? 200 : 422).json(out);
    }
    const refresh = req.method === 'POST' ? body.action === 'refresh' : /^(1|true)$/.test(String(req.query?.refresh || ''));
    const brief = await growthBrief(c, tenant, { refresh });
    return res.status(200).json({ ok: true, brief });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
