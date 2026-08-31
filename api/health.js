/** Lightweight production readiness check. Never returns secret values. */
import { checkHealth } from './lib/elevenlabs.js';

export default async function handler(req, res){
  if(req.method !== 'GET' && req.method !== 'HEAD'){
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).json({ ok:false, error:'Method not allowed' });
  }

  res.setHeader('Cache-Control', 'no-store');
  // ElevenLabs was a lie: env-present is NOT the same as "Lola can speak".
  // Run a real billing-safe probe (one GET /voices, no chars consumed) and
  // surface the exact reason when synthesis would fail — credits, bad key,
  // or a voice ID that isn't on the account.
  let voice = { ok:false, configured:false, message:'voice probe skipped' };
  try{
    voice = await checkHealth({ timeoutMs: 5000 });
  }catch(e){
    voice = { ok:false, message:String(e?.message || e).slice(0, 220) };
  }

  const services = {
    supabase: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
    telnyx: Boolean(process.env.TELNYX_API_KEY),
    elevenlabs: voice.ok
  };
  const ok = services.supabase && services.telnyx;
  if(req.method === 'HEAD') return res.status(ok ? 200 : 503).end();
  return res.status(ok ? 200 : 503).json({
    ok,
    provider: 'telnyx',
    services,
    voice,
    timestamp: new Date().toISOString()
  });
}
