// ElevenLabs TTS proxy for /api/speak-lola preview.
// Falls back to Telnyx TTS if ELEVENLABS_API_KEY is not set.
const EL_API = 'https://api.elevenlabs.io/v1';
const DEFAULT_VOICE_ID = process.env.LOLA_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL'; // Bella (warm, natural)

export async function synthesize({ text, voice_id, format = 'mp3_44100_128' }) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error('ELEVENLABS_API_KEY missing');
  const vid = voice_id || DEFAULT_VOICE_ID;

  const r = await fetch(`${EL_API}/text-to-speech/${vid}?output_format=${format}`, {
    method: 'POST',
    headers: {
      'xi-api-key': key,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg'
    },
    body: JSON.stringify({
      text,
      model_id: 'eleven_turbo_v2_5',
      voice_settings: { stability: 0.55, similarity_boost: 0.75, style: 0.15, use_speaker_boost: true }
    })
  });

  if (!r.ok) {
    const errText = await r.text().catch(() => '');
    throw new Error(`ElevenLabs ${r.status}: ${errText.slice(0, 200)}`);
  }
  const ab = await r.arrayBuffer();
  return Buffer.from(ab);
}

// List available voices (used by the picker in step 0 if you want to expose it).
export async function listVoices() {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return [];
  const r = await fetch(`${EL_API}/voices`, { headers: { 'xi-api-key': key } });
  if (!r.ok) return [];
  const j = await r.json();
  return (j.voices || []).map(v => ({
    voice_id: v.voice_id,
    name: v.name,
    labels: v.labels || {},
    preview_url: v.preview_url
  }));
}
