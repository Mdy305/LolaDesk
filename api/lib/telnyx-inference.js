// Telnyx AI Inference — Kimi (and other models) via OpenAI-compatible API.
// Reuses TELNYX_API_KEY. Used by:
//   - onboarding/step2-ingest.js (extract salon info from website)
//   - lola/ask.js (Drop C — "ask Lola anything about your business")
//   - inbox autopilot replies (planned)
const TELNYX_AI = 'https://api.telnyx.com/v2/ai/chat/completions';
const DEFAULT_MODEL = process.env.TELNYX_LLM_MODEL || 'moonshotai/Kimi-K2-Instruct';

export async function chat({ messages, model, max_tokens, temperature, response_format }) {
  const key = process.env.TELNYX_API_KEY;
  if (!key) throw new Error('TELNYX_API_KEY missing');

  const r = await fetch(TELNYX_AI, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + key,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: model || DEFAULT_MODEL,
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
