/**
 * api/lib/one-voice.js — Lola has ONE voice: the valet-girl Lola the owner created in ElevenLabs.
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * The app speaks it through /api/speak-lola (lib/elevenlabs.js). The phone speaks it through
 * Telnyx: every Telnyx AI assistant on the account (the salon Lola, the support Lola, any
 * per-salon assistant) is set to  ElevenLabs.<model>.<ELEVENLABS_VOICE_ID>  with the ElevenLabs
 * key linked as a Telnyx integration secret (api_key_ref). The "Call me" demo's first sentence
 * uses the same voice. Nothing ever falls back to a different-sounding voice.
 *
 * The secret's identifier carries a short fingerprint of the key, so rotating the ElevenLabs key
 * in Vercel links the new one automatically (the key itself is never logged or returned).
 *   LOLA_PHONE_ELEVEN_MODEL   optional, defaults to eleven_multilingual_v2 (Telnyx's documented model)
 *   VOICE_PROVIDER=telnyx     the owner chose Telnyx: her ONE voice is then the Telnyx voice (LOLA_TELNYX_VOICE,
 *                             default Telnyx.Ultra.Clara) — the app, every assistant and the calls we place.
 */
import crypto from 'node:crypto';
import { telnyxRequest, telnyxData, appUrl } from './telnyx-client.js';
import { telnyxVoiceMode } from './voice-mode.js';
import { telnyxVoice, resolveTelnyxVoice, markBadVoice } from './elevenlabs.js';
/** In Telnyx mode, make sure the voice is one Telnyx really has before it is set anywhere. */
export async function readyVoice(){ if (telnyxVoiceMode() && process.env.TELNYX_API_KEY) { try { await resolveTelnyxVoice(); } catch (_) {} } }
const telnyxMode = () => telnyxVoiceMode();

