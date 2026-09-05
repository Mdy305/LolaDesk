// api/speak-lola.js — Lola's canonical dashboard voice
// ════════════════════════════════════════════════════════════════
// Two server-side tiers so Lola is never silent:
//   1. ElevenLabs — her one canonical voice (the voice the owner created).
//   2. Telnyx TTS — the standalone /v2/audio/speech endpoint on the SAME
//      Telnyx account already wired for calls/SMS. Costs no ElevenLabs
//      credits, so an exhausted ElevenLabs quota no longer mutes her.
// The client (lola-resonance.js) keeps its own browser-speech fallback as
// the final tier; this endpoint failing now means both server voices are
// unavailable, not that Lola never speaks.
//
// X-Lola-Voice response header reports which tier produced the audio:
// 'elevenlabs' | 'telnyx'.
import { synthesize as elevenSynthesize, isConfigured as elevenConfigured } from './lib/elevenlabs.js';

const TELNYX_TTS_URL = 'https://api.telnyx.com/v2/text-to-speech/speech';
const TELNYX_VOICES_URL = 'https://api.telnyx.com/v2/text-to-speech/voices';

function telnyxTtsConfigured() {
  return !!process.env.TELNYX_API_KEY;
}

/**
 * Telnyx standalone TTS. Returns { audio: Buffer, contentType }.
 * Self-healing voice: if the configured/default voice id is rejected, we
 * ask Telnyx for its valid voice list once and retry with a real English
 * voice — the id is then cached for the life of the lambda instance.
 */
let cachedTelnyxVoice = null;

async function pickTelnyxVoice(apiKey, signal) {
  if (cachedTelnyxVoice) return cachedTelnyxVoice;
  const r = await fetch(TELNYX_VOICES_URL + '?provider=telnyx', {
    signal,
    headers: { Authorization: 'Bearer ' + apiKey, Accept: 'application/json' }
  });
  if (!r.ok) return null;
  const data = await r.json().catch(() => null);
  const voices = Array.isArray(data?.voices) ? data.voices : [];
  const english = voices.filter(v => /^en/i.test(String(v.language || 'en')));
  const pick = english.find(v => /clara|female|woman/i.test(String(v.name || v.voice_id || '')))
    || english[0] || voices[0];
  if (!pick?.voice_id) return null;
  cachedTelnyxVoice = pick.voice_id;
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

async function telnyxSynthesize(text, { signal } = {}) {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) throw new Error('Missing TELNYX_API_KEY');
  const primary = process.env.TELNYX_TTS_VOICE || 'Telnyx.Ultra.Clara';
  try {
    return await telnyxPost(text, primary, apiKey, signal);
  } catch (e) {
    if (e.name === 'AbortError' || ![400, 404, 422, 500].includes(e.status)) throw e;
    // Voice id rejected / provider hiccup — resolve a real voice and retry once.
    const resolved = await pickTelnyxVoice(apiKey, signal).catch(() => null);
    if (!resolved || resolved === primary) throw e;
    return telnyxPost(text, resolved, apiKey, signal);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const text = String(req.body?.text || '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_#`>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) return res.status(400).json({ error: 'Text is required' });
  if (text.length > 2500) return res.status(413).json({ error: 'Text is too long' });

  if (!elevenConfigured() && !telnyxTtsConfigured()) {
    return res.status(503).json({ error: 'Lola voice is not configured' });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  req.on?.('close', () => controller.abort());

  let elevenReason = '';
  try {
    if (elevenConfigured()) {
      try {
        const audio = await elevenSynthesize(text, {
          modelId: process.env.ELEVENLABS_MODEL || 'eleven_turbo_v2_5',
          outputFormat: 'mp3_44100_128',
          signal: controller.signal
        });
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Content-Length', String(audio.length));
        res.setHeader('Cache-Control', 'private, no-store, max-age=0');
        res.setHeader('X-Lola-Voice', 'elevenlabs');
        return res.status(200).send(audio);
      } catch (error) {
        if (error?.name === 'AbortError') throw error; // client gone / timed out — no tier 2
        elevenReason = String(error?.message || error).slice(0, 220);
        console.error('[SPEAK-LOLA] elevenlabs tier failed, falling back to telnyx:', elevenReason);
      }
    }

    if (telnyxTtsConfigured()) {
      const { audio, contentType } = await telnyxSynthesize(text, { signal: controller.signal });
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', String(audio.length));
      res.setHeader('Cache-Control', 'private, no-store, max-age=0');
      res.setHeader('X-Lola-Voice', 'telnyx');
      return res.status(200).send(audio);
    }

    // Nothing else to try — surface the sanitized ElevenLabs reason (status
    // + short body, never the key) so the cause stays visible to the operator.
    console.error('[SPEAK-LOLA] no voice tier available:', elevenReason || 'elevenlabs not configured');
    return res.status(502).json({
      error: 'Lola voice provider failed' + (elevenReason ? ': ' + elevenReason : ''),
      voice: 'elevenlabs'
    });
  } catch (error) {
    const aborted = error?.name === 'AbortError';
    console.error('[SPEAK-LOLA]', aborted ? 'timeout-or-client-abort' : error);
    if (res.headersSent) return;
    const reason = aborted
      ? 'Lola voice timed out'
      : 'Lola voice provider failed' + (error?.message ? ': ' + String(error.message).slice(0, 220) : '');
    return res.status(aborted ? 504 : 502).json({ error: reason, voice: 'elevenlabs' });
  } finally {
    clearTimeout(timeout);
  }
}
