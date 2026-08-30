/**
 * api/lib/call-callback.js — shared "call a client back" core
 * ════════════════════════════════════════════════════════════════════
 * The one implementation behind two transports:
 *   • /api/call-center/callback      (one-tap "Call back" — user-triggered)
 *   • autopilot agent callback-recovery (Lola autonomously returns missed calls)
 *
 * Originates a REAL Telnyx call FROM the tenant's own Lola line TO the
 * client, walking the connection-candidate chain until Telnyx accepts one
 * (see the endpoint for why: AI-assistant apps reject outbound originate).
 */

import { e164 } from './db.js';
import { telnyxData, telnyxRequest } from './telnyx-client.js';
import { getCanonicalVoiceConnectionId } from './telnyx-provision.js';

export function validPhone(input) {
  const phone = e164(input);
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return null;
  return phone;
}

/**
 * Resolve the salon's own Lola line (tenant_numbers primary, else the
 * canonical tenants.phone_number) and its attached connection.
 * @returns {{ from: string|null, connectionId: string|null, lineNote: string }}
 */
export async function resolveTenantLine(client, tenant) {
  let from = null;
  let connectionId = null;
  let lineNote = null;
  try {
    const { data: rows = [] } = await client.from('tenant_numbers')
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
    lineNote = lineNote || 'tenants.phone_number';
  }
  return { from, connectionId, lineNote };
}

/**
 * Build the connection-candidate chain for an OUTBOUND leg, in order:
 * line's own attachment → TELNYX_VOICE_APP_ID → canonical → any owned
 * number's connection. The first candidate Telnyx ACCEPTS wins.
 */
export async function connectionCandidates(client, lineConnectionId, lineNote) {
  let ownedNumbers = [];
  try {
    ownedNumbers = telnyxData(await telnyxRequest('/phone_numbers', { query: { 'page[size]': 100 }, timeoutMs: 8000 })) || [];
    if (!Array.isArray(ownedNumbers)) ownedNumbers = [];
  } catch { /* discovery is best-effort */ }
  const seen = new Set();
  const candidates = [];
  const push = (id, note) => { if (id && !seen.has(id)) { seen.add(id); candidates.push({ id, note }); } };
  push(lineConnectionId, lineNote || 'tenant line attachment');
  if (process.env.TELNYX_VOICE_APP_ID) push(process.env.TELNYX_VOICE_APP_ID, 'TELNYX_VOICE_APP_ID');
  try {
    const canonical = await getCanonicalVoiceConnectionId();
    push(canonical, 'canonical voice connection');
  } catch {}
  for (const n of ownedNumbers) push(n.connection_id, n.phone_number + '\'s connection');
  return candidates;
}

/**
 * Originate one callback call. Resolves the tenant's own line and walks the
 * candidate connections until Telnyx accepts.
 * @returns {{ ok: boolean, error?: string, from?: string, connection_id?: string,
 *            connection_note?: string, call_control_id?: string, tried_connections?: string[] }}
 */
export async function originateCallback(client, tenant, to) {
  if (!to) return { ok: false, error: 'no destination number' };

  const { from, connectionId, lineNote } = await resolveTenantLine(client, tenant);
  if (!from) return { ok: false, error: 'no Lola line' };
  if (from === to) return { ok: false, error: 'same number as salon line' };

  const candidates = await connectionCandidates(client, connectionId, lineNote);
  if (candidates.length === 0) {
    return { ok: false, error: 'No voice connection configured', to, from };
  }

  let data = null;
  let usedConnection = null;
  let usedNote = null;
  let firstError = null;
  for (const cand of candidates) {
    try {
      data = telnyxData(await telnyxRequest('/calls', {
        method: 'POST',
        body: { connection_id: cand.id, from, to, if_machine: 'continue' },
        timeoutMs: 15000
      }));
      usedConnection = cand.id;
      usedNote = cand.note;
      break;
    } catch (e) {
      if (!firstError) firstError = String(e?.message || e);
    }
  }
  if (!data) {
    const tried = candidates.map(c => c.note + ' (' + c.id + ')').join('; ');
    return {
      ok: false,
      error: firstError ? 'Telnyx rejected every connection: ' + firstError.slice(0, 140) : 'No connection could place the call',
      to, from, tried_connections: tried
    };
  }

  return {
    ok: true,
    to,
    from,
    connection_id: usedConnection,
    connection_note: usedNote,
    call_control_id: data?.call_control_id || data?.id || null
  };
}