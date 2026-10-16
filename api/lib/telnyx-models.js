/**
 * api/lib/telnyx-models.js — Lola's brain is picked from Telnyx's OWN model list, never a guessed id.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * Telnyx retires and renames inference models (Llama 3.x left the list in 2026). A hard-coded id that
 * Telnyx no longer serves makes every answer fail or fall back to a slow reasoning model past its
 * deadline — chat, texts, the website, the phone assistant and onboarding all go quiet at once.
 * So: GET /v2/ai/openai/models (cached), pick by role from what is really there, drop a model the
 * moment Telnyx refuses it, and fall back to today's documented ids only if the list can't be read.
 *   fast      — conversation (owner commands, website chat, texts): a quick, non-reasoning model
 *   power     — long writing and anything that must not fail: the strongest model listed
 *   assistant — the phone assistant: Telnyx's "recommended for assistants" first
 *   vision    — reading a photo
 */
const MODELS_URL = 'https://api.telnyx.com/v2/ai/openai/models';
const TTL_MS = 30 * 60e3;
// Today's documented ids — used only when the live list can't be read.
export const FALLBACK = Object.freeze({ fast: 'zai-org/GLM-5.3-Flash', power: 'moonshotai/Kimi-K2.6', assistant: 'zai-org/GLM-5.3-Flash', vision: 'moonshotai/Kimi-K2.6' });
// Retired ids still found in old settings: never sent again.
const RETIRED = /(^|\/)(meta-)?llama|Meta-Llama|Llama-3/i;

const PREFER = {
  fast: [/GLM-[\d.]+-Flash/i, /DeepSeek-V[\d.]+-Flash/i, /Qwen3/i, /gemma/i, /MiniMax/i, /GLM-[\d.]+$/i, /Kimi/i],
  power: [/Kimi-K3/i, /Kimi-K2\.6/i, /Kimi/i, /GLM-[\d.]+$/i, /DeepSeek-V[\d.]+(?!-Flash)/i, /MiniMax/i, /GLM/i, /DeepSeek/i],
};
PREFER.assistant = PREFER.fast;
PREFER.vision = PREFER.power;

let cache = { at: 0, list: null, error: null };
const bad = new Map();            // model id → until (ms): Telnyx refused it
let inflight = null;

export function _resetModels() { cache = { at: 0, list: null, error: null }; bad.clear(); inflight = null; }

/** The chat models this Telnyx account can call → [{ id, created, recommended, vision, tier }] (cached 30 min). */
export async function telnyxModels({ fresh = false, timeoutMs = 4000 } = {}) {
  if (!fresh && cache.list && Date.now() - cache.at < TTL_MS) return cache.list;
  if (!process.env.TELNYX_API_KEY) return cache.list || [];
  if (inflight) return inflight;
  inflight = (async () => {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(MODELS_URL, { headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}` }, signal: ctl.signal });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !Array.isArray(j?.data)) { cache = { ...cache, at: cache.list ? cache.at : 0, error: j?.errors?.[0]?.detail || j?.error?.message || `HTTP ${r.status}` }; return cache.list || []; }
      const list = j.data.filter((m) => m && m.id && (!m.task || /text-generation|chat/i.test(m.task)) && !/embed|whisper|tts|rerank/i.test(m.id))
        .map((m) => ({ id: String(m.id), created: Date.parse(m.created || 0) || 0, recommended: !!m.recommended_for_assistants, vision: !!m.is_vision_supported, tier: m.tier || null, context: Number(m.context_length) || null }));
      cache = { at: Date.now(), list, error: null };
      return list;
    } catch (e) {
      cache = { ...cache, error: e?.name === 'AbortError' ? 'timeout' : String(e?.message || e) };
      return cache.list || [];
    } finally { clearTimeout(timer); inflight = null; }
  })();
  return inflight;
}

const usable = (id) => !!id && !((bad.get(id) || 0) > Date.now());
/** An id from old settings that Telnyx no longer serves (only trusted when the live list can't be read). */
export const looksRetired = (id) => RETIRED.test(String(id || ''));

/** Pick from a list (pure). */
export function pickFrom(list, role = 'fast', { avoid = [] } = {}) {
  const pool = (list || []).filter((m) => usable(m.id) && !avoid.includes(m.id) && (role !== 'vision' || m.vision));
  const env = role === 'fast' ? process.env.LOLA_FAST_MODEL : role === 'power' ? process.env.LOLA_POWER_MODEL : role === 'assistant' ? process.env.LOLA_ASSISTANT_MODEL : null;
  if (env && pool.some((m) => m.id === env.trim())) return env.trim();
  let candidates = pool;
  if (role === 'assistant' && pool.some((m) => m.recommended)) candidates = pool.filter((m) => m.recommended);
  for (const re of PREFER[role] || PREFER.fast) {
    const hit = candidates.filter((m) => re.test(m.id)).sort((a, b) => b.created - a.created)[0];
    if (hit) return hit.id;
  }
  return candidates.sort((a, b) => b.created - a.created)[0]?.id || null;
}

/** The model to use for a role, from the live list (falls back to today's documented ids). */
export async function modelFor(role = 'fast', opts = {}) {
  const list = await telnyxModels(opts).catch(() => []);
  return pickFrom(list, role, opts) || (usable(FALLBACK[role]) ? FALLBACK[role] : FALLBACK.power);
}

/** Synchronous best guess (last list read), for labels and logs. */
export function cachedModelFor(role = 'fast') {
  return pickFrom(cache.list || [], role) || FALLBACK[role] || FALLBACK.power;
}

/** Telnyx refused this model (unknown / not enabled): skip it for an hour and re-read the list. */
export function markModelBad(id, ms = 60 * 60e3) {
  if (!id) return;
  bad.set(id, Date.now() + ms);
  cache.at = 0;                  // the next pick re-reads what Telnyx really serves
}

/** Is a Telnyx error about the model itself (vs. a bad request)? */
export function isModelError(status, error) {
  const e = String(error || '');
  // Only an error ABOUT THE MODEL benches it ("model … not found / does not exist / not available").
  // "tools not supported", a too-long prompt or odd message order is a bad request, not a missing model.
  return [400, 403, 404, 422].includes(Number(status)) && /\bmodels?\b/i.test(e) && !/\btools?\b|function|context|token|message/i.test(e)
    && /not (found|available|enabled|supported|allowed|exist)|does not exist|doesn'?t exist|unknown|invalid|no such|unavailable|deprecated|retired/i.test(e);
}

/** Is this id one Telnyx lists right now? (null when the list couldn't be read) */
export async function modelListed(id) {
  const list = await telnyxModels().catch(() => []);
  if (!list.length) return null;
  return list.some((m) => m.id === id);
}

export function modelsState() { return { listed: (cache.list || []).map((m) => m.id), read_at: cache.at || null, error: cache.error, avoided: [...bad.keys()] }; }
