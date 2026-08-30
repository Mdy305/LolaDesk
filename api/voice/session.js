/**
 * /api/voice/session — Lola's DIRECT voice session (the Jarvis path)
 * ════════════════════════════════════════════════════════════════
 * ONE round trip for the browser orb: the wake-word / tap-to-talk
 * transcript goes in, and Lola's answer text PLUS her canonical
 * ElevenLabs voice audio come back together.
 *
 * It is deliberately TELEPHONY-INDEPENDENT. There is no
 * call_control_id, no Telnyx webhook, no calls-table lookup — a
 * salon with zero phone calls today gets the exact same instant,
 * fully capable Lola as one with a ringing line. The front-end audio
 * trigger (orb / wake word / ⌘Space) never waits on telephony state.
 *
 * Body: { text, messages?, system?, max_tokens?, temperature? }
 * Response: { ok, reply, engine, audio?, intent?, source?, ... }
 *   - engine 'elevenlabs' → audio is base64 MP3 of Lola's official voice
 *   - engine 'text'       → voice provider unavailable; reply is still
 *                           returned so the orb renders it (no fake voice)
 */

import { getUserFromToken, bearer } from '../lib/auth.js';
import { resolveTenantForUser } from '../lib/tenant-access.js';
import { dashboardBrainReply } from '../lib/dashboard-brain.js';
import { synthesize, isConfigured } from '../lib/elevenlabs.js';

function extractReply(json){
  if(!json) return '';
  const content = json.content;
  if(Array.isArray(content)) return content.map(x => (x && (x.text || x.content)) || '').join(' ').trim();
  if(typeof content === 'string') return content.trim();
  if(typeof json.reply === 'string') return json.reply.trim();
  if(typeof json.message === 'string') return json.message.trim();
  return '';
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');

  if(req.method === 'OPTIONS') return res.status(200).end();
  if(req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try{
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const text = String(body.text || '').trim();
    if(!text) return res.status(400).json({ error: 'A message is required' });

    // Owner-scoped, same gate as /api/lola.
    let tenant = null;
    try{
      const user = await getUserFromToken(bearer(req));
      if(user) tenant = await resolveTenantForUser(user);
    }catch{}
    if(!tenant?.id) return res.status(401).json({ error: 'Not authenticated' });

    const extra = Array.isArray(body.messages) ? body.messages : [];
    const brainBody = {
      messages: [{ role: 'user', content: text }, ...extra],
      system: body.system,
      channel: 'dashboard_voice',
      max_tokens: body.max_tokens,
      temperature: body.temperature
    };

    const out = await dashboardBrainReply({ tenant, body: brainBody });
    const reply = extractReply(out.json);

    // Brain degraded (upstream error with no deterministic fallback) → let
    // the orb fall back to its local instant brain; never fake a success.
    if(!reply && out.status >= 400){
      return res.status(out.status).json(out.json);
    }

    const voice = { engine: 'text', audio: null };
    if(reply && isConfigured()){
      try{
        const audio = await synthesize(reply, {
          modelId: process.env.ELEVENLABS_MODEL || 'eleven_turbo_v2_5',
          outputFormat: 'mp3_44100_128'
        });
        if(audio && audio.length){
          voice.engine = 'elevenlabs';
          voice.audio = audio.toString('base64');
          voice.mime = 'audio/mpeg';
        }
      }catch(e){
        console.error('[VOICE-SESSION] synthesis failed — replying as text only:', e?.message || e);
      }
    }

    return res.status(200).json({
      ok: true,
      reply,
      engine: voice.engine,
      audio: voice.audio,
      mime: voice.mime || null,
      intent: out.json?.intent || null,
      source: out.json?.source || null,
      booked: out.json?.booked !== undefined ? !!out.json.booked : undefined,
      degraded: out.status !== 200,
      model: out.json?.model || null,
      provider: out.json?.provider || null
    });
  }catch(e){
    return res.status(500).json({ type:'error', error:{ type:'server_error', message: String(e) } });
  }
}
