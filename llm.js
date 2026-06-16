/**
 * api/lib/llm.js — Single shared LLM client for every Lola agent
 * ════════════════════════════════════════════════════════════════
 * One place where we talk to a language model. Every handler imports
 * `chat()` from here. Today: Telnyx Inference. Optional Anthropic
 * fallback if you want to A/B or one provider is down.
 *
 * WHY THIS EXISTS:
 *   - Before: every handler had its own fetch to api.anthropic.com.
 *     If you wanted to switch providers, you edited 5 files.
 *   - Now: change LLM_PROVIDER in env and every handler routes there.
 *
 * ENV VARS (Vercel → Settings → Environment Variables):
 *   TELNYX_API_KEY          required
 *   LLM_PROVIDER            'telnyx' (default) | 'anthropic'
 *   LLM_MODEL               (optional) override default model
 *   ANTHROPIC_API_KEY       only if LLM_PROVIDER='anthropic'
 *
 * The Telnyx endpoint is OpenAI-compatible Chat Completions:
 *   POST https://api.telnyx.com/v2/ai/chat/completions
 *   { model, messages: [{role, content}], max_tokens, temperature }
 */

const TELNYX_INFERENCE = 'https://api.telnyx.com/v2/ai/chat/completions';
const ANTHROPIC_API    = 'https://api.anthropic.com/v1/messages';

// Default Telnyx model. Telnyx hosts many; this one is a strong general-
// purpose chat model at ~$0.21/1M tokens. Override per-call with `model`.
const DEFAULT_TELNYX_MODEL    = 'meta-llama/Meta-Llama-3.1-70B-Instruct';
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6';

function provider(){
  return (process.env.LLM_PROVIDER || 'telnyx').toLowerCase();
}

/**
 * chat({ system, messages, maxTokens, temperature, model, jsonMode })
 *
 *   system     — system prompt (string)
 *   messages   — [{ role:'user'|'assistant', content:string }, ...]
 *   maxTokens  — default 600
 *   temperature— default 0.7
 *   model      — optional override
 *   jsonMode   — if true, instruct Telnyx to return strict JSON
 *
 * Returns: { ok, text, raw, provider, model, error? }
 */
export async function chat({
  system = '',
  messages = [],
  maxTokens = 600,
  temperature = 0.7,
  model,
  jsonMode = false
} = {}){
  const p = provider();

  if(p === 'anthropic'){
    return chatAnthropic({ system, messages, maxTokens, temperature, model });
  }
  return chatTelnyx({ system, messages, maxTokens, temperature, model, jsonMode });
}

// ─────────────────────────────────────────────────────────
// TELNYX INFERENCE (default)
// ─────────────────────────────────────────────────────────
async function chatTelnyx({ system, messages, maxTokens, temperature, model, jsonMode }){
  if(!process.env.TELNYX_API_KEY){
    return { ok:false, text:'', provider:'telnyx', error:'Missing TELNYX_API_KEY' };
  }

  // Build OpenAI-shape messages: system first, then conversation
  const oaiMessages = [];
  if(system) oaiMessages.push({ role:'system', content: system });
  for(const m of messages){
    oaiMessages.push({ role: m.role, content: m.content });
  }

  const body = {
    model: model || process.env.LLM_MODEL || DEFAULT_TELNYX_MODEL,
    messages: oaiMessages,
    max_tokens: maxTokens,
    temperature
  };
  if(jsonMode){
    // Telnyx supports guided_json and guided_choice for strict outputs.
    // For now we just ask via prompt; switch to guided_json when we want
    // hard schema enforcement on specific shapes.
    body.response_format = { type: 'json_object' };
  }

  try{
    const r = await fetch(TELNYX_INFERENCE, {
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        'Authorization':`Bearer ${process.env.TELNYX_API_KEY}`
      },
      body: JSON.stringify(body)
    });
    const data = await r.json();
    if(!r.ok){
      return {
        ok:false, text:'', raw:data, provider:'telnyx', model:body.model,
        error: data?.error?.message || data?.errors?.[0]?.detail || `HTTP ${r.status}`
      };
    }
    const text = data?.choices?.[0]?.message?.content || '';
    return { ok:true, text, raw:data, provider:'telnyx', model:body.model };
  }catch(e){
    return { ok:false, text:'', provider:'telnyx', error:String(e) };
  }
}

// ─────────────────────────────────────────────────────────
// ANTHROPIC (optional fallback)
// ─────────────────────────────────────────────────────────
async function chatAnthropic({ system, messages, maxTokens, temperature, model }){
  if(!process.env.ANTHROPIC_API_KEY){
    return { ok:false, text:'', provider:'anthropic', error:'Missing ANTHROPIC_API_KEY' };
  }
  try{
    const r = await fetch(ANTHROPIC_API, {
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: model || process.env.LLM_MODEL || DEFAULT_ANTHROPIC_MODEL,
        max_tokens: maxTokens,
        temperature,
        system,
        messages
      })
    });
    const data = await r.json();
    if(!r.ok){
      return {
        ok:false, text:'', raw:data, provider:'anthropic',
        error: data?.error?.message || `HTTP ${r.status}`
      };
    }
    const text = data?.content?.[0]?.text || '';
    return { ok:true, text, raw:data, provider:'anthropic' };
  }catch(e){
    return { ok:false, text:'', provider:'anthropic', error:String(e) };
  }
}
