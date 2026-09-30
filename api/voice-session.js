/**
 * /api/voice-session — mints a short-lived signed voice session for Lola
 * ════════════════════════════════════════════════════════════════
 * POST, auth: Bearer <supabase JWT> (same auth as /api/lola and the
 * existing /api/voice/session).
 *
 * Returns:
 *   { session_token, assistant_id, expires_at, relay_url, dynamic_variables }
 *
 * The session_token is a 5-minute HMAC blob tying this owner user to their
 * tenant. The relay at relay_url validates it and proxies the browser's
 * WebSocket to the Telnyx AI Assistant conversation socket — Telnyx's own
 * key never leaves the server. The assistant_id being set is a hard gate:
 * without TELNYX_ASSISTANT_ID there is no assistant to talk to, so we fail
 * loudly rather than hand the browser a token that can never connect.
 *
 * dynamic_variables: the tenant's real salon facts, resolved server-side
 * with the SAME builder the phone-call webhook uses. The client MUST send
 * them as its first session.update frame — without them the assistant's
 * prompt is all unset template variables and it produces silence.
 */
import { getUserFromToken, bearer } from './lib/auth.js';
import { resolveTenantForUser } from './lib/tenant-access.js';
import { issueVoiceToken } from './lib/voice-session-token.js';
import { buildTenantVariables } from './lib/tenant-variables.js';

const ASSISTANT_ID = process.env.TELNYX_ASSISTANT_ID;
// The relay is a long-lived WebSocket. Vercel functions can't accept a
// WebSocket upgrade, so the in-browser Telnyx conversation only turns on when
// the relay is hosted somewhere that can (LOLA_VOICE_RELAY_URL=wss://…).
// Until then the orb uses Lola's direct path: the browser hears you, her
// brain answers (/api/lola) and she speaks (/api/speak-lola) — which always works.
const RELAY_URL = String(process.env.LOLA_VOICE_RELAY_URL || '').trim();

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  if (!RELAY_URL) {
    return res.status(503).json({ error: 'Live voice relay not hosted — Lola uses her direct voice path.', code: 'relay_not_available' });
  }
  if (!ASSISTANT_ID) {
    return res.status(503).json({
      error: 'TELNYX_ASSISTANT_ID not configured. Create the Lola AI Assistant '
        + 'in the Telnyx Portal and set its id — voice cannot start until then.',
      code: 'assistant_not_configured',
    });
  }

  try {
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ error: 'Not authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(403).json({ error: 'No tenant for user' });

    const session_token = issueVoiceToken({ userId: user.id, tenantId: tenant.id });

    // Best-effort: the orb speaks even if the catalog read hiccups (the
    // builder itself never throws; this catch is belt-and-braces).
    let dynamic_variables = null;
    try {
      dynamic_variables = await buildTenantVariables(tenant, { to: '', from: '' });
    } catch (e) {
      console.warn('[VOICE-SESSION] dynamic_variables failed:', e?.message);
    }

    return res.status(200).json({
      ok: true,
      session_token,
      assistant_id: ASSISTANT_ID,
      expires_at: Date.now() + 5 * 60 * 1000,
      relay_url: RELAY_URL,
      dynamic_variables,
    });
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'Voice session failed' });
  }
}
