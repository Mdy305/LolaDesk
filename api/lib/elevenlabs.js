/**
 * api/lib/elevenlabs.js — Shared ElevenLabs TTS client
 * ════════════════════════════════════════════════════════════════
 * One implementation, used everywhere Lola needs to speak in her real
 * voice: the dashboard's /api/speak AND real phone calls via Telnyx.
 *
 * This is the file that makes "Lola sounds the same everywhere" true.
 * Lola is the brain of LolaDesk — one identity, one voice, across the
 * entire platform. Like Siri on Apple, she is NOT configurable per tenant:
 * every salon, every call, every channel hears the same Lola. If you ever
 * change her voice, change it here once and it changes everywhere.
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
 * ALWAYS uses Lola's one canonical voice (ELEVENLABS_VOICE_ID) — the
 * `voice` option is deliberately ignored so no code path can ever give
 * a tenant its own Lola. One brain, one voice, everywhere.
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
