/**
 * api/lib/demo-call.js — "Call my phone": Lola rings you and talks.
 * ════════════════════════════════════════════════════════════════
 * The old demo placed a bare Call Control call with no webhook: the phone
 * either never rang or rang into silence. Now:
 *   1. POST /calls from a LolaDesk number, with webhook_url = the bridge and
 *      client_state {k:'lola_demo'}; every connection is tried until Telnyx
 *      accepts (the Voice API app first).
 *   2. call.answered → ai_assistant_start: Lola herself is on the line.
 *      If Telnyx refuses that, she speaks a short spoken demo instead and
 *      hangs up politely — never silence.
 *   3. Every failure comes back as a plain sentence the page shows/speaks.
 */
import { e164 } from './db.js';
import { telnyxData, telnyxRequest, appUrl } from './telnyx-client.js';
import { connectionCandidates } from './call-callback.js';
import { assistantId } from './assistant-wiring.js';
import { encodeState } from './owner-call.js';

export const DEMO_GREETING = 'Hi, it’s Lola from LolaDesk! This is exactly how I answer your salon’s phone. Just so you know, this call may be recorded, and I’m an AI assistant. Pretend you’re a client — ask me for an appointment, a price, anything.';
export const DEMO_FALLBACK = 'Hi, it’s Lola from LolaDesk. I answer your salon’s phone day and night, book appointments straight into your calendar, text confirmations and reminders, and call back anyone you miss. Start your free trial at loladesk dot com, and I’ll be answering your salon in five minutes. Talk soon!';

async function pickFrom(client) {
  const env = e164(process.env.DEMO_FROM_NUMBER || process.env.TELNYX_FROM_NUMBER || '');
  if (env) return env;
  try { const { data } = await client.from('platform_settings').select('value').eq('key', 'customer_care').maybeSingle(); if (data?.value?.number) return data.value.number; } catch (_) {}
  try { const owned = telnyxData(await telnyxRequest('/phone_numbers', { query: { 'page[size]': 20 }, timeoutMs: 8000 })) || []; if (owned[0]?.phone_number) return owned[0].phone_number; } catch (_) {}
  return null;
}

export async function placeDemoCall(client, phone) {
  const to = e164(phone);
  if (!/^\+1[2-9]\d{2}[2-9]\d{6}$/.test(String(to || ''))) return { ok: false, error: 'us_canada_numbers_only', say: 'I can call US and Canada numbers — what’s your 10-digit number?' };
  if (!process.env.TELNYX_API_KEY) return { ok: false, error: 'telnyx_not_configured', say: 'My phone line isn’t switched on yet, so the LolaDesk team will call you.' };
  const from = await pickFrom(client);
  if (!from) return { ok: false, error: 'no_from_number', say: 'LolaDesk has no phone number to call you from yet.' };
  const candidates = await connectionCandidates(client, process.env.TELNYX_VOICE_APP_ID || null, 'TELNYX_VOICE_APP_ID');
  const state = encodeState({ k: 'lola_demo', a: assistantId() || '' });
  let data = null; const tried = [];
  for (const c of candidates) {
    try {
      data = telnyxData(await telnyxRequest('/calls', { method: 'POST', timeoutMs: 15000, body: {
        connection_id: c.id, to, from, timeout_secs: 35, client_state: state,
        webhook_url: appUrl() + '/api/call-center/bridge', webhook_url_method: 'POST',
      } }));
      if (data) break;
    } catch (e) { tried.push(`${c.note}: ${String(e?.message || e).slice(0, 120)}`); }
  }
  if (!data) return { ok: false, error: 'telnyx_rejected', tried, say: 'Telnyx wouldn’t place the call. The LolaDesk team has your number and will call you.' };
  return { ok: true, call_control_id: data.call_control_id || null, from, to, say: 'Calling you now — pick up and talk to me.' };
}

/** Bridge step for demo calls (pure). */
export function demoStep(type, p, st) {
  if (type === 'call.answered' && !st.started) {
    if (st.a) return { id: p.call_control_id, action: 'ai_assistant_start', body: { assistant: { id: st.a }, greeting: DEMO_GREETING, client_state: encodeState({ ...st, started: 1 }) },
      fallback: { action: 'speak', body: { payload: DEMO_FALLBACK, voice: 'female', language: 'en-US', client_state: encodeState({ ...st, started: 1, spoke: 1 }) } } };
    return { id: p.call_control_id, action: 'speak', body: { payload: DEMO_FALLBACK, voice: 'female', language: 'en-US', client_state: encodeState({ ...st, started: 1, spoke: 1 }) } };
  }
  if (type === 'call.speak.ended' && st.spoke) return { id: p.call_control_id, action: 'hangup', body: {} };
  return null;
}
