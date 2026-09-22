// GET /api/inbox/messages?thread_id=...
// Loads all messages in a thread + marks thread as read.
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

    const thread_id = String(req.query?.thread_id || '');
    if (!thread_id) return res.status(400).json({ ok: false, error: 'missing_thread_id' });

    const c = db();

    // Verify tenant owns the thread.
    const { data: thread } = await c.from('inbox_threads')
      .select('id, autopilot, client_phone')
      .eq('id', thread_id)
      .eq('tenant_id', tenant.id)
      .maybeSingle();
    if (!thread) return res.status(404).json({ ok: false, error: 'thread_not_found' });

    const { data: messages, error } = await c.from('inbox_messages')
      .select('id, direction, text, created_at, delivery_status')
      .eq('thread_id', thread_id)
      .eq('tenant_id', tenant.id)
      .order('created_at', { ascending: true })
      .limit(500);
    if (error) throw error;

    // Mark as read on load.
    await c.from('inbox_threads').update({ unread: false }).eq('id', thread_id);

    return res.json({
      ok: true,
      thread: { id: thread.id, autopilot: thread.autopilot, client_phone: thread.client_phone },
      messages: messages || []
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
