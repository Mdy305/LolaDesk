// api/speak-lola.js - ULTRA RESONANT VOICE (JARVIS/WHISPER/ALEXA/SIRI)
import { synthesize } from './lib/elevenlabs.js';

const VOICE_MODES = {
  jarvis: 'TxGQqXvQvUMEUxtXKvou', // Deep, resonant
  whisper: 'EXAVITQu4EER4nXzZamZ', // Soft, intimate
  alexa: 'MF3mGyEYCl7XYWbV7PZT', // Friendly
  siri: 'ThT5KcBeYPDsuQU2M7tG', // Natural
  lola: process.env.ELEVENLABS_VOICE_ID || 'TxGQqXvQvUMEUxtXKvou',
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { text, voiceType = 'jarvis' } = req.body;
    const voiceId = VOICE_MODES[voiceType] || VOICE_MODES.jarvis;

    // Synthesize with ElevenLabs
    const audio = await synthesize(text, {
      voice_id: voiceId,
      model_id: 'eleven_turbo_v2_5', // Ultra-resonant model
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
        use_speaker_boost: true, // MAXIMUM RESONANCE
      },
    });

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Content-Length', audio.length);
    return res.send(audio);
  } catch (error) {
    console.error('[SPEAK-LOLA]', error);
    res.status(500).json({ error: error.message });
  }
}
