/**
 * /api/admin/lola-voice-fix — diagnose and repair Lola's assistant voice
 * ════════════════════════════════════════════════════════════════
 * GET  → the assistant's current voice_settings (no secrets).
 * POST { voice: "<Telnyx voice id>" } → PATCHes the shared assistant's
 *        voice to a Telnyx-native one (e.g. "Telnyx.NaturalHD.astra").
 *
 * WHY THIS EXISTS: when the ElevenLabs account hits 0 credits, the
 * assistant's configured voice (an ElevenLabs-hosted voice) fails INSIDE
 * Telnyx on every conversation: the greeting turn completes with zero
 * audio and the conversation dies (conversation_ended). That mutes the
 * orb AND every phone call at once. Switching the assistant's voice to a
 * Telnyx-native id makes her speak again with zero ElevenLabs credits.
 * Admin-gated (ADMIN_EMAILS) like the other operator surfaces; the Telnyx
 * key never appears in any response.
 */
import { getUserFromToken, bearer } from '../lib/auth.js';

const TELNYX = 'https://api.telnyx.com/v2';
const ASSISTANT_ID = process.env.TELNYX_ASSISTANT_ID || process.env.TELNYX_LOLA_BRAIN_ID;

function isAdmin(email) {
  const list = String(process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return !!email && list.includes(String(email).toLowerCase());
}
function authHeaders() {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.TELNYX_API_KEY}` };
}
async function tFetch(path, opts = {}) {
  const r = await fetch(TELNYX + path, { ...opts, headers: { ...authHeaders(), ...(opts.headers || {}) } });
  const data = await r.json().catch(() => null);
  return { status: r.status, data };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await getUserFromToken(bearer(req));
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  if (!isAdmin(user.email)) return res.status(403).json({ error: 'Not authorized' });
  if (!process.env.TELNYX_API_KEY) return res.status(500).json({ error: 'Missing TELNYX_API_KEY' });
  if (!ASSISTANT_ID) return res.status(503).json({ error: 'TELNYX_ASSISTANT_ID not configured' });

  try {
    if (req.method === 'GET') {
      const { status, data } = await tFetch('/ai/assistants/' + encodeURIComponent(ASSISTANT_ID));
      if (status !== 200) return res.status(502).json({ error: 'Telnyx assistant lookup failed: ' + status });
      const a = data?.data || data;
      return res.status(200).json({
        ok: true,
        assistant_id: a.id,
        name: a.name,
        model: a.model || null,
        voice: a.voice_settings?.voice || a.voice || null,
        voice_settings: a.voice_settings || null,
      });
    }

    if (req.method === 'PATCH' || (req.method === 'POST')) {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const voice = String(body.voice || '').trim();
      // Guard: a bare or nonexistent voice id makes Telnyx fail conversations
      // silently. Require the documented Provider.Model.VoiceId shape.
      if (!voice || !/^[A-Za-z0-9]+(\.[A-Za-z0-9]+){1,3}$/.test(voice)) {
        return res.status(400).json({ error: "voice must be a Telnyx Provider.Model.VoiceId, e.g. 'Telnyx.NaturalHD.astra' or 'Telnyx.KokoroTTS.af_nova'" });
      }
      const { status, data } = await tFetch('/ai/assistants/' + encodeURIComponent(ASSISTANT_ID), {
        method: 'PATCH',
        body: JSON.stringify({ voice_settings: { voice } }),
      });
      if (status !== 200) {
        return res.status(502).json({ error: 'Telnyx voice patch failed: ' + status, detail: String(JSON.stringify(data)).slice(0, 300) });
      }
      const a = data?.data || data;
      return res.status(200).json({
        ok: true,
        patched: voice,
        assistant_id: a.id,
        voice: a.voice_settings?.voice || a.voice || null,
      });
    }

    return res.status(405).json({ error: 'GET or PATCH only' });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
