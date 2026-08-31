// api/speak-lola.js — Lola's canonical dashboard voice
import { synthesize, isConfigured } from './lib/elevenlabs.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  if (!isConfigured()) {
    return res.status(503).json({ error: 'Lola voice is not configured' });
  }

  const text = String(req.body?.text || '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_#`>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) return res.status(400).json({ error: 'Text is required' });
  if (text.length > 2500) return res.status(413).json({ error: 'Text is too long' });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  req.on?.('close', () => controller.abort());

  try {
    const audio = await synthesize(text, {
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
    const aborted = error?.name === 'AbortError';
    console.error('[SPEAK-LOLA]', aborted ? 'timeout-or-client-abort' : error);
    if (res.headersSent) return;
    // Surface the sanitized provider reason (status + short body, never the
    // key) so the exact cause — out of credit vs bad voice ID — is visible
    // to the operator instead of an opaque 502.
    const reason = aborted
      ? 'Lola voice timed out'
      : 'Lola voice provider failed' + (error?.message ? ': ' + String(error.message).slice(0, 220) : '');
    return res.status(aborted ? 504 : 502).json({ error: reason, voice: 'elevenlabs' });
  } finally {
    clearTimeout(timeout);
  }
}