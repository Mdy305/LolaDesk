// Telnyx helpers. Sends calls + SMS via HTTPS; verifies webhook signatures.
import crypto from 'crypto';

const BASE = 'https://api.telnyx.com/v2';

function auth() {
  const key = process.env.TELNYX_API_KEY;
  if (!key) throw new Error('TELNYX_API_KEY missing');
  return { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
}

// Send an outbound SMS. Uses the tenant's messaging profile for 10DLC.
export async function sendSMS({ from, to, text }) {
  const r = await fetch(BASE + '/messages', {
    method: 'POST',
    headers: auth(),
    body: JSON.stringify({
      from, to, text,
      messaging_profile_id: process.env.TELNYX_MESSAGING_PROFILE_ID
    })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.errors?.[0]?.detail || 'Telnyx SMS failed');
  return j.data;
}

// Answer an inbound call, hand off to the AI Assistant for the salon.
export async function answerCallWithAssistant(call_control_id, assistant_id) {
  const r = await fetch(BASE + '/calls/' + call_control_id + '/actions/ai_assistant_start', {
    method: 'POST',
    headers: auth(),
    body: JSON.stringify({ assistant_id })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.errors?.[0]?.detail || 'Telnyx AI start failed');
  return j.data;
}

// Whisper a system message into an active AI Assistant call.
export async function whisperToAssistant(call_control_id, message) {
  const r = await fetch(BASE + '/calls/' + call_control_id + '/actions/ai_assistant_message', {
    method: 'POST',
    headers: auth(),
    body: JSON.stringify({ message, role: 'system' })
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
    const payload = ts + '|' + rawBody;
    const key = crypto.createPublicKey({ key: Buffer.from(pub, 'base64'), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(payload), key, Buffer.from(sig, 'base64'));
  } catch { return false; }
}

// Resolve a Lola phone number to its tenant.
export async function tenantForNumber(supabase, number) {
  const { data } = await supabase.from('tenants').select('id, slug, phone_number, telnyx_assistant_id').eq('phone_number', number).maybeSingle();
  return data || null;
}
