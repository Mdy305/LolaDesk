/**
 * /api/admin/lola-health — live call routing health for the platform operator.
 * ════════════════════════════════════════════════════════════════════
 * One screen, the brain's vitals: is Lola's AI assistant attached, are the
 * numbers wired to the right voice connection, and are calls flowing through
 * her right now.
 *
 * Hard-gated exactly like /api/admin: the session's email must be in
 * ADMIN_EMAILS. No env var → nobody is admin → 403.
 *
 *   GET /api/admin/lola-health
 *     → { ok, generated_at, agent, voice, calls }
 *
 * Every probe is read-only and degrades gracefully: an unreachable Telnyx
 * API (bad key, missing permission, timeout) surfaces as `error` on that
 * probe instead of a 500, so the panel still paints the signals it has.
 *
 * Reads (Telnyx v2, live):
 *   • /ai/assistants                       — Lola exists / is attached
 *   • /phone_numbers                        — voice connection per number
 *   • /connections/{id}/active_calls        — live calls through Lola
 */

import { bearer, getUserFromToken, isAdminEmail } from '../lib/auth.js';
import { listTenantNumberRoutes } from '../lib/db.js';
import { telnyxData, telnyxRequest } from '../lib/telnyx-client.js';

// The connection every tenant's number must point at for inbound calls to
// reach Lola. Mirrors the provisioning logic in telecom.js / telnyx-numbers.js.
// Used VERBATIM: live probing proved TELNYX_VOICE_APP_ID (2982432232334951429)
// is the working Call Control app, while the old 'legacy upgrade' target
// (2991758319724529273) is rejected by Telnyx for call origination.
function expectedConnectionId() {
  return process.env.TELNYX_VOICE_APP_ID || null;
}

// A connection id we KNOW Telnyx rejects for origination — supposedly the
// account's 'upgrade' mapping, but live probing proved it is dead. Any
// tenant_number still recorded against it is a health flag.
const REJECTED_LEGACY_CONNECTION = '2991758319724529273';

// ── 1. Agent attached ────────────────────────────────────────────────
async function agentStatus() {
  try {
    const list = telnyxData(await telnyxRequest('/ai/assistants', { query: { 'page[size]': 50 }, timeoutMs: 8000 }));
    const assistants = (Array.isArray(list) ? list : []).map(a => ({
      id: a.id || null,
      name: a.name || null,
      model: a.model || null,
      voice: a.voice_settings?.voice || a.voice || null,
      created_at: a.created_at || null
    }));
    return { exists: assistants.length > 0, count: assistants.length, assistants, error: null };
  } catch (e) {
    return { exists: false, count: 0, assistants: [], error: String(e?.message || e) };
  }
}

// ── 2. Voice connection ─────────────────────────────────────────────
async function voiceStatus() {
  const expected = expectedConnectionId();
  try {
    const numbers = telnyxData(await telnyxRequest('/phone_numbers', { query: { 'page[size]': 100 }, timeoutMs: 8000 }));
    const rows = (Array.isArray(numbers) ? numbers : []).map(n => {
      const connectionId = n.connection_id || null;
      return {
        phone_number: n.phone_number || null,
        phone_number_id: n.id || null,
        connection_id: connectionId,
        status: n.status || null,
        attached: Boolean(connectionId),
        matches_expected: expected ? connectionId === expected : null
      };
    });
    const attached = rows.filter(r => r.attached).length;
    const matching = rows.filter(r => r.matches_expected === true).length;
    return {
      expected_connection_id: expected,
      numbers: rows,
      counts: { total: rows.length, attached, matching },
      error: null
    };
  } catch (e) {
    return {
      expected_connection_id: expected,
      numbers: [],
      counts: { total: 0, attached: 0, matching: 0 },
      error: String(e?.message || e)
    };
  }
}  // ── 3. Number-routing health (tenant_numbers) ──────────────────────
  // Every tenant's line in the routing table should carry the working voice
  // connection id. A null id means the record was never populated (routing
  // itself keys off tenant_id+status, so the line still answers — but the
  // record is missing data the operator needs), and the legacy 'upgrade'
  // target is rejected by Telnyx for origination. Either way the row is
  // flagged here so drift shows up on the health screen, not just in the
  // admin table.
async function routingStatus() {
  const expected = expectedConnectionId();
  try {
    const routes = await listTenantNumberRoutes(500);
    const numbers = (routes || []).map(r => {
      const id = r.connection_id || null;
      let flag = 'ok';
      if (!id) flag = 'missing';
      else if (id === REJECTED_LEGACY_CONNECTION) flag = 'rejected_legacy';
      else if (expected && id !== expected) flag = 'mismatch';
      return {
        phone_number: r.phone_number,
        tenant_name: r.tenants?.name || r.tenant_name || null,
        tenant_slug: r.tenants?.slug || r.tenant_slug || null,
        kind: r.kind,
        status: r.status,
        connection_id: id,
        flag
      };
    });
    const flagged = numbers.filter(n => n.flag !== 'ok');
    return {
      expected_connection_id: expected,
      numbers,
      counts: {
        total: numbers.length,
        ok: numbers.length - flagged.length,
        flagged: flagged.length
      },
      error: null
    };
  } catch (e) {
    return {
      expected_connection_id: expected,
      numbers: [],
      counts: { total: 0, ok: 0, flagged: 0 },
      error: String(e?.message || e)
    };
  }
}

  // ── 4. Active calls ─────────────────────────────────────────────────
async function activeCalls() {
  const connectionId = expectedConnectionId();
  if (!connectionId) {
    return { connection_id: null, active: 0, calls: [], error: 'TELNYX_VOICE_APP_ID is not configured — cannot resolve the voice connection' };
  }
  try {
    const list = telnyxData(await telnyxRequest(`/connections/${connectionId}/active_calls`, { query: { 'page[size]': 50 }, timeoutMs: 8000 }));
    const calls = (Array.isArray(list) ? list : []).map(c => ({
      call_control_id: c.call_control_id || null,
      call_leg_id: c.call_leg_id || null,
      call_session_id: c.call_session_id || null,
      call_duration: c.call_duration ?? null
    }));
    return { connection_id: connectionId, active: calls.length, calls, error: null };
  } catch (e) {
    return { connection_id: connectionId, active: 0, calls: [], error: String(e?.message || e) };
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET only' });

  const user = await getUserFromToken(bearer(req));
  if (!user) return res.status(401).json({ ok: false, error: 'Not signed in' });
  if (!isAdminEmail(user.email)) return res.status(403).json({ ok: false, error: 'Not authorized' });

  try {
    const [agent, voice, calls, routing] = await Promise.all([
      agentStatus(), voiceStatus(), activeCalls(), routingStatus()
    ]);
    return res.status(200).json({
      ok: true,
      generated_at: new Date().toISOString(),
      agent,
      voice,
      calls,
      routing
    });
  } catch (e) {
    console.error('[admin/lola-health]', e?.message || e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
