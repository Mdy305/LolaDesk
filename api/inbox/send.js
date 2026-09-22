// POST /api/inbox/send  { thread_id, text }
// Owner sends an SMS from inbox.html. Flips autopilot off (owner is talking).
import { cors, jsonBody } from '../lib/cors.js';
import { bearer, getUserFromToken } from '../lib/auth.js';
import { resolveTenantForUser } from '../lib/tenant-access.js';
import { db } from '../lib/db.js';
import { sendSMS, tenantForNumber } from '../lib/telnyx.js';

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  try {
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'not_authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no_tenant' });

    const { thread_id, text } = jsonBody(req);
    if (!thread_id || !text) return res.status(400).json({ ok: false, error: 'missing_fields' });
    const body = String(text).slice(0, 1600);

    const c = db();

    const { data: thread } = await c.from('inbox_threads')
      .select('id, client_phone')
      .eq('id', thread_id)
      .eq('tenant_id', tenant.id)
      .maybeSingle();
    if (!thread?.client_phone) return res.status(404).json({ ok: false, error: 'thread_not_found' });

    // Get tenant's Telnyx number (from tenant_numbers or tenants.phone_e164).
    const { data: tnum } = await c.from('tenant_numbers')
      .select('phone_e164')
      .eq('tenant_id', tenant.id)
      .maybeSingle();
    const fromNumber = tnum?.phone_e164 || tenant.phone_e164;
    if (!fromNumber) return res.status(400).json({ ok: false, error: 'no_tenant_number' });

    // Send via Telnyx.
    const sent = await sendSMS({ from: fromNumber, to: thread.client_phone, text: body });

    // Persist the outbound message.
    await c.from('inbox_messages').insert({
      thread_id: thread.id,
      tenant_id: tenant.id,
      direction: 'out',
      text: body,
      author_user_id: user.id,
      telnyx_message_id: sent?.id || null,
      delivery_status: 'sent',
      created_at: new Date().toISOString()
    });

    // Owner replied → flip autopilot off, update preview.
    await c.from('inbox_threads').update({
      autopilot: false,
      unread: false,
      preview: body,
      when: new Date().toISOString()
    }).eq('id', thread.id);

    return res.json({ ok: true, message_id: sent?.id || null });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
