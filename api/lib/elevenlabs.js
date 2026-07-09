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
 * Always uses Lola's one canonical voice (ELEVENLABS_VOICE_ID) — there
 * is intentionally no per-request override. One voice, everywhere,
 * always: that's the entire point of the brand-consistency goal, and
 * an override parameter here would be a backdoor around it.
 */
/* ── EMOTIONAL REGISTERS — the difference between reading and feeling ──
   One fixed voice setting makes every sentence land identically: the
   apology sounds like the upsell. Humans modulate. Three registers,
   layered over Lola's base voice:
     warm     — default conversational presence
     empathic — steadier, softer style: apologies, bad news, "I hear you"
     bright   — livelier, more expressive: confirmations, wins, welcomes
   registerForText() picks one from the reply's own words, so the
   emotion always matches the content with zero extra latency. */
const REGISTERS = {
  warm:     {},                                          // base settings as-is
  empathic: { stability: 0.72, style: 0.18 },            // calm, close, caring
  bright:   { stability: 0.38, style: 0.66 }             // lifted, energetic
};

export function registerForText(text){
  const t = String(text||'').toLowerCase();
  if(/\b(so sorry|i'm sorry|unfortunately|i understand|that's frustrating|i hear you|my apologies|missed you)\b/.test(t)) return 'empathic';
  if(/\b(perfect|you're all set|booked|confirmed|can't wait|amazing|wonderful|see you (then|soon|friday|saturday)|welcome back|great choice)\b/.test(t)) return 'bright';
  return 'warm';
}

export async function synthesize(text, { modelId, outputFormat, signal, register } = {}) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
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
      model_id: modelId || process.env.ELEVENLABS_MODEL || 'eleven_turbo_v2_5',
      voice_settings: { ...LOLA_VOICE_SETTINGS, ...(REGISTERS[register] || {}) }
    })
  });

  if(!r.ok){
    let detail = '';
    try{ detail = await r.text(); }catch{}
    throw new Error(`ElevenLabs ${r.status}: ${detail.slice(0,300)}`);
  }
  return Buffer.from(await r.arrayBuffer());
}
