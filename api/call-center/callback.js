/**
 * /api/call-center/callback — Lola calls a client back (tenant-scoped)
 * ════════════════════════════════════════════════════════════════════
 * The Call Center's one-tap "Call back": originates a REAL Telnyx call
 * FROM the salon's own Lola line TO the client's number. Because the
 * tenant's line is attached to the LolaBrain TeXML app, when the client
 * answers, the AI assistant greets them — Lola herself runs the callback,
 * with the caller's full context (they called earlier; here's what was
 * said) already loaded from the insights that landed on the Calls page.
 *
 * Tenant-scoped, NOT admin-gated: any owner/staff of the salon may call
 * back their own clients. The platform operator's test-call endpoint
 * (/api/admin/test-call) remains the admin-only line test.
 *
 *   POST /api/call-center/callback
 *     { to: '+14155550123' }
 *     → { ok, to, from, connection_id, call_control_id }
 *
 * `to` is the client's E.164 number. `from` is the tenant's own primary
 * number (tenant_numbers kind='primary', else tenants.phone_number), so
 * the client sees the salon calling and Telnyx accepts the outbound leg
 * on the tenant's own connection. The response includes the Telnyx
 * call_control_id so the UI can show the live call on the Call Center.
 */

import { bearer, getUserFromToken } from '../lib/auth.js';
import { db, e164, logUsage } from '../lib/db.js';
import { resolveTenantForUser } from '../lib/tenant-access.js';
import { telnyxData, telnyxRequest, TelnyxApiError } from '../lib/telnyx-client.js';
import { getCanonicalVoiceConnectionId } from '../lib/telnyx-provision.js';

function validPhone(input) {
  const phone = e164(input);
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return null;
  return phone;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  const user = await getUserFromToken(bearer(req));
  if (!user) return res.status(401).json({ ok: false, error: 'Not signed in' });

  const tenant = await resolveTenantForUser(user);
  if (!tenant) return res.status(404).json({ ok: false, error: 'No salon found for this account' });

  let body = {};
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  } catch {
    return res.status(400).json({ ok: false, error: 'Invalid JSON body' });
  }

  const to = validPhone(body.to);
  if (!to) return res.status(400).json({ ok: false, error: 'A valid "to" client number is required (E.164, 8–15 digits)' });

  // ── Resolve the salon's own line: tenant_numbers primary row first, then
  // the canonical tenants.phone_number. Never originate from another
  // tenant's number — multi-tenant isolation is the whole point.
  const c = db();
  if (!c) return res.status(503).json({ ok: false, error: 'Database not configured' });

  let from = null;
  let connectionId = null;
  let lineNote = null;
  try {
    const { data: rows = [] } = await c.from('tenant_numbers')
      .select('phone_number,kind,status,connection_id')
      .eq('tenant_id', tenant.id)
      .limit(50);
    const primary = rows.find(r => r.kind === 'primary' && r.status === 'active')
      || rows.find(r => r.phone_number && r.status === 'active');
    if (primary?.phone_number) {
      from = primary.phone_number;
      connectionId = primary.connection_id || null;
      lineNote = 'tenant_numbers primary';
    }
  } catch (e) {
    lineNote = `tenant_numbers lookup failed (${String(e?.message || e).slice(0, 80)})`;
  }
  if (!from && tenant.phone_number) {
    from = tenant.phone_number;
    connectionId = connectionId || null;
    lineNote = lineNote || 'tenants.phone_number';
  }
  if (!from) return res.status(400).json({ ok: false, error: 'This salon has no Lola line yet — assign a number first' });
  if (from === to) return res.status(400).json({ ok: false, error: 'The callback number must differ from the salon\u2019s own line' });

  // Connection: the tenant line's own attachment (the LolaBrain TeXML app)
  // so the AI assistant answers the outbound leg; fall back to the
  // canonical voice connection. Fail loudly if nothing resolves.
  if (!connectionId) {
    try {
      connectionId = await getCanonicalVoiceConnectionId();
      lineNote = (lineNote || '') + ' (canonical voice connection)';
    } catch (e) {
      return res.status(502).json({ ok: false, error: `No voice connection: ${String(e?.message || e).slice(0, 120)}` });
    }
  }
  if (!connectionId) {
    return res.status(502).json({ ok: false, error: 'No voice connection configured — set TELNYX_VOICE_APP_ID or TELNYX_LOLA_BRAIN_ID' });
  }

  let data = null;
  try {
    data = telnyxData(await telnyxRequest('/calls', {
      method: 'POST',
      body: { connection_id: connectionId, from, to, if_machine: 'continue' },
      timeoutMs: 15000
    }));
  } catch (e) {
    const status = e instanceof TelnyxApiError ? e.status : 502;
    return res.status(status).json({
      ok: false, error: String(e?.message || e).slice(0, 200), to, from
    });
  }

  const callControlId = data?.call_control_id || data?.id || null;
  try {
    await logUsage(tenant.id, 'callback_originated', 1, { to, from, call_control_id: callControlId });
  } catch {}

  return res.status(200).json({
    ok: true, to, from, connection_id: connectionId,
    connection_note: lineNote, call_control_id: callControlId
  });
}
