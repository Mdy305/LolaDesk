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

const TELNYX_TTS_URL = 'https://api.telnyx.com/v2/audio/speech';

function telnyxTtsConfigured() {
  return !!process.env.TELNYX_API_KEY;
}

/** Telnyx standalone TTS (OpenAI-audio-compatible). Returns MP3 Buffer. */
async function telnyxSynthesize(text, { signal } = {}) {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) throw new Error('Missing TELNYX_API_KEY');
  const body = {
    model: process.env.TELNYX_TTS_MODEL || 'tts-1-hd',
    voice: process.env.TELNYX_TTS_VOICE || 'astra',
    input: String(text).slice(0, 2500),
    response_format: 'mp3'
  };
  const r = await fetch(TELNYX_TTS_URL, {
    method: 'POST',
    signal,
    headers: {
      Authorization: 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg'
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    let detail = '';
    try { detail = await r.text(); } catch {}
    throw new Error(`Telnyx TTS ${r.status}: ${detail.slice(0, 300)}`);
  }
  return Buffer.from(await r.arrayBuffer());
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
      const audio = await telnyxSynthesize(text, { signal: controller.signal });
      res.setHeader('Content-Type', 'audio/mpeg');
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
