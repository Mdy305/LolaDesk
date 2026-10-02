// GET /api/speak-lola?text=...&voice_id=...
// Returns audio/mpeg of Lola saying the text. Used by the voice preview
// button in onboarding.html step 0 and the "hear her again" button on step 5.
import { synthesize } from './lib/elevenlabs.js';
import { allowAnonymousSpeech, hasBearer } from './lib/voice-guard.js';
import { checkTextSig } from './lib/one-voice.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const text = String(req.query?.text || req.body?.text || '').slice(0, 600);
    // Only signed-in owners may pick a different voice; everyone else hears Lola.
    const voice_id = hasBearer(req) ? (req.query?.voice_id || req.body?.voice_id) : undefined;
    if (!text) return res.status(400).json({ ok: false, error: 'missing_text' });
    // Our own calls (Telnyx fetching her line) carry a signature: never rate-limited.
    if (!checkTextSig(text, req.query?.sig) && !allowAnonymousSpeech(req)) return res.status(429).json({ ok: false, error: 'rate_limited' });

    const audio = await synthesize({ text, voice_id });
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.status(200).send(audio);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
