/**
 * /api/health — platform readiness. Delegates to the ONE health gate
 * (api/lib/health-gate.js); the billing-safe ElevenLabs probes are
 * composed here and injected, keeping this file a thin transport layer.
 * Shape unchanged: { ok, provider, services, voice, timestamp }.
 */
import { checkHealth, getUserSubscription } from './lib/elevenlabs.js';
import { platformHealth, healthSend } from './lib/health-gate.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  // Billing-safe probes — BOTH are account-metadata GETs that consume ZERO
  // characters/credits (no synthesis). NEVER echo the key. checkHealth
  // alone lied before: /v1/voices returns 200 even at 0 credits.
  const voiceCheck = async () => {
    let voice;
    try {
      voice = await checkHealth({ timeoutMs: 5000 });
    } catch (e) {
      voice = { ok: false, message: String(e?.message || e).slice(0, 220) };
    }
    let sub = { ok: false, available: false, message: 'subscription probe skipped' };
    try {
      sub = await getUserSubscription({ timeoutMs: 5000 });
      sub.available = sub.ok === true;
    } catch (e) {
      sub = { ok: false, available: false, message: String(e?.message || e).slice(0, 220) };
    }
    const voiceViable = voice.ok === true;
    const quotaExhausted = voiceViable && sub.quotaExhausted === true;
    voice.voiceOk = voiceViable;
    voice.creditsRemaining = sub.ok ? sub.remaining : null;
    voice.characterLimit = sub.ok ? sub.characterLimit : null;
    voice.tier = sub.ok ? sub.tier : '';
    voice.quotaExhausted = quotaExhausted;
    voice.billing = quotaExhausted ? 'out-of-credit' : (sub.available ? 'ok' : (voiceViable ? 'unknown' : 'unavailable'));
    if (voiceViable && !quotaExhausted && voice.message == null) voice.message = 'voice ready';
    if (quotaExhausted) {
      voice.message = `ElevenLabs account is OUT OF CREDITS (${sub.remaining ?? 0} remaining). ` +
        `Top up at elevenlabs.io to hear Lola's voice here. Phone calls still work via Telnyx.`;
    }
    return { ok: voiceViable && !quotaExhausted, voice, quotaExhausted };
  };

  const result = await platformHealth({ voiceCheck });
  if (req.method === 'HEAD') return healthSend(res, result, { head: true, cors: false });
  return healthSend(res, result, { cors: false });
}
