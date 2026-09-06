// api/speak-lola.js — Lola's canonical dashboard voice
// ════════════════════════════════════════════════════════════════
// HTTP wrapper around the shared voice chain (api/lib/lola-voice-chain.js):
//   1. ElevenLabs — her one canonical voice (the voice the owner created).
//   2. Telnyx TTS — the standalone text-to-speech endpoint on the SAME
//      Telnyx account already wired for calls/SMS. Costs no ElevenLabs
//      credits, so an exhausted ElevenLabs quota no longer mutes her.
// The client (lola-resonance.js) keeps its own browser-speech fallback as
// the final tier; this endpoint failing now means both server voices are
// unavailable, not that Lola never speaks.
//
// X-Lola-Voice response header reports which tier produced the audio:
// 'elevenlabs' | 'telnyx'.
import { synthVoice, whichVoice } from './lib/lola-voice-chain.js';

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

  if (!whichVoice()) {
    return res.status(503).json({ error: 'Lola voice is not configured' });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  req.on?.('close', () => controller.abort());

  try {
    const { audio, contentType, engine } = await synthVoice(text, { signal: controller.signal });
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', String(audio.length));
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('X-Lola-Voice', engine);
    return res.status(200).send(audio);
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
