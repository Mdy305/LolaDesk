/**
 * /api/speak — Text to speech via ElevenLabs (Lola's custom voice)
 * ════════════════════════════════════════════════════════════════
 * Powers in-app voice Lola. Takes text, returns MP3 audio in her
 * custom ElevenLabs voice. The browser plays it back.
 *
 * ENV VARS:
 *   ELEVENLABS_API_KEY   (required)
 *   ELEVENLABS_VOICE_ID  (your custom Lola voice id; can be overridden per-request)
 *
 * POST { text: "...", voiceId?: "..." }  →  audio/mpeg bytes
 */

const ELEVEN_TTS = 'https://api.elevenlabs.io/v1/text-to-speech';

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

    const apiKey = process.env.ELEVENLABS_API_KEY;
    const voiceId = body.voiceId || process.env.ELEVENLABS_VOICE_ID;
    if(!apiKey)  return res.status(500).json({ error:'Missing ELEVENLABS_API_KEY' });
    if(!voiceId) return res.status(500).json({ error:'Missing ELEVENLABS_VOICE_ID' });

    const r = await fetch(`${ELEVEN_TTS}/${voiceId}`, {
      method:'POST',
      headers:{
        'xi-api-key': apiKey,
        'Content-Type':'application/json',
        'Accept':'audio/mpeg'
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_turbo_v2_5',     // fast, natural — good for interactive
        voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.3, use_speaker_boost: true }
      })
    });

    if(!r.ok){
      let detail = '';
      try{ detail = await r.text(); }catch{}
      return res.status(502).json({ error:'ElevenLabs error', status:r.status, detail: detail.slice(0,300) });
    }

    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader('Content-Type','audio/mpeg');
    res.setHeader('Content-Length', buf.length);
    return res.status(200).send(buf);
  }catch(e){
    return res.status(500).json({ error:String(e&&e.message||e) });
  }
}
