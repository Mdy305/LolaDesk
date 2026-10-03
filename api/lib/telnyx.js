// Telnyx helpers. Sends calls + SMS via HTTPS; verifies webhook signatures.
import crypto from 'crypto';
import { telnyxPublicKey } from './telnyx-webhook-verify.js';
import { sendSms } from './sms.js';

const BASE = 'https://api.telnyx.com/v2';

function auth() {
  const key = process.env.TELNYX_API_KEY;
  if (!key) throw new Error('TELNYX_API_KEY missing');
  return { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
}

// Send an outbound SMS — through THE one funnel (lib/sms.js): the salon's own
// line, its opt-outs and one place for errors. Throws on failure, as before.
export async function sendSMS({ from, to, text, tenantId, type } = {}) {
  const r = await sendSms({ from, to, text, tenantId, type });
  if (r?.skipped) throw new Error(r.reason === 'opted_out' ? 'opted_out' : `not sent: ${r.reason}`);
  if (r?.errors?.length) throw new Error(r.errors[0]?.detail || 'Telnyx SMS failed');
  return r?.data || r;
}

// Answer an inbound call, hand off to the AI Assistant for the salon.
// Telnyx: inbound calls must be answered before other commands; ai_assistant_start takes
// { assistant: { id } } (there is no top-level assistant_id). command_id makes a retried webhook harmless.
export async function answerCallWithAssistant(call_control_id, assistant_id, { commandId = null } = {}) {
  const enc = encodeURIComponent(call_control_id);
  const ans = await fetch(BASE + '/calls/' + enc + '/actions/answer', {
    method: 'POST', headers: auth(), body: JSON.stringify(commandId ? { command_id: commandId + ':answer' } : {})
  });
  if (!ans.ok && ans.status !== 422) { const j = await ans.json().catch(() => ({})); throw new Error(j?.errors?.[0]?.detail || 'Telnyx answer failed'); }  // 422 = already answered
  const r = await fetch(BASE + '/calls/' + enc + '/actions/ai_assistant_start', {
    method: 'POST',
    headers: auth(),
    body: JSON.stringify({ assistant: { id: assistant_id }, ...(commandId ? { command_id: commandId + ':ai' } : {}) })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.errors?.[0]?.detail || 'Telnyx AI start failed');
  return j.data;
}

// Whisper a system message into an active AI Assistant call (documented: ai_assistant_add_messages).
export async function whisperToAssistant(call_control_id, message) {
  const r = await fetch(BASE + '/calls/' + encodeURIComponent(call_control_id) + '/actions/ai_assistant_add_messages', {
    method: 'POST',
    headers: auth(),
    body: JSON.stringify({ messages: [{ role: 'system', content: String(message || '') }] })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.errors?.[0]?.detail || 'Whisper failed');
  return j.data;
}

// Callback flow: ring the owner first, then bridge to the target.
export async function placeCallback({ from, owner_phone, target_phone }) {
  const r = await fetch(BASE + '/calls', {
    method: 'POST',
    headers: auth(),
    body: JSON.stringify({
      connection_id: process.env.TELNYX_CONNECTION_ID,
      to: owner_phone,
      from,
      client_state: Buffer.from(JSON.stringify({ target: target_phone, kind: 'owner_callback' })).toString('base64')
    })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.errors?.[0]?.detail || 'Callback failed');
  return j.data;
}

// Verify Ed25519 signature of a Telnyx webhook. Returns true on valid.
// Header names (case-insensitive): telnyx-signature-ed25519, telnyx-timestamp.
export function verifyTelnyxSig(headers, rawBody) {
  try {
    const sig = headers['telnyx-signature-ed25519'] || headers['Telnyx-Signature-Ed25519'];
    const ts  = headers['telnyx-timestamp']         || headers['Telnyx-Timestamp'];
    const pub = process.env.TELNYX_PUBLIC_KEY;  // Telnyx dashboard → public key for this endpoint
    if (!sig || !ts || !pub) return false;
    if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;   // replayed / stale (Telnyx: 5-minute window)
    const payload = ts + '|' + rawBody;
    const key = telnyxPublicKey(pub);
    return crypto.verify(null, Buffer.from(payload), key, Buffer.from(sig, 'base64'));
  } catch { return false; }
}

// Resolve a Lola phone number to its tenant.
export async function tenantForNumber(supabase, number) {
  const { data } = await supabase.from('tenants').select('id, slug, phone_number, telnyx_assistant_id').eq('phone_number', number).maybeSingle();
  return data || null;
}
