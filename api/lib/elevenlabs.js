/**
 * api/lib/elevenlabs.js — Shared ElevenLabs TTS client
 * ════════════════════════════════════════════════════════════════
 * One implementation, used everywhere Lola needs to speak in her real
 * voice: the dashboard's /api/speak AND real phone calls via Telnyx.
 *
 * Lola is the brain of LolaDesk — one identity, ONE voice, across the
 * entire platform. Like Siri on Apple, she is NOT configurable per tenant
 * and her voice is NOT modified by this OS: every salon, every call, every
 * channel hears the exact voice the owner created in ElevenLabs.
 *
 * CRITICAL: synthesize() sends NO `voice_settings` override. ElevenLabs
 * then uses the voice's own saved settings — the voice *exactly as it was
 * created*. The OS must not reshape stability/style/similarity or apply
 * per-message "registers", because that would make Lola sound like a
 * modified version of the voice, not the voice itself.
 *
 * ENV VARS:
 *   ELEVENLABS_API_KEY    required
 *   ELEVENLABS_VOICE_ID   Lola's one canonical voice (required for calls)
 *   ELEVENLABS_MODEL      optional, defaults to eleven_turbo_v2_5 (low latency)
 */

const ELEVEN_TTS = 'https://api.elevenlabs.io/v1/text-to-speech';

export function isConfigured(){
  return !!(process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID);
}

/**
 * Synthesize text to speech. Returns a Buffer of MP3 bytes, or throws.
 * ALWAYS uses Lola's one canonical voice (ELEVENLABS_VOICE_ID) — the
 * `voice` option is deliberately ignored so no code path can ever give
 * a tenant its own Lola. And NO `voice_settings` is sent, so the voice
 * renders exactly as the owner created it. One brain, one voice,
 * everywhere.
 */
export async function synthesize(text, { modelId, outputFormat, signal } = {}) {
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
      model_id: modelId || process.env.ELEVENLABS_MODEL || 'eleven_turbo_v2_5'
      // NOTE: no voice_settings — Lola speaks in the voice exactly as
      // created, with its own saved settings. The OS never modifies it.
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
export async function listVoices({ timeoutMs = 8000 } = {}){
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if(!apiKey) throw new Error('Missing ELEVENLABS_API_KEY');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': apiKey },
      signal: ctrl.signal
    });
    if(!r.ok) {
      let detail = '';
      try{ detail = await r.text(); }catch{}
      // Include the status + short body (never the key) so a health gate can
      // tell the operator WHY synthesis is failing — bad key vs out of credit.
      throw new Error(`ElevenLabs ${r.status}: ${detail.slice(0, 200)}`);
    }
    const j = await r.json();
    return (j?.voices || []).map(v => ({
      id: v.voice_id,
      name: v.name,
      category: v.category || ''
    }));
  } finally {
    clearTimeout(t);
  }
}

/**
 * Truthful liveness probe for health gates. Never returns/leaks the API key.
 *
 *   { ok, message, configured, voiceIdValid?, voice?, voices?, status? }
 *
 * - ok:false + configured:false  → env missing
 * - ok:false + status:401/403    → API key invalid
 * - ok:false + status:402/429    → billing / rate (out of credit) — owner action
 * - ok:false + voiceIdValid:false→ the configured voice isn't on this account
 * - ok:true                      → key valid AND the canonical voice resolves
 *
 * A single GET /v1/voices is the cost (billing-safe; no characters consumed).
 */
export async function checkHealth({ timeoutMs = 8000, listVoices: _list = listVoices } = {}){
  // Capture the config ONCE, before any await — re-reading process.env across
  // an async boundary is race-prone (env can change, e.g. between the guard
  // and the voice lookup making the probe report a phantom mismatch).
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const vid = process.env.ELEVENLABS_VOICE_ID;
  if(!apiKey || !vid){
    return { ok:false, configured:false, message:'ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID are both required' };
  }
  let voices;
  try{
    voices = await _list({ timeoutMs });
  }catch(e){
    const m = String(e?.message || e);
    const status = /ElevenLabs (\d{3})/.exec(m)?.[1] || null;
    return { ok:false, configured:true, status: status ? Number(status) : null, message: m.slice(0, 220) };
  }
  const voice = voices.find(v => v.id === vid) || null;
  if(!voice){
    return {
      ok:false, configured:true, voiceIdValid:false,
      message:'The configured ELEVENLABS_VOICE_ID is not on this ElevenLabs account',
      voices: voices.length
    };
  }
  return { ok:true, configured:true, voiceIdValid:true, voice: voice.name, voices: voices.length };
}

/**
 * Billing-safe quota probe for health gates. Uses GET /v1/user/subscription —
 * an account-metadata READ that consumes NO characters/credits (unlike any
 * TTS call). Reports remaining monthly characters so a gate can turn Lola's
 * voice row RED the moment the ElevenLabs account is at quota_exceeded.
 *
 * Returns { ok, characterCount, characterLimit, tier, remaining, quotaExhausted,
 *           nextResetAt? } — and NEVER returns or echoes the API key.
 *
 * - characterLimit is the string "unlimited" on uncapped plans → remaining null,
 *   quotaExhausted false (a capped plan is the only case we can call "out").
 * - ok:false → the subscription endpoint itself failed (e.g. 401 bad key), with
 *   a short status+detail reason — still no key.
 */
export async function getUserSubscription({ timeoutMs = 8000, fetch: ff = globalThis.fetch } = {}){
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if(!apiKey) throw new Error('Missing ELEVENLABS_API_KEY');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await ff('https://api.elevenlabs.io/v1/user/subscription', {
      headers: { 'xi-api-key': apiKey },
      signal: ctrl.signal
    });
    if(!r.ok){
      let detail = '';
      try{ detail = await r.text(); }catch{}
      throw new Error(`ElevenLabs subscription ${r.status}: ${detail.slice(0, 200)}`);
    }
    const j = await r.json();
    const count = Number(j?.character_count) || 0;
    const rawLimit = j?.character_limit;
    const finiteLimit = (typeof rawLimit === 'number') && Number.isFinite(rawLimit);
    const limit = finiteLimit ? rawLimit : null;
    const remaining = finiteLimit ? Math.max(0, limit - count) : null;
    return {
      ok: true,
      characterCount: count,
      characterLimit: limit,
      tier: (typeof j?.tier === 'string' && j.tier) || '',
      remaining,
      quotaExhausted: finiteLimit ? (remaining <= 0) : false,
      nextResetAt: Number(j?.next_character_count_reset_unix) || null
    };
  } finally {
    clearTimeout(t);
  }
}
