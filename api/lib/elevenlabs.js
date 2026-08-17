/**
 * api/lib/elevenlabs.js — Shared ElevenLabs TTS client
 * ════════════════════════════════════════════════════════════════
 * One implementation, used everywhere Lola needs to speak in her real
 * voice: the dashboard's /api/speak AND real phone calls via Telnyx.
 *
 * Lola is the brain of LolaDesk — one identity, ONE voice, across the
 * entire platform. Like Siri on Apple, she is NOT configurable per tenant
 * and her voice is NOT modified by this OS: every salon, every call, every
 * channel hears the exact voice the owner created in ElevenLabs.
 *
 * CRITICAL: synthesize() sends NO `voice_settings` override. ElevenLabs
 * then uses the voice's own saved settings — the voice *exactly as it was
 * created*. The OS must not reshape stability/style/similarity or apply
 * per-message "registers", because that would make Lola sound like a
 * modified version of the voice, not the voice itself.
 *
 * ENV VARS:
 *   ELEVENLABS_API_KEY    required
 *   ELEVENLABS_VOICE_ID   Lola's one canonical voice (required for calls)
 *   ELEVENLABS_MODEL      optional, defaults to eleven_turbo_v2_5 (low latency)
 */

const ELEVEN_TTS = 'https://api.elevenlabs.io/v1/text-to-speech';

export function isConfigured(){
  return !!(process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID);
}

/**
 * Synthesize text to speech. Returns a Buffer of MP3 bytes, or throws.
 * ALWAYS uses Lola's one canonical voice (ELEVENLABS_VOICE_ID) — the
 * `voice` option is deliberately ignored so no code path can ever give
 * a tenant its own Lola. And NO `voice_settings` is sent, so the voice
 * renders exactly as the owner created it. One brain, one voice,
 * everywhere.
 */
export async function synthesize(text, { modelId, outputFormat, signal } = {}) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  // Lola's canonical voice — always. There is no per-tenant voice.
  const voice = process.env.ELEVENLABS_VOICE_ID;
  if(!apiKey) throw new Error('Missing ELEVENLABS_API_KEY');
  if(!voice) throw new Error('Missing ELEVENLABS_VOICE_ID');

  const url = outputFormat ? `${ELEVEN_TTS}/${voice}?output_format=${outputFormat}` : `${ELEVEN_TTS}/${voice}`;

  const r = await fetch(url, {
    method: 'POST',
    signal,
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg'
    },
    body: JSON.stringify({
      text: String(text).slice(0, 2500),
      model_id: modelId || process.env.ELEVENLABS_MODEL || 'eleven_turbo_v2_5'
      // NOTE: no voice_settings — Lola speaks in the voice exactly as
      // created, with its own saved settings. The OS never modifies it.
    })
  });

  if(!r.ok){
    let detail = '';
    try{ detail = await r.text(); }catch{}
    throw new Error(`ElevenLabs ${r.status}: ${detail.slice(0,300)}`);
  }
  return Buffer.from(await r.arrayBuffer());
}

/**
 * List the voices available on this ElevenLabs account, so the Settings
 * page can render a real voice picker (id + name). Returns a small, safe
 * subset of fields — never the full provider payload.
 */
export async function listVoices(){
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if(!apiKey) throw new Error('Missing ELEVENLABS_API_KEY');
  const r = await fetch('https://api.elevenlabs.io/v1/voices', {
    headers: { 'xi-api-key': apiKey }
  });
  if(!r.ok) throw new Error(`ElevenLabs ${r.status}`);
  const j = await r.json();
  return (j?.voices || []).map(v => ({
    id: v.voice_id,
    name: v.name,
    category: v.category || ''
  }));
}
