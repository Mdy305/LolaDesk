// POST /api/inbox-autopilot — flip Lola's autopilot on/off for a single thread.
// Called by inbox.html when the owner taps the Lola/Manual switch on a thread.
import { cors, jsonBody } from './lib/cors.js';
import { bearer, getUserFromToken } from './lib/auth.js';
import { resolveTenantForUser } from './lib/tenant-access.js';
import { db } from './lib/db.js';

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  try {
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'not_authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no_tenant' });

    const { conversation_id, autopilot } = jsonBody(req);
    if (!conversation_id) return res.status(400).json({ ok: false, error: 'missing_conversation_id' });

    const c = db();
    const { data, error } = await c.from('inbox_threads')
      .update({ autopilot: !!autopilot })
      .eq('id', conversation_id)
      .eq('tenant_id', tenant.id)
      .select().single();
    if (error) throw error;
    return res.json({ ok: true, thread: data });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
