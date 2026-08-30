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
 * The core (line resolution, connection-candidate walk, originate) lives
 * in api/lib/call-callback.js so Lola's autopilot callback-recovery agent
 * reuses the exact same originate path.
 */

import { bearer, getUserFromToken } from '../lib/auth.js';
import { db, logUsage } from '../lib/db.js';
import { resolveTenantForUser } from '../lib/tenant-access.js';
import { validPhone, originateCallback } from '../lib/call-callback.js';

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

  const c = db();
  if (!c) return res.status(503).json({ ok: false, error: 'Database not configured' });

  const result = await originateCallback(c, tenant, to);
  if (result.error === 'no Lola line') {
    return res.status(400).json({ ok: false, error: 'This salon has no Lola line yet — assign a number first' });
  }
  if (result.error === 'same number as salon line') {
    return res.status(400).json({ ok: false, error: 'The callback number must differ from the salon\u2019s own line' });
  }
  if (!result.ok) {
    return res.status(502).json({
      ok: false,
      error: result.error || 'Callback failed',
      to: result.to, from: result.from,
      tried_connections: result.tried_connections ?? undefined
    });
  }

  const { to: resTo, from, connection_id, connection_note, call_control_id } = result;
  try {
    await logUsage(tenant.id, 'callback_originated', 1, { to: resTo, from, connection_id, call_control_id });
  } catch {}

  return res.status(200).json({ ok: true, to: resTo, from, connection_id, connection_note, call_control_id });
}