/**
 * /api/speak — Text to speech via ElevenLabs (Lola's custom voice)
 * ════════════════════════════════════════════════════════════════
 * Powers in-app voice Lola (dashboard chat). Takes text, returns MP3
 * audio in her custom ElevenLabs voice — the SAME voice and settings
 * used on real phone calls (see api/telnyx-voice.js + api/lib/elevenlabs.js),
 * so Lola sounds identical everywhere a client encounters her.
 *
 * ENV VARS:
 *   ELEVENLABS_API_KEY   (required)
 *   ELEVENLABS_VOICE_ID  (Lola's one canonical voice id)
 *
 * POST { text: "..." }  →  audio/mpeg bytes (always Lola's one canonical voice)
 */

import { synthesize } from './lib/elevenlabs.js';

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method === 'OPTIONS') return res.status(200).end();
  if(req.method !== 'POST') return res.status(405).json({ error:'POST only' });

  try{
    const body = typeof req.body === 'string' ? JSON.parse(req.body||'{}') : (req.body||{});
    const text = (body.text||'').toString().slice(0, 2500);
    if(!text) return res.status(400).json({ error:'text required' });

    const buf = await synthesize(text);
    res.setHeader('Content-Type','audio/mpeg');
    res.setHeader('Content-Length', buf.length);
    return res.status(200).send(buf);
  }catch(e){
    const msg = String(e&&e.message||e);
    const status = /Missing ELEVENLABS/i.test(msg) ? 500 : 502;
    return res.status(status).json({ error: msg });
  }
}
