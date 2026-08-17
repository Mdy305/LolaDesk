/**
 * GET /api/voices  (Authorization: Bearer <access_token>)
 * → { ok, voices:[{id,name,category}], defaultVoice, current }
 *
 * Lists the voices available on the account's ElevenLabs key. Lola's
 * voice is CANONICAL — one voice for every tenant, like Siri — so
 * `current` is always the platform's ELEVENLABS_VOICE_ID, never a
 * per-tenant choice. There is no voice picker.
 */
import { getUserFromToken, bearer } from './lib/auth.js';
import { resolveTenantForUser } from './lib/tenant-access.js';
import { listVoices } from './lib/elevenlabs.js';

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  if(req.method === 'OPTIONS') return res.status(200).end();
  if(req.method !== 'GET') return res.status(405).json({ error:'GET only' });

  try{
    const user = await getUserFromToken(bearer(req));
    if(!user) return res.status(401).json({ error:'not authenticated' });

    const voices = await listVoices();
    const tenant = await resolveTenantForUser(user);

    return res.status(200).json({
      ok: true,
      voices,
      defaultVoice: process.env.ELEVENLABS_VOICE_ID || null,
      current: process.env.ELEVENLABS_VOICE_ID || null
    });
  }catch(e){
    return res.status(500).json({ ok:false, error:String(e&&e.message||e) });
  }
}
