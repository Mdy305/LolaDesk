/**
 * api/lib/lola-voice-chain.js — ONE voice chain for every Lola surface.
 * ═══════════════════════════════════════════════════════════════════
 *   1. ElevenLabs  — Lola's one canonical voice (the owner's voice).
 *   2. Telnyx TTS  — the standalone /v2/text-to-speech/speech endpoint on
 *      the SAME Telnyx account already wired for calls/SMS. Costs no
 *      ElevenLabs credits, so an exhausted ElevenLabs quota degrades to
 *      Telnyx audio instead of silence.
 *
 * Consumers:
 *   • api/speak-lola.js          — dashboard text replies (HTTP audio)
 *   • api/voice/session-ws.js    — the orb's tier-1 streaming path
 *
 * `whichVoice()` answers "is any server voice available" without
 * synthesizing; `synthVoice()` runs the chain and returns
 * { audio, contentType, engine: 'elevenlabs' | 'telnyx' } or throws.
 * AbortError always propagates — a cancelled turn must never fall through
 * to the next tier.
 */
import { synthesize as elevenSynthesize, isConfigured as elevenConfigured } from './elevenlabs.js';

const TELNYX_TTS_URL = 'https://api.telnyx.com/v2/text-to-speech/speech';
const TELNYX_VOICES_URL = 'https://api.telnyx.com/v2/text-to-speech/voices';

export function telnyxTtsConfigured() {
  return !!process.env.TELNYX_API_KEY;
}

export function whichVoice() {
  if (elevenConfigured()) return 'elevenlabs';
  if (telnyxTtsConfigured()) return 'telnyx';
  return null;
}

/* ── Telnyx tier ──────────────────────────────────────────────────── */

let cachedTelnyxVoice = null;
let cachedTelnyxVoiceEmpty = false;

function extractVoices(data) {
  if (Array.isArray(data?.voices)) return data.voices;
  if (Array.isArray(data?.data)) return data.data; // some list endpoints wrap in data
  return [];
}

async function listVoicesOnce(apiKey, providerFilter, signal) {
  const url = TELNYX_VOICES_URL + (providerFilter ? '?provider=' + providerFilter : '');
  const r = await fetch(url, {
    signal,
    headers: { Authorization: 'Bearer ' + apiKey, Accept: 'application/json' }
  });
  if (!r.ok) {
    let detail = '';
    try { detail = await r.text(); } catch {}
    const err = new Error(`Telnyx voices list${providerFilter ? ' (' + providerFilter + ')' : ''} ${r.status}: ${detail.slice(0, 200)}`);
    err.status = r.status;
    throw err;
  }
  const data = await r.json().catch(() => null);
  return extractVoices(data);
}

async function pickTelnyxVoice(apiKey, signal) {
  if (cachedTelnyxVoice) return cachedTelnyxVoice;
  if (cachedTelnyxVoiceEmpty) return null;
  // Prefer the Telnyx provider, but any provider on the account works —
  // AWS/Azure/Minimax voices are on the same key.
  let voices = [];
  try {
    voices = await listVoicesOnce(apiKey, 'telnyx', signal);
  } catch (e) {
    if (![404, 400].includes(e.status)) throw e;
  }
  if (!voices.length) {
    try {
      voices = await listVoicesOnce(apiKey, '', signal);
    } catch (e) {
      e.message = '[telnyx filter empty; all-provider list failed] ' + e.message;
      throw e;
    }
  }
  if (!voices.length) {
    cachedTelnyxVoiceEmpty = true; // account has zero TTS voices — don't re-ask every request
    return null;
  }
  const english = voices.filter(v => /^en/i.test(String(v.language || 'en-US')));
  const pool = english.length ? english : voices;
  const pick = pool.find(v => /clara|female|woman|amy|joanna|salli|nova|heart|bella|sky|sarah|kore|astra/i.test(String(v.name || v.voice_id || '')))
    || pool[0];
  const raw = pick?.voice_id || pick?.name || '';
  if (!raw) return null;
  // Normalize to Provider.Model.VoiceId. The list sometimes returns bare
  // model-internal ids (e.g. af_nova); those are KokoroTTS voices.
  if (String(raw).includes('.')) cachedTelnyxVoice = String(raw);
  else if (pick?.provider && pick?.model) cachedTelnyxVoice = `${pick.provider}.${pick.model}.${raw}`;
  else if (/^a[fm]_/.test(String(raw))) cachedTelnyxVoice = `Telnyx.KokoroTTS.${raw}`;
  else cachedTelnyxVoice = `Telnyx.NaturalHD.${raw}`;
  return cachedTelnyxVoice;
}

