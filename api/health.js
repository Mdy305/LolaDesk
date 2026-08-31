/** Lightweight production readiness check. Never returns secret values. */
import { checkHealth, getUserSubscription } from './lib/elevenlabs.js';

export default async function handler(req, res){
  if(req.method !== 'GET' && req.method !== 'HEAD'){
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).json({ ok:false, error:'Method not allowed' });
  }

  res.setHeader('Cache-Control', 'no-store');

  // Billing-safe probes — BOTH are account-metadata GETs that consume ZERO
  // characters/credits (no synthesis). NEVER echo the key.
  //
  // checkHealth: GET /v1/voices — is the key valid and does the configured
  //   Lola voice resolve on this account? This alone lied before: /v1/voices
  //   returns 200 even at 0 credits, so the board showed green while
  //   /api/speak-lola 401'd with quota_exceeded.
  //
  // getUserSubscription: GET /v1/user/subscription — remaining monthly
  //   characters. This is what makes the voice row genuinely RED when the
  //   account is out of credit (the exact 0-credits state).
  let voice = { ok:false, configured:false, message:'voice probe skipped' };
  try{
    voice = await checkHealth({ timeoutMs: 5000 });
  }catch(e){
    voice = { ok:false, message:String(e?.message || e).slice(0, 220) };
  }

  let sub = { ok:false, available:false, message:'subscription probe skipped' };
  try{
    sub = await getUserSubscription({ timeoutMs: 5000 });
    sub.available = sub.ok === true;
  }catch(e){
    sub = { ok:false, available:false, message:String(e?.message || e).slice(0, 220) };
  }

  // A valid voice with a depleted quota is the account-level out-of-credit
  // state — the thing /v1/voices alone could never reveal.
  const voiceViable = voice.ok === true;
  const quotaExhausted = voiceViable && sub.quotaExhausted === true;
  const voiceOk = voiceViable && !quotaExhausted;

  // Augment the surfaced voice object WITHOUT ever touching the key.
  voice.voiceOk = voiceViable;
  voice.creditsRemaining = sub.ok ? sub.remaining : null;
  voice.characterLimit = sub.ok ? sub.characterLimit : null;
  voice.tier = sub.ok ? sub.tier : '';
  voice.quotaExhausted = quotaExhausted;
  voice.billing = quotaExhausted
    ? 'out-of-credit'
    : (sub.available ? 'ok' : (voiceViable ? 'unknown' : 'unavailable'));
  if(voiceOk && voice.message == null) voice.message = 'voice ready';

  if(quotaExhausted){
    voice.message =
      `ElevenLabs account is OUT OF CREDITS (${sub.remaining ?? 0} remaining). ` +
      `Top up at elevenlabs.io to hear Lola's voice here. Phone calls still work via Telnyx.`;
  }

  const services = {
    supabase: { ok: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) },
    telnyx: { ok: Boolean(process.env.TELNYX_API_KEY) },
    elevenlabs: {
      ok: voiceOk,
      attention: quotaExhausted || (voiceViable && !sub.available),
      reason: quotaExhausted ? 'out-of-credit' : (voiceViable ? undefined : 'voice-unavailable'),
      voice: voice.voice || undefined,
      creditsRemaining: voice.creditsRemaining,
      tier: voice.tier,
      message: quotaExhausted ? voice.message : (voiceViable ? undefined : (voice.message || undefined))
    }
  };
  const ok = services.supabase.ok && services.telnyx.ok;
  if(req.method === 'HEAD') return res.status(ok ? 200 : 503).end();
  return res.status(ok ? 200 : 503).json({
    ok,
    provider: 'telnyx',
    services,
    voice,
    timestamp: new Date().toISOString()
  });
}