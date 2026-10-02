/**
 * api/lib/forwarding.js — keep the salon's number; Lola picks up what it misses.
 * ════════════════════════════════════════════════════════════════════════════
 * Porting a number takes 1–3 weeks and scares owners. Conditional call
 * forwarding takes 90 seconds: the salon phone rings as usual, and when nobody
 * answers (after ~2 rings), the line is busy, or it's after hours (nobody there
 * to answer), the carrier sends the call to the salon's Lola number.
 *
 *   forwardingPlan(lolaNumber, carrier) → the exact codes to dial, per carrier
 *   startForwardingTest(c, tenant)      → LolaDesk calls the salon number; if the
 *                                          carrier forwards it back to Lola, it works
 *   noteForwardedArrival(c, tenant, from, to) → called when Lola's line rings from
 *                                          itself (the test arriving) → verified
 */
import { e164 } from './db.js';
import { telnyxData, telnyxRequest, appUrl } from './telnyx-client.js';
import { connectionCandidates } from './call-callback.js';
import { encodeState } from './owner-call.js';

const digits = (n) => String(n || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');

export const CARRIERS = {
  att: { name: 'AT&T', kind: 'gsm' },
  tmobile: { name: 'T-Mobile / Metro', kind: 'gsm' },
  verizon: { name: 'Verizon', kind: 'verizon' },
  landline: { name: 'Landline / business phone (Comcast, Spectrum, RingCentral…)', kind: 'portal' },
};

/** The codes to dial on the salon phone, in plain words. */
export function forwardingPlan(lolaNumber, carrier = 'att', { ringSeconds = 10 } = {}) {
  const d = digits(lolaNumber);
  if (d.length !== 10) return { ok: false, error: 'Lola needs her phone number first.' };
  const pretty = `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  const c = CARRIERS[carrier] || CARRIERS.att;
  if (c.kind === 'gsm') return { ok: true, carrier: c.name, lola: pretty, steps: [
    { when: `No answer after ~2 rings`, dial: `**61*1${d}**${ringSeconds}#`, cancel: '##61#' },
    { when: 'Line busy', dial: `**67*1${d}#`, cancel: '##67#' },
    { when: 'Phone off / no signal', dial: `**62*1${d}#`, cancel: '##62#' },
  ], note: 'Dial each code from the salon phone and press Call. You’ll see a confirmation on screen. To undo everything: ##002#.' };
  if (c.kind === 'verizon') return { ok: true, carrier: c.name, lola: pretty, steps: [
    { when: 'No answer or busy', dial: `*71${d}`, cancel: '*73' },
  ], note: 'Dial it from the salon phone and press Call; wait for the confirmation tone, then hang up. Verizon forwards after about 4 rings.' };
  return { ok: true, carrier: c.name, lola: pretty, steps: [
    { when: 'No answer (2 rings) and busy', dial: null, portal: `In your phone provider’s online portal or app: Call forwarding → “No answer” and “Busy” → forward to ${pretty}`, cancel: 'Turn the same setting off' },
  ], note: 'Most business lines also accept *92 then the number for no-answer forwarding — your provider’s portal is the reliable way.' };
}

/** LolaDesk calls the salon's own number; if forwarding works, the call comes back to Lola's line. */
export async function startForwardingTest(c, tenant, salonNumber) {
  const to = e164(salonNumber), from = e164(tenant.phone_number || '');
  if (!to || digits(to).length !== 10) return { ok: false, say: 'Enter the salon number your clients call.' };
  if (!from) return { ok: false, say: 'Lola needs her phone number first (Salon → Phone & texting).' };
  if (digits(to) === digits(from)) return { ok: false, say: 'That’s Lola’s own number — enter the salon number your clients already call.' };
  const startedAt = new Date().toISOString();
  try { await c.from('tenant_channels').upsert({ tenant_id: tenant.id, channel: 'forwarding', account_id: to, username: null, status: 'testing', expires_at: startedAt, updated_at: startedAt }, { onConflict: 'channel,account_id' }); } catch (_) {}
  const candidates = await connectionCandidates(c, process.env.TELNYX_VOICE_APP_ID || null, 'TELNYX_VOICE_APP_ID');
  const state = encodeState({ k: 'fwd_test', t: tenant.id });
  for (const cand of candidates) {
    try {
      const d = telnyxData(await telnyxRequest('/calls', { method: 'POST', timeoutMs: 15000, body: { connection_id: cand.id, to, from, timeout_secs: 45, client_state: state, webhook_url: appUrl() + '/api/call-center/bridge', webhook_url_method: 'POST' } }));
      if (d) return { ok: true, say: 'Calling your salon number now. Don’t pick up — let it ring. If it reaches Lola, forwarding works.', call_control_id: d.call_control_id || null };
    } catch (_) {}
  }
  return { ok: false, say: 'Telnyx wouldn’t place the test call. Say “Lola, run a check”.' };
}

/** Lola's line rang and the caller ID is her own number: that's the forwarding test arriving. */
export async function noteForwardedArrival(c, tenant, from, to) {
  if (!c || !tenant?.id || !from) return false;
  try {
    const { data } = await c.from('tenant_channels').select('account_id,status,expires_at').eq('tenant_id', tenant.id).eq('channel', 'forwarding').eq('status', 'testing');
    // Carriers show either the original caller (Lola's own number) or the forwarding line (the salon number).
    const recent = (data || []).filter((r) => Date.now() - new Date(r.expires_at).getTime() < 5 * 60e3)
      .filter((r) => digits(from) === digits(to || tenant.phone_number) || digits(from) === digits(r.account_id));
    if (!recent.length) return false;
    const now = new Date().toISOString();
    for (const r of recent) await c.from('tenant_channels').update({ status: 'verified', updated_at: now }).eq('tenant_id', tenant.id).eq('channel', 'forwarding').eq('account_id', r.account_id);
    return true;
  } catch (_) { return false; }
}

export async function forwardingStatus(c, tenantId) {
  try { const { data } = await c.from('tenant_channels').select('account_id,status,updated_at').eq('tenant_id', tenantId).eq('channel', 'forwarding'); return data || []; } catch (_) { return []; }
}

/** Bridge step for the test leg: once anyone (Lola, voicemail, or a person) answers, hang up. */
export function forwardTestStep(type, p, st) {
  if (type === 'call.answered' && !st.said) return { id: p.call_control_id, action: 'speak', body: { payload: 'This is a LolaDesk forwarding test. Goodbye!', voice: 'female', language: 'en-US', client_state: encodeState({ ...st, said: 1 }) } };
  if (type === 'call.speak.ended' && st.said) return { id: p.call_control_id, action: 'hangup', body: {} };
  return null;
}
