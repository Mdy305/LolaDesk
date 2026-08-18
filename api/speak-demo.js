/**
 * /api/speak-demo — serve a cached hero demo audio (Supabase Storage backed)
 * GET /api/speak-demo?demo=hero
 *
 * - If demo MP3 already exists in `voice-audio/demo-hero.mp3` return its public URL (JSON {url})
 * - Otherwise synthesize the canonical demo text via ElevenLabs, upload it to Supabase Storage
 *   and return the public URL.
 *
 * Requires: SUPABASE_URL, SUPABASE_SERVICE_KEY, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID
 */

import { db } from './lib/db.js';
import { synthesize } from './lib/elevenlabs.js';

export default async function handler(req, res){
  if(req.method !== 'GET') return res.status(405).end();
  const demo = (req.query?.demo || 'hero').toString();
  // only one demo supported for now
  if(demo !== 'hero') return res.status(400).json({ error: 'unknown demo' });

  const c = db();
  if(!c) return res.status(500).json({ error: 'Supabase not configured' });

  try{
    // Only return the public URL if the object ACTUALLY exists — getPublicUrl
    // just builds a URL string and does not verify the object, so a missing
    // file would hand the caller a 404 link. download() is the real check.
    // The bucket IS `voice-audio`, so the key is just `demo-hero.mp3` — no
    // bucket-name prefix (that would double it to `voice-audio/voice-audio/…`).
    const path = `demo-${demo}.mp3`;
    const { data, error } = await c.storage.from('voice-audio').download(path);
    if(!error && data){
      const { data: getPublic } = c.storage.from('voice-audio').getPublicUrl(path);
      if(getPublic?.publicUrl){
        return res.status(200).json({ url: getPublic.publicUrl });
      }
    }
  }catch(e){ /* continue to synthesize */ }

  try{
    const text = "Hi — I'm Lola, your front desk assistant. I answer calls, book appointments, and follow up with clients in your salon's voice.";
    const buf = await synthesize(text, { outputFormat: 'mp3' });

    // upload to Supabase Storage (bucket: voice-audio)
    const path = `demo-${demo}.mp3`;
    const { error: uploadErr } = await c.storage.from('voice-audio').upload(path, buf, { contentType: 'audio/mpeg', upsert: true });
    if(uploadErr) {
      // If upload fails, fall back to returning bytes directly
      res.setHeader('Content-Type','audio/mpeg');
      return res.status(200).send(buf);
    }

    const { data: publicData } = c.storage.from('voice-audio').getPublicUrl(path);
    return res.status(200).json({ url: publicData.publicUrl });
  }catch(e){
    console.error('speak-demo error', e);
    return res.status(502).json({ error: String(e?.message||e) });
  }
}