// ── Calls we place (demo, owner bridge, forwarding test): Telnyx plays HER voice, rendered by
// /api/speak-lola (the same ElevenLabs voice as the app). Signed, so Telnyx's fetch is never
// rate-limited as an anonymous visitor and nobody can use the link to voice other text.
// Same key as before whenever TELNYX_API_KEY / SUPABASE_SERVICE_KEY is set; no hard-coded last resort.
const voiceRoot = () => String(process.env.TELNYX_API_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '');
const voiceKey = () => voiceRoot() + ':lola-voice';
export const signText = (text) => crypto.createHmac('sha256', voiceKey()).update(String(text)).digest('base64url').slice(0, 22);
export const checkTextSig = (text, sig) => {
  if (!sig || !voiceRoot()) return false;
  const a = Buffer.from(String(sig)), b = Buffer.from(signText(text));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
export const voiceUrl = (text) => `${appUrl()}/api/speak-lola?text=${encodeURIComponent(text)}&sig=${signText(text)}`;
/** Telnyx events that mean "she finished saying it". */
export const saidEnded = (type) => type === 'call.playback.ended' || type === 'call.speak.ended';

const voiceId = () => String(process.env.ELEVENLABS_VOICE_ID || process.env.LOLA_VOICE_ID || '').trim();
export const phoneModel = () => process.env.LOLA_PHONE_ELEVEN_MODEL || 'eleven_multilingual_v2';

/** Her phone voice id for Telnyx, or null when it can't be set (no ElevenLabs key / voice, or opted out). */
export function lolaPhoneVoice() {
  if (telnyxMode()) return process.env.TELNYX_API_KEY ? telnyxVoice() : null;
  if (!process.env.ELEVENLABS_API_KEY || !voiceId()) return null;
  return `ElevenLabs.${phoneModel()}.${voiceId()}`;
}

export function secretIdentifier() {
  const k = String(process.env.ELEVENLABS_API_KEY || '');
  return 'loladesk_elevenlabs_' + crypto.createHash('sha256').update(k).digest('hex').slice(0, 8);
}

let linked = null;
/** Make sure Telnyx holds the ElevenLabs key as an integration secret; returns its identifier. */
export async function ensureElevenSecret() {
  const ident = secretIdentifier();
  if (linked === ident) return ident;
  let list = [];
  try { list = telnyxData(await telnyxRequest('/integration_secrets', { query: { 'page[size]': 250 }, timeoutMs: 8000 })) || []; } catch (_) {}
  if (!(Array.isArray(list) ? list : []).some((s) => s && s.identifier === ident)) {
    try {
      await telnyxRequest('/integration_secrets', { method: 'POST', timeoutMs: 10000, body: { identifier: ident, type: 'bearer', token: process.env.ELEVENLABS_API_KEY } });
    } catch (e) {
      if (!/already|exist|taken|unique|duplicate/i.test(String(e?.message || ''))) throw new Error('Telnyx wouldn’t store the ElevenLabs key: ' + String(e?.message || e).slice(0, 140));
    }
  }
  linked = ident;
  return ident;
}

/** Is this assistant speaking with Lola's one voice? */
export function voiceIsLola(vs) {
  if (telnyxMode()) return String(vs?.voice || '') === telnyxVoice();
  const want = voiceId();
  const v = String(vs?.voice || '');
  return !!want && /^ElevenLabs\./i.test(v) && v.split('.').pop() === want && !!vs?.api_key_ref;
}

/** voice_settings that make an assistant sound like Lola (keeps its other settings). */
export async function lolaVoiceSettings(current = {}) {
  await readyVoice();
  const voice = lolaPhoneVoice();
  if (!voice) return null;
  if (telnyxMode()) { const { api_key_ref, ...rest } = (current && typeof current === 'object') ? current : {}; return { ...rest, voice }; }
  return { ...(current && typeof current === 'object' ? current : {}), voice, api_key_ref: await ensureElevenSecret() };
}

/** Speak-command fields for Call Control (the demo call's first sentence). */
export async function lolaSpeakVoice() {
  await readyVoice();
  const voice = lolaPhoneVoice();
  if (!voice) return null;
  if (telnyxMode()) return { voice };
  try { return { voice, voice_settings: { type: 'elevenlabs', api_key_ref: await ensureElevenSecret() } }; } catch (_) { return null; }
}

/**
 * Every assistant on the account → Lola's voice. Returns counts and plain errors (never the key).
 * heal:false only reports.
 */
export async function unifyAssistantVoices({ heal = false } = {}) {
  await readyVoice();
  const out = { possible: !!lolaPhoneVoice(), total: 0, lola: 0, fixed: [], others: [], errors: [] };
  let list = [];
  try { list = telnyxData(await telnyxRequest('/ai/assistants', { query: { 'page[size]': 100 }, timeoutMs: 9000 })) || []; }
  catch (e) { out.errors.push('Couldn’t read the assistants: ' + String(e?.message || e).slice(0, 120)); return out; }
  list = Array.isArray(list) ? list : [];
  out.total = list.length;
  for (const a of list) {
    if (voiceIsLola(a.voice_settings)) { out.lola++; continue; }
    const was = String(a?.voice_settings?.voice || 'none');
    if (!heal || !out.possible) { out.others.push({ name: a.name || 'assistant', voice: was }); continue; }
    try {
      let vs = await lolaVoiceSettings(a.voice_settings);
      const { updateAssistant } = await import('./assistant-wiring.js');
      // Telnyx doesn't have that voice for assistants: drop it and use the next real one (up to 3 tries).
      for (let attempt = 0; ; attempt++) {
        try { await updateAssistant(a.id, { voice_settings: vs }); break; }
        catch (e) {
          if (attempt >= 3 || !/not found|invalid|valid/i.test(String(e?.message || '')) || !telnyxVoiceMode()) throw e;
          markBadVoice(vs.voice); await resolveTelnyxVoice({ force: true });
          vs = await lolaVoiceSettings(a.voice_settings);
        }
      }
      out.fixed.push({ name: a.name || 'assistant', from: was });
      out.lola++;
    } catch (e) {
      out.others.push({ name: a.name || 'assistant', voice: was });
      out.errors.push(`${a.name || 'assistant'}: ${String(e?.message || e).slice(0, 140)}`);
    }
  }
  return out;
}
