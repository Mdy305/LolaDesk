// Telnyx helpers. Sends calls + SMS via HTTPS; verifies webhook signatures.
import { verifyTelnyxSignature } from './telnyx-webhook-verify.js';
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

// Verify Ed25519 signature of a Telnyx webhook. Returns true on valid.
// Header names (case-insensitive): telnyx-signature-ed25519, telnyx-timestamp.
// Same rule as every other Telnyx receiver (telnyx-webhook-verify.js): with no TELNYX_PUBLIC_KEY
// it accepts outside production (and says so) and FAILS CLOSED in production — it used to answer
// 401 to every event whenever the key was missing, even in preview/local.
export function verifyTelnyxSig(headers, rawBody) {
  try {
    const h = headers || {};
    const pick = (k) => h[k] || h[k.toLowerCase()] || h[k.replace(/(^|-)([a-z])/g, (m, d, c) => d + c.toUpperCase())] || '';
    return verifyTelnyxSignature({ headers: { 'telnyx-signature-ed25519': pick('telnyx-signature-ed25519'), 'telnyx-timestamp': pick('telnyx-timestamp') } }, rawBody);
  } catch { return false; }
}

// Resolve a Lola phone number to its tenant.
export async function tenantForNumber(supabase, number) {
  const { data } = await supabase.from('tenants').select('id, slug, phone_number, telnyx_assistant_id').eq('phone_number', number).maybeSingle();
  return data || null;
}
