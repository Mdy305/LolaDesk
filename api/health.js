/** Lightweight production readiness check. Never returns secret values. */
export default function handler(req, res){
  if(req.method !== 'GET' && req.method !== 'HEAD'){
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).json({ ok:false, error:'Method not allowed' });
  }

  res.setHeader('Cache-Control', 'no-store');
  const services = {
    supabase: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
    telnyx: Boolean(process.env.TELNYX_API_KEY),
    elevenlabs: Boolean(process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID)
  };
  const ok = services.supabase && services.telnyx;
  if(req.method === 'HEAD') return res.status(ok ? 200 : 503).end();
  return res.status(ok ? 200 : 503).json({
    ok,
    provider: 'telnyx',
    services,
    timestamp: new Date().toISOString()
  });
}
