/**
 * api/lib/elevenlabs.js — Shared ElevenLabs TTS client
 * ════════════════════════════════════════════════════════════════
 * One implementation, used everywhere Lola needs to speak in her real
 * voice: the dashboard's /api/speak AND real phone calls via Telnyx.
 *
 * This is the file that makes "Lola sounds the same everywhere" true.
 * If you ever change her voice settings, change them here once.
 *
 * ENV VARS:
 *   ELEVENLABS_API_KEY    required
 *   ELEVENLABS_VOICE_ID   Lola's one canonical voice (required for calls)
 *   ELEVENLABS_MODEL      optional, defaults to eleven_turbo_v2_5 (low latency)
 */

const ELEVEN_TTS = 'https://api.elevenlabs.io/v1/text-to-speech';

// Lola's canonical voice settings. Keep these identical across every
// surface (dashboard chat, phone calls, SMS-to-voice previews, etc.)
// so she is recognizably "the same Lola" everywhere — this is the
// whole point of the brand-consistency goal.
export const LOLA_VOICE_SETTINGS = {
  stability: 0.45,
  similarity_boost: 0.8,
  style: 0.3,
  use_speaker_boost: true
};

export function isConfigured(){
  return !!(process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID);
}

/**
 * Synthesize text to speech. Returns a Buffer of MP3 bytes, or throws.
 * Use a small `modelId` override for latency-sensitive call turns if
 * you ever add a faster ElevenLabs model — defaults to turbo already.
 */
export async function synthesize(text, { voiceId, modelId } = {}){
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voice = voiceId || process.env.ELEVENLABS_VOICE_ID;
  if(!apiKey) throw new Error('Missing ELEVENLABS_API_KEY');
  if(!voice) throw new Error('Missing ELEVENLABS_VOICE_ID');

  const r = await fetch(`${ELEVEN_TTS}/${voice}`, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg'
    },
    body: JSON.stringify({
      text: String(text).slice(0, 2500),
      model_id: modelId || process.env.ELEVENLABS_MODEL || 'eleven_turbo_v2_5',
      voice_settings: LOLA_VOICE_SETTINGS
    })
  });

  if(!r.ok){
    let detail = '';
    try{ detail = await r.text(); }catch{}
    throw new Error(`ElevenLabs ${r.status}: ${detail.slice(0,300)}`);
  }
  return Buffer.from(await r.arrayBuffer());
}
