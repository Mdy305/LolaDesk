/**
 * /api/voice-audio — Serves cached ElevenLabs audio for Telnyx <Play>
 * ════════════════════════════════════════════════════════════════
 * GET /api/voice-audio?id=<id>  →  audio/mpeg bytes
 *
 * telnyx-voice.js synthesizes Lola's reply via ElevenLabs, stashes the
 * bytes in tts-cache.js, and points Telnyx's <Play> verb at this URL.
 * Telnyx fetches it within ~1-2 seconds of receiving the TeXML.
 *
 * If the id isn't found (cold start race, wrong instance, expired),
 * we return 404 — telnyx-voice.js always has a <Say> fallback in the
 * same TeXML response so a caller never hears dead air either way.
 */

import { takeAudio } from './lib/tts-cache.js';

export default async function handler(req, res){
  if(req.method !== 'GET') return res.status(405).end();
  const url = new URL(req.url, 'http://x');
  const id = url.searchParams.get('id');
  if(!id) return res.status(400).end();

  const buf = takeAudio(id);
  if(!buf) return res.status(404).end();

  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Content-Length', buf.length);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(buf);
}
