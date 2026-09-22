// GET /api/inbox/threads?filter=all|unread|autopilot|manual
// Powers inbox.html thread list.
import { cors } from '../lib/cors.js';
import { bearer, getUserFromToken } from '../lib/auth.js';
import { resolveTenantForUser } from '../lib/tenant-access.js';
import { db } from '../lib/db.js';

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  try {
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'not_authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no_tenant' });

    const filter = String(req.query?.filter || 'all');
    const limit = Math.min(500, Number(req.query?.limit) || 100);

    const c = db();
    let query = c.from('inbox_threads')
      .select('id, client_id, client_phone, channel, unread, autopilot, preview, when')
      .eq('tenant_id', tenant.id)
      .order('when', { ascending: false, nullsFirst: false })
      .limit(limit);

    if (filter === 'unread') query = query.eq('unread', true);
    else if (filter === 'autopilot') query = query.eq('autopilot', true);
    else if (filter === 'manual') query = query.eq('autopilot', false);

    const { data, error } = await query;
    if (error) throw error;

    // Enrich with client name (single follow-up query, not per-row).
    const ids = [...new Set((data || []).map(t => t.client_id).filter(Boolean))];
    let clientMap = {};
    if (ids.length) {
      const { data: clients } = await c.from('clients')
        .select('id, first_name, last_name, name')
        .in('id', ids);
      clientMap = Object.fromEntries((clients || []).map(cl => [
        cl.id,
        (cl.first_name || cl.last_name)
          ? [cl.first_name, cl.last_name].filter(Boolean).join(' ')
          : cl.name
      ]));
    }

    const rows = (data || []).map(t => ({
      id: t.id,
      client_name: clientMap[t.client_id] || null,
      client_phone: t.client_phone,
      channel: t.channel,
      unread: t.unread,
      autopilot: t.autopilot,
      preview: t.preview,
      when: t.when
    }));

    return res.json({ ok: true, threads: rows });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
