/**
 * api/lib/llm.js — Shared LLM client (Telnyx Inference default)
 */
const TELNYX_INFERENCE = 'https://api.telnyx.com/v2/ai/chat/completions';
const ANTHROPIC_API    = 'https://api.anthropic.com/v1/messages';
const DEFAULT_TELNYX_MODEL    = 'moonshotai/Kimi-K2.6';
const POWER_TELNYX_MODEL      = 'moonshotai/Kimi-K2.6';
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6';

function provider(){ return (process.env.LLM_PROVIDER || 'telnyx').toLowerCase(); }
export const POWER_MODEL = process.env.LLM_POWER_MODEL || POWER_TELNYX_MODEL;

export async function chat({ system='', messages=[], maxTokens=600, temperature=0.7, model, jsonMode=false } = {}){
  const p = provider();
  if(p === 'anthropic') return chatAnthropic({ system, messages, maxTokens, temperature, model });
  return chatTelnyx({ system, messages, maxTokens, temperature, model, jsonMode });
}

async function chatTelnyx({ system, messages, maxTokens, temperature, model, jsonMode }){
  if(!process.env.TELNYX_API_KEY) return { ok:false, text:'', provider:'telnyx', error:'Missing TELNYX_API_KEY' };
  const oaiMessages = [];
  if(system) oaiMessages.push({ role:'system', content: system });
  for(const m of messages) oaiMessages.push({ role: m.role, content: m.content });
  const body = { model: model || process.env.LLM_MODEL || DEFAULT_TELNYX_MODEL, messages: oaiMessages, max_tokens: maxTokens, temperature };
  if(jsonMode) body.response_format = { type: 'json_object' };
  try{
    const r = await fetch(TELNYX_INFERENCE, { method:'POST', headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${process.env.TELNYX_API_KEY}` }, body: JSON.stringify(body) });
    const data = await r.json();
    if(!r.ok) return { ok:false, text:'', raw:data, provider:'telnyx', model:body.model, error: data?.error?.message || data?.errors?.[0]?.detail || `HTTP ${r.status}` };
    const text = data?.choices?.[0]?.message?.content || '';
    return { ok:true, text, raw:data, provider:'telnyx', model:body.model };
  }catch(e){ return { ok:false, text:'', provider:'telnyx', error:String(e) }; }
}

async function chatAnthropic({ system, messages, maxTokens, temperature, model }){
  if(!process.env.ANTHROPIC_API_KEY) return { ok:false, text:'', provider:'anthropic', error:'Missing ANTHROPIC_API_KEY' };
  try{
    const r = await fetch(ANTHROPIC_API, { method:'POST', headers:{ 'Content-Type':'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version':'2023-06-01' }, body: JSON.stringify({ model: model || process.env.LLM_MODEL || DEFAULT_ANTHROPIC_MODEL, max_tokens: maxTokens, temperature, system, messages }) });
    const data = await r.json();
    if(!r.ok) return { ok:false, text:'', raw:data, provider:'anthropic', error: data?.error?.message || `HTTP ${r.status}` };
    const text = data?.content?.[0]?.text || '';
    return { ok:true, text, raw:data, provider:'anthropic' };
  }catch(e){ return { ok:false, text:'', provider:'anthropic', error:String(e) }; }
}
