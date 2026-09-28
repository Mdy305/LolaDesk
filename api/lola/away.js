/**
 * GET /api/lola/away?since=<ISO>   (Authorization: Bearer <owner token>)
 * → { ok, brief }  — what happened while the owner was away (max 7 days back).
 * Lola shows this when the owner comes back to LolaDesk.
 */
import { bearer, getUserFromToken } from '../lib/auth.js';
import { resolveTenantForUser } from '../lib/tenant-access.js';
import { db } from '../lib/db.js';
import { awayBrief } from '../lib/owner-brief.js';

const MAX_BACK = 7 * 24 * 3600e3;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET only' });
  try {
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'not authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(401).json({ ok: false, error: 'no salon for this account' });
    const c = db();
    if (!c) return res.status(503).json({ ok: false, error: 'database not configured' });

    const now = Date.now();
    let since = Date.parse(String(req.query?.since || ''));
    if (!Number.isFinite(since) || since > now) since = now - 12 * 3600e3;
    since = Math.max(since, now - MAX_BACK);

    const brief = await awayBrief(c, tenant, new Date(since).toISOString());
    return res.status(200).json({ ok: true, brief });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
