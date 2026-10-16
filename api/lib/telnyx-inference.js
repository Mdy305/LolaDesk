// Telnyx AI Inference via the OpenAI-compatible API. Reuses TELNYX_API_KEY. Used by onboarding
// (reading the salon's website), lola/ask.js and inbox replies. The model is picked from Telnyx's own
// list (telnyx-models.js): the fast model first (reads a website in seconds), the strong one as backup.
import { modelFor, markModelBad, isModelError, modelListed } from './telnyx-models.js';
const TELNYX_AI = 'https://api.telnyx.com/v2/ai/openai/chat/completions';

async function defaultModel(role) {
  const env = process.env.TELNYX_LLM_MODEL;
  if (role === 'fast' && env && (await modelListed(env.trim()).catch(() => null)) === true) return env.trim();
  return modelFor(role);
}

export async function chat(opts) {
  const first = opts?.model || await defaultModel('fast');
  try { return await chatOnce({ ...opts, model: first }); }
  catch (e) {
    const status = Number((String(e?.message).match(/Telnyx AI (\d{3})/) || [])[1]);
    if (isModelError(status, e?.message)) markModelBad(first);
    else if (opts?.model || !/\b(400|404|422|429|5\d\d)\b|model|timeout|fetch failed/i.test(String(e?.message))) throw e;
    const next = await modelFor('power');
    if (!next || next === first) throw e;
    return chatOnce({ ...opts, model: next, max_tokens: Math.max(opts?.max_tokens || 1200, 2000) });
  }
}

async function chatOnce({ messages, model, max_tokens, temperature, response_format }) {
  const key = process.env.TELNYX_API_KEY;
  if (!key) throw new Error('TELNYX_API_KEY missing');

  const r = await fetch(TELNYX_AI, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + key,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: max_tokens || 1200,
      temperature: temperature ?? 0.2,
      ...(response_format ? { response_format } : {})
    })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = j?.errors?.[0]?.detail || j?.error?.message || r.statusText;
    throw new Error(`Telnyx AI ${r.status}: ${msg}`);
  }
  return j;
}

// Convenience: return just the assistant text.
export async function chatText({ system, user, model, max_tokens, temperature }) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: user });
  const j = await chat({ messages, model, max_tokens, temperature });
  return j?.choices?.[0]?.message?.content || '';
}

// Convenience: chat expecting JSON output. Attempts strict JSON parse of the
// first {…} block in the response.
export async function chatJson({ system, user, model, max_tokens, temperature }) {
  const text = await chatText({ system, user, model, max_tokens, temperature });
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < 0) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}
