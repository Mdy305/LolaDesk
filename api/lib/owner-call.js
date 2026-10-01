/**
 * api/lib/owner-call.js — the owner calls a client from LolaDesk.
 * ════════════════════════════════════════════════════════════════════
 * Tap "Call" on a client: LolaDesk rings the OWNER's mobile first (from the
 * salon's Lola line, so they know it's work), says "Connecting you to Maria",
 * then dials the client and joins the two. The client sees the salon's
 * number, never the owner's personal one — on any device, Mac included.
 *
 * Telnyx Call Control: POST /calls to the owner with a per-call webhook_url
 * (/api/call-center/bridge) and client_state; on answer → speak → transfer.
 */
import { e164, db } from './db.js';
import { telnyxData, telnyxRequest, appUrl } from './telnyx-client.js';
import { resolveTenantLine, connectionCandidates } from './call-callback.js';
import { demoStep } from './demo-call.js';

export const encodeState = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
export function decodeState(s) { try { return JSON.parse(Buffer.from(String(s || ''), 'base64').toString('utf8')); } catch (_) { return null; } }

export async function callThroughOwner(client, tenant, clientPhone, { clientName = '' } = {}) {
  const to = e164(clientPhone);
  if (!to || to.replace(/\D/g, '').length < 10) return { ok: false, error: 'bad_number', say: 'That number doesn’t look right.' };
  const owner = e164(tenant.operator_phone || '');
  if (!owner) return { ok: false, error: 'no_owner_phone', say: 'Add your mobile in Settings → Lola → Voice command, and I’ll ring you first, then connect the client.' };
  if (!process.env.TELNYX_API_KEY) return { ok: false, error: 'telnyx_not_configured', say: 'Telnyx isn’t connected.' };
  const { from, connectionId, lineNote } = await resolveTenantLine(client, tenant);
  if (!from) return { ok: false, error: 'no_line', say: 'Your salon needs its Lola number first (Salon → Phone & texting).' };
  const candidates = await connectionCandidates(client, connectionId, lineNote);
  const state = encodeState({ k: 'owner_bridge', to, from, n: String(clientName || '').slice(0, 40), t: tenant.id });
  let data = null, firstError = null;
  for (const cand of candidates) {
    try {
      data = telnyxData(await telnyxRequest('/calls', { method: 'POST', timeoutMs: 15000, body: {
        connection_id: cand.id, to: owner, from, timeout_secs: 30, client_state: state,
        webhook_url: appUrl() + '/api/call-center/bridge', webhook_url_method: 'POST',
      } }));
      break;
    } catch (e) { if (!firstError) firstError = String(e?.message || e); }
  }
  if (!data) return { ok: false, error: 'telnyx_rejected', detail: firstError, say: 'Telnyx wouldn’t place the call. Say “Lola, run a check”.' };
  try {
    await client.from('calls').insert({ tenant_id: tenant.id, from_number: from, to_number: to, direction: 'outbound', status: 'ringing',
      telnyx_call_control_id: data.call_control_id || null, summary: `Owner call to ${clientName || to}` });
  } catch (_) { /* the call matters more than the log */ }
  return { ok: true, say: `Calling your phone now — pick up and I’ll connect you to ${clientName || 'them'}.`, call_control_id: data.call_control_id || null, owner, from, to };
}

/** The bridge's brain: given a Telnyx event, what to do next. Pure, so it can be tested. */
export function bridgeStep(event) {
  const type = event?.data?.event_type, p = event?.data?.payload || {};
  const st = decodeState(p.client_state);
  if (st && st.k === 'lola_demo' && p.call_control_id) return demoStep(type, p, st);
  if (!st || st.k !== 'owner_bridge' || !p.call_control_id) return null;
  if (type === 'call.answered' && !st.spoke) {
    return { id: p.call_control_id, action: 'speak', body: { payload: `Connecting you to ${st.n || 'your client'}.`, voice: 'female', language: 'en-US', client_state: encodeState({ ...st, spoke: 1 }) } };
  }
  if (type === 'call.speak.ended' && !st.joined) {
    return { id: p.call_control_id, action: 'transfer', body: { to: st.to, from: st.from, timeout_secs: 40, client_state: encodeState({ ...st, joined: 1 }) } };
  }
  return null;
}

export async function runBridgeStep(event) {
  const step = bridgeStep(event);
  if (!step) return { ok: true, ignored: true };
  const run = (a, b) => telnyxRequest(`/calls/${encodeURIComponent(step.id)}/actions/${a}`, { method: 'POST', body: b, timeoutMs: 8000 });
  try { await run(step.action, step.body); }
  catch (e) {
    if (!step.fallback) throw e;
    console.warn('[bridge]', step.action, 'refused, falling back:', String(e?.message || e).slice(0, 140));
    await run(step.fallback.action, step.fallback.body);
    return { ok: true, did: step.fallback.action, fallback: true };
  }
  return { ok: true, did: step.action };
}
export { db };
