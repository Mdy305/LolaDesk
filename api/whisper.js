/**
 * POST /api/whisper — "Whisper to Lola" live steering
 * ═══════════════════════════════════════════════════════════════════════════
 * Injects a system message into an ACTIVE Telnyx AI-assistant call so an
 * owner/operator can steer Lola mid-conversation ("this is our VIP, comp the
 * blowout"). Uses Telnyx's call-control command
 * `POST /v2/calls/{call_control_id}/actions/ai_assistant_add_messages`
 * with a single system-role message. Telnyx attaches the message to the
 * assistant's live conversation for that call control leg — no conversation_id
 * needed, and we already track `call_control_id` in call_sessions.
 *
 * Bearer owner/operator token required (end-user signup/booking never calls
 * this). Messages targeted at a call that has ended surface Telnyx's rejection
 * honestly instead of silently succeeding.
 *
 * Body: { message: string, call_control_id?: string }
 *   - call_control_id omitted → resolve the tenant's most recent assistant
 *     conversation (call_sessions) automatically.
 */
import { bearer, getUserFromToken } from './lib/auth.js';
import { resolveTenantForUser } from './lib/tenant-access.js';
import { db } from './lib/db.js';

// Pure, testable: which assistant call should the whisper target?
export async function resolveTargetCall(client, tenantId, callControlId) {
  if (!client) return { error: 'Database not configured', status: 503 };
  if (callControlId) {
    const { data } = await client.from('call_sessions')
      .select('call_control_id')
      .eq('call_control_id', callControlId)
      .eq('tenant_id', tenantId)
      .maybeSingle()
      .catch(() => ({ data: null }));
    if (!data) return { error: 'Call not found or not yours', status: 404 };
    return { callControlId: data.call_control_id };
  }
  // No explicit target → the tenant's most recent assistant conversation.
  const { data } = await client.from('call_sessions')
    .select('call_control_id')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
    .catch(() => ({ data: null }));
  if (!data) return { error: 'No active call to whisper to', status: 404 };
  return { callControlId: data.call_control_id };
}

// Pure, testable: deliver the whisper to Telnyx (stub-friendly for tests).
export async function injectWhisper({ callControlId, message, telnyxKey }) {
  if (!telnyxKey) return { error: 'Telnyx not configured (TELNYX_API_KEY)', status: 503 };
  let data = null;
  try {
    const r = await fetch(
      `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/ai_assistant_add_messages`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${telnyxKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'system', content: message }],
          trigger_response: false
        })
      }
    );
    try { data = await r.json(); } catch { data = null; }
    if (!r.ok) {
      // A call that has already hung up is the usual case (Telnyx 4xx). Be honest.
      const detail = data?.errors?.[0]?.detail || data?.errors?.[0]?.title || data?.error || '';
      return { error: detail || `Telnyx rejected the whisper (HTTP ${r.status})`, status: r.status };
    }
    return { ok: true, result: data?.data?.result || 'ok' };
  } catch (e) {
    return { error: 'Telnyx unreachable: ' + String(e?.message || e), status: 502 };
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'Not authenticated' });

    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'No tenant found' });

    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const message = String(b.message || '').trim();
    if (!message) return res.status(400).json({ ok: false, error: 'message is required' });
    if (message.length > 2000) return res.status(400).json({ ok: false, error: 'message too long (max 2000 chars)' });

    const c = db();
    const target = await resolveTargetCall(c, tenant.id, b.call_control_id ? String(b.call_control_id) : '');
    if (target.error) return res.status(target.status).json({ ok: false, error: target.error });

    const injection = await injectWhisper({
      callControlId: target.callControlId,
      message,
      telnyxKey: process.env.TELNYX_API_KEY
    });
    if (!injection.ok) return res.status(injection.status || 500).json({ ok: false, ...injection });

    return res.json({ ok: true, call_control_id: target.callControlId, result: injection.result });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
}