/**
 * /api/admin/test-call — originate a REAL Telnyx call to any tenant number.
 * ════════════════════════════════════════════════════════════════════
 * The operator's one-click "does the line actually work?" — rings a number
 * through Telnyx using the server-side TELNYX_API_KEY, so live voice tests
 * never depend on a local secret. When the destination is a tenant number
 * wired to Lola's connection, she answers with her real voice and the call
 * exercises the full inbound path (routing resolver → TeXML → ElevenLabs
 * synthesis → voice-audio cache → call record).
 *
 * Hard-gated exactly like /api/admin: the session's email must be in
 * ADMIN_EMAILS. No env var → nobody is admin → 403.
 *
 *   POST /api/admin/test-call
 *     { to: '+19294568227', from?: '+13055550100' }
 *     → { ok, to, from, connection_id, call_control_id, telnyx, routing }
 *
 * `to` is any E.164 number (usually a tenant's line). `from` is optional:
 * when omitted the endpoint uses DEMO_FROM_NUMBER / TELNYX_FROM_NUMBER if
 * set, otherwise auto-discovers an owned number from the account that
 * isn't the destination.
 *
 * The response includes `routing` — whether the dialed number currently
 * resolves to a tenant and who will answer — so a test call to a number
 * that isn't wired to anyone is visible immediately instead of ringing
 * into the void.
 */

import { bearer, getUserFromToken, isAdminEmail } from '../lib/auth.js';
import { db, e164, logUsage } from '../lib/db.js';
import { resolveInboundTenant } from '../lib/tenant-resolver.js';
import { telnyxData, telnyxRequest, TelnyxApiError } from '../lib/telnyx-client.js';

// The connection the outbound leg originates from. Mirrors the provisioning
// logic in telecom.js / telnyx-numbers.js / demo-call.js: the legacy app id
// is transparently upgraded to the live connection id.
function expectedConnectionId() {
  const raw = process.env.TELNYX_VOICE_APP_ID;
  if (!raw) return null;
  return raw === '2982432232334951429' ? '2991758319724529273' : raw;
}

// E.164 with sane bounds so 'abc' or a bare '+' can't slip through.
function validPhone(input) {
  const phone = e164(input);
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return null;
  return phone;
}

function err(status, message) {
  return Object.assign(new Error(message), { status });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  const user = await getUserFromToken(bearer(req));
  if (!user) return res.status(401).json({ ok: false, error: 'Not signed in' });
  if (!isAdminEmail(user.email)) return res.status(403).json({ ok: false, error: 'Not authorized' });

  let body = {};
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  } catch {
    return res.status(400).json({ ok: false, error: 'Invalid JSON body' });
  }

  const to = validPhone(body.to);
  if (!to) return res.status(400).json({ ok: false, error: 'A valid "to" phone number is required (E.164, 8–15 digits)' });

  let from = null;
  if (body.from) {
    from = validPhone(body.from);
    if (!from) return res.status(400).json({ ok: false, error: '"from" must be a valid E.164 number (8–15 digits)' });
  }

  // Who will answer? Best-effort: routing failures never block the call,
  // they just tell the operator the number isn't wired to a tenant yet.
  let routing = null;
  try {
    routing = await resolveInboundTenant({ to });
  } catch (e) {
    routing = { status: 'error', reason: String(e?.message || e).slice(0, 200), tenant: null };
  }

  // Discover the account's numbers once: used both for the caller ID and,
  // crucially, for the destination's own connection. Real accounts spread
  // numbers across several connections, and the platform's TELNYX_VOICE_APP_ID
  // may not be the one a given number actually rings through — originating
  // from the destination number's own connection guarantees the inbound leg
  // lands on the right app AND that the outbound leg uses a connection Telnyx
  // accepts (a number is only attached to a working Call Control app).
  let ownedNumbers = [];
  try {
    ownedNumbers = telnyxData(await telnyxRequest('/phone_numbers', { query: { 'page[size]': 100 }, timeoutMs: 8000 })) || [];
    if (!Array.isArray(ownedNumbers)) ownedNumbers = [];
  } catch (e) {
    return res.status(502).json({
      ok: false, error: `Could not list account numbers: ${String(e?.message || e)}`, to
    });
  }

  const destNumber = ownedNumbers.find(n => n.phone_number === to);
  const connectionId = destNumber?.connection_id || expectedConnectionId();
  if (!connectionId) {
    return res.status(400).json({ ok: false, error: 'No voice connection for the destination number and TELNYX_VOICE_APP_ID is not configured' });
  }
  const connectionNote = destNumber?.connection_id
    ? `originating from ${to}'s own connection (${connectionId})`
    : `destination is not an owned number — using platform connection ${connectionId}`;

  // Pick the outbound caller ID: explicit → env → first owned number that
  // isn't the destination.
  if (!from) {
    from = process.env.DEMO_FROM_NUMBER || process.env.TELNYX_FROM_NUMBER || null;
  }
  if (!from) {
    const candidates = ownedNumbers.filter(n => n.phone_number && n.phone_number !== to);
    from = candidates[0]?.phone_number || null;
  }
  if (!from) {
    return res.status(400).json({
      ok: false, error: 'No owned number to originate from — pass "from" or set DEMO_FROM_NUMBER / TELNYX_FROM_NUMBER', to
    });
  }

  try {
    const data = telnyxData(await telnyxRequest('/calls', {
      method: 'POST',
      body: { connection_id: connectionId, from, to, if_machine: 'continue' },
      timeoutMs: 15000
    }));
    const callControlId = data?.call_control_id || data?.id || null;

    if (routing?.tenant?.id) {
      try {
        await logUsage(routing.tenant.id, 'test_call', 1, { to, from });
      } catch {}
    }

    return res.status(200).json({
      ok: true,
      to,
      from,
      connection_id: connectionId,
      connection_note: connectionNote,
      call_control_id: callControlId,
      telnyx: data,
      routing
    });
  } catch (e) {
    const status = e instanceof TelnyxApiError && e.status >= 400 && e.status < 600 ? e.status : 502;
    return res.status(status).json({ ok: false, error: String(e?.message || e), to, from });
  }
}