/**
 * /api/admin/lola-health — live call routing health for the platform operator.
 * ════════════════════════════════════════════════════════════════════
 * One screen, the brain's vitals: is Lola's AI assistant attached, are the
 * numbers wired to a connection that reaches Lola, and are calls flowing
 * through her right now.
 *
 * Hard-gated exactly like /api/admin: the session's email must be in
 * ADMIN_EMAILS. No env var → nobody is admin → 403.
 *
 *   GET /api/admin/lola-health
 *     → { ok, generated_at, agent, voice, calls, routing }
 *
 * Every probe is read-only and degrades gracefully: an unreachable Telnyx
 * API (bad key, missing permission, timeout) surfaces as `error` on that
 * probe instead of a 500, so the panel still paints the signals it has.
 *
 * "Mismatch" is defined against LIVE Telnyx truth, not a single constant:
 * a tenant_number is ok when the recorded connection id matches what Telnyx
 * reports for that number — whatever connection that is (the Call Control
 * voice app, the LolaBrain assistant, or an AI-assistant connection), since
 * any of those routes to Lola. Only real drift (recorded ≠ live), missing
 * ids, the rejected legacy target, or an unattached number get flagged.
 *
 * Reads (Telnyx v2, live):
 *   • /ai/assistants                       — Lola exists / is attached
 *   • /phone_numbers                       — the REAL attachment per number
 *   • /connections + /ai/assistants        — connection id → name resolution
 *   • /connections/{id}/active_calls       — live calls through Lola
 */

import { bearer, getUserFromToken, isAdminEmail } from '../lib/auth.js';
import { listTenantNumberRoutes } from '../lib/db.js';
import { telnyxData, telnyxRequest } from '../lib/telnyx-client.js';
import { getLolaBrainConnectionIdSync } from '../lib/telnyx-provision.js';

// A connection id we KNOW Telnyx rejects for origination — supposedly the
// account's 'upgrade' mapping, but live probing proved it is dead. Any
// tenant_number still recorded against it is a health flag.
const REJECTED_LEGACY_CONNECTION = '2991758319724529273';

// The connections that route to Lola. The working Call Control voice app
// (TELNYX_VOICE_APP_ID) and the LolaBrain assistant's own TeXML app (the AI
// voice path every number now points at) are the canonical ones; any
// connection Telnyx reports as attached to an account number is additionally
// accepted at compare time, because a number on an AI-assistant connection is
// on the native LolaBrain path, not drift.
function knownGoodConnectionIds() {
  const ids = new Set();
  if (process.env.TELNYX_VOICE_APP_ID) ids.add(process.env.TELNYX_VOICE_APP_ID);
  const brain = getLolaBrainConnectionIdSync();
  if (brain) ids.add(brain);
  return ids;
}

// One live snapshot shared by the voice + routing probes so they agree.
// Fetches Telnyx's own numbers, connections, and AI assistants, and resolves
// connection id → human name (so the panel shows "LolaBrain" / "LolaDesk" /
// "ai-assistant-…" instead of raw ids). Fails soft: any probe error leaves
// its slice empty with a single `error` string.
async function liveTelnyxState() {
  try {
    const [numbersList, connsList, texmlList, asstsList] = await Promise.all([
      telnyxRequest('/phone_numbers', { query: { 'page[size]': 100 }, timeoutMs: 8000 }),
      telnyxRequest('/connections', { query: { 'page[size]': 100 }, timeoutMs: 8000 }).catch(() => ({ data: [] })),
      telnyxRequest('/texml_applications', { query: { 'page[size]': 100 }, timeoutMs: 8000 }).catch(() => ({ data: [] })),
      telnyxRequest('/ai/assistants', { query: { 'page[size]': 50 }, timeoutMs: 8000 }).catch(() => ({ data: [] }))
    ]);
    const numbers = (Array.isArray(telnyxData(numbersList)) ? telnyxData(numbersList) : []);
    const nameById = new Map();
    for (const c of (Array.isArray(telnyxData(connsList)) ? telnyxData(connsList) : [])) {
      nameById.set(c.id, c.connection_name || c.friendly_name || c.name || null);
    }
    for (const t of (Array.isArray(telnyxData(texmlList)) ? telnyxData(texmlList) : [])) {
      nameById.set(t.id, t.friendly_name || t.name || null);
    }
    for (const a of (Array.isArray(telnyxData(asstsList)) ? telnyxData(asstsList) : [])) {
      nameById.set(a.id, a.name || null);
    }
    const byPhone = new Map();
    for (const n of numbers) {
      byPhone.set(n.phone_number, {
        connection_id: n.connection_id || null,
        connection_name: nameById.get(n.connection_id) || null,
        status: n.status || null
      });
    }
    return { numbers, byPhone, nameById, error: null };
  } catch (e) {
    return { numbers: [], byPhone: new Map(), nameById: new Map(), error: String(e?.message || e) };
  }
}

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

// ── 2. Voice connection (live) ──────────────────────────────────────
// Reports each account number's REAL attachment from Telnyx, with the
// resolved connection name and whether that connection is known-good.
// `matches_expected` is kept for back-compat with the old single-constant
// view; `known_good` is the live-truth signal.
async function voiceStatus(live) {
  const known = knownGoodConnectionIds();
  const expected = process.env.TELNYX_VOICE_APP_ID || null;
  const rows = live.numbers.map(n => {
    const connectionId = n.connection_id || null;
    return {
      phone_number: n.phone_number || null,
      phone_number_id: n.id || null,
      connection_id: connectionId,
      connection_name: live.nameById.get(connectionId) || null,
      status: n.status || null,
      attached: Boolean(connectionId),
      known_good: known.has(connectionId),
      matches_expected: expected ? connectionId === expected : null
    };
  });
  const attached = rows.filter(r => r.attached).length;
  const matching = rows.filter(r => r.matches_expected === true).length;
  const knownGood = rows.filter(r => r.known_good).length;
  return {
    expected_connection_id: expected,
    known_connections: [...known],
    numbers: rows,
    counts: { total: rows.length, attached, matching, known_good: knownGood },
    error: live.error
  };
}

// ── 3. Number-routing health (tenant_numbers) ───────────────────────
// Cross-references the routing table against the LIVE Telnyx snapshot:
//   ok             recorded id matches what Telnyx reports for the number
//   mismatch       recorded id differs from the live attachment (real drift)
//   unattached     number exists on Telnyx but has no connection (the "-")
//   missing        no connection id recorded at all
//   rejected_legacy  recorded against the dead 'upgrade' target
//   not_on_telnyx  recorded in the routing table but Telnyx doesn't know it
// Routing itself keys off tenant_id+status, so an unattached/missing line
// still answers — but the operator should see the drift, not a green light.
async function routingStatus(live) {
  try {
    const routes = await listTenantNumberRoutes(500);
    // Live snapshot unavailable → fall back to the recorded id only; never
    // claim 'not_on_telnyx' for a number we simply couldn't look up.
    const liveKnown = !live.error;
    const numbers = (routes || []).map(r => {
      const recorded = r.connection_id || null;
      const liveRow = liveKnown ? (live.byPhone.get(r.phone_number) || null) : null;
      let flag = 'ok';
      let note = null;
      if (!recorded) {
        flag = 'missing';
        note = 'No connection id recorded';
      } else if (recorded === REJECTED_LEGACY_CONNECTION) {
        flag = 'rejected_legacy';
        note = 'Recorded against the dead legacy connection';
      } else if (!liveKnown) {
        flag = 'ok';
        note = 'Live Telnyx snapshot unavailable — checked against recorded id only';
      } else if (!liveRow) {
        flag = 'not_on_telnyx';
        note = 'Number not found in Telnyx';
      } else if (!liveRow.connection_id) {
        flag = 'unattached';
        note = 'Telnyx reports no connection for this number';
      } else if (recorded !== liveRow.connection_id) {
        flag = 'mismatch';
        note = 'Recorded id differs from live Telnyx attachment';
      }
      return {
        phone_number: r.phone_number,
        tenant_name: r.tenants?.name || r.tenant_name || null,
        tenant_slug: r.tenants?.slug || r.tenant_slug || null,
        kind: r.kind,
        status: r.status,
        connection_id: recorded,
        live_connection_id: liveRow?.connection_id || null,
        connection_name: liveRow?.connection_name || null,
        flag,
        note
      };
    });
    const flagged = numbers.filter(n => n.flag !== 'ok');
    const byFlag = {};
    for (const n of numbers) byFlag[n.flag] = (byFlag[n.flag] || 0) + 1;
    return {
      known_connections: [...knownGoodConnectionIds()],
      numbers,
      counts: {
        total: numbers.length,
        ok: numbers.length - flagged.length,
        flagged: flagged.length,
        by_flag: byFlag
      },
      error: live.error
    };
  } catch (e) {
    return {
      known_connections: [...knownGoodConnectionIds()],
      numbers: [],
      counts: { total: 0, ok: 0, flagged: 0, by_flag: {} },
      error: String(e?.message || e)
    };
  }
}

// ── 4. Active calls ─────────────────────────────────────────────────
async function activeCalls() {
  const connectionId = process.env.TELNYX_VOICE_APP_ID || null;
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
    // One live Telnyx snapshot feeds both the voice and routing probes so
    // the two panels can never disagree about what a number is attached to.
    const live = await liveTelnyxState();
    const [agent, voice, calls, routing] = await Promise.all([
      agentStatus(), voiceStatus(live), activeCalls(), routingStatus(live)
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
