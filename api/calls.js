// GET /api/calls?range=7d|30d|90d|all&filter=all|missed|no_show|handled|voicemail
// Lists calls for calls.html.
import { cors } from './lib/cors.js';
import { bearer, getUserFromToken } from './lib/auth.js';
import { resolveTenantForUser } from './lib/tenant-access.js';
import { db } from './lib/db.js';

const RANGES = { '7d': 7, '30d': 30, '90d': 90 };

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  try {
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'not_authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no_tenant' });

    const q = req.query || {};
    const range = String(q.range || '30d');
    const filter = String(q.filter || 'all');
    const limit = Math.min(500, Number(q.limit) || 200);

    let since;
    if (range === 'all') since = new Date(0);
    else since = new Date(Date.now() - (RANGES[range] || 30) * 86400000);

    const c = db();
    let query = c.from('calls')
      .select('id, call_control_id, from, to, direction, status, started_at, ended_at, duration_sec, outcome, summary, transcript')
      .eq('tenant_id', tenant.id)
      .gte('started_at', since.toISOString())
      .order('started_at', { ascending: false })
      .limit(limit);

    if (filter !== 'all') query = query.eq('outcome', filter);

    const { data, error } = await query;
    if (error) throw error;

    return res.json({ ok: true, calls: data || [] });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