async function telnyxPost(text, voice, apiKey, signal) {
  const r = await fetch(TELNYX_TTS_URL, {
    method: 'POST',
    signal,
    headers: {
      Authorization: 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg'
    },
    body: JSON.stringify({ text: String(text).slice(0, 2500), voice, output_type: 'binary_output' })
  });
  if (!r.ok) {
    let detail = '';
    try { detail = await r.text(); } catch {}
    const err = new Error(`Telnyx TTS ${r.status}: ${detail.slice(0, 300)}`);
    err.status = r.status;
    throw err;
  }
  return { audio: Buffer.from(await r.arrayBuffer()), contentType: (r.headers && r.headers.get && r.headers.get('content-type')) || 'audio/mpeg' };
}

export async function telnyxSynthesize(text, { signal } = {}) {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) throw new Error('Missing TELNYX_API_KEY');
  // Voice ids MUST be Provider.Model.VoiceId (e.g. Telnyx.NaturalHD.astra,
  // Telnyx.KokoroTTS.af_nova). A bare or nonexistent id makes Telnyx
  // return 500, not a clean 4xx.
  const primary = process.env.TELNYX_TTS_VOICE || 'Telnyx.NaturalHD.astra';
  try {
    return await telnyxPost(text, primary, apiKey, signal);
  } catch (e) {
    if (e.name === 'AbortError' || ![400, 404, 422, 500].includes(e.status)) throw e;
    // Voice id rejected / provider hiccup — resolve a real voice and retry once.
    let resolved = '';
    try {
      resolved = (await pickTelnyxVoice(apiKey, signal)) || '';
    } catch (listErr) {
      listErr.message = `[voice=${primary}; voices-list failed] ` + listErr.message;
      throw listErr;
    }
    if (!resolved || resolved === primary) {
      e.message = cachedTelnyxVoiceEmpty
        ? `[voice=${primary}; account has zero TTS voices listed] ` + e.message
        : `[voice=${primary}; no alternative resolved] ` + e.message;
      throw e;
    }
    try {
      return await telnyxPost(text, resolved, apiKey, signal);
    } catch (retryErr) {
      retryErr.message = `[voice=${primary}->${resolved}] ` + retryErr.message;
      throw retryErr;
    }
  }
}

/* ── The chain ────────────────────────────────────────────────────── */

/**
 * Run the ElevenLabs → Telnyx chain. Returns
 * { audio: Buffer, contentType: string, engine: 'elevenlabs'|'telnyx' }.
 * Throws when no tier is configured or every configured tier fails.
 * Test seams: `eleven` / `telnyx` override the tier implementations.
 */
export async function synthVoice(text, { signal, eleven = elevenSynthesize, telnyx = telnyxSynthesize } = {}) {
  if (elevenConfigured()) {
    try {
      const audio = await eleven(text, {
        modelId: process.env.ELEVENLABS_MODEL || 'eleven_turbo_v2_5',
        outputFormat: 'mp3_44100_128',
        signal
      });
      if (audio && audio.length) return { audio, contentType: 'audio/mpeg', engine: 'elevenlabs' };
    } catch (error) {
      if (error?.name === 'AbortError') throw error; // client gone / turn cancelled — no tier 2
      console.error('[lola-voice-chain] elevenlabs tier failed, falling back to telnyx:', String(error?.message || error).slice(0, 220));
    }
  }
  if (telnyxTtsConfigured()) {
    const { audio, contentType } = await telnyx(text, { signal });
    return { audio, contentType, engine: 'telnyx' };
  }
  throw new Error('no voice tier available' + (elevenConfigured() ? '' : ' (elevenlabs not configured)'));
}
