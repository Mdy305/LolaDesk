/**
 * api/lib/llm.js — Shared LLM client (Telnyx Inference default)
 * RESILIENT: Kimi-K2.6 on Telnyx intermittently returns empty, and fails
 * high-token generations. chatTelnyx retries on empty with progressively
 * smaller max_tokens, so callers reliably get content.
 * ENV: TELNYX_API_KEY, LLM_PROVIDER, LLM_MODEL, ANTHROPIC_API_KEY
 */
const TELNYX_INFERENCE = 'https://api.telnyx.com/v2/ai/chat/completions';
const ANTHROPIC_API    = 'https://api.anthropic.com/v1/messages';
const DEFAULT_TELNYX_MODEL    = 'moonshotai/Kimi-K2.6';
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6';

function provider(){ return (process.env.LLM_PROVIDER || 'telnyx').toLowerCase(); }
export const POWER_MODEL = process.env.LLM_POWER_MODEL || DEFAULT_TELNYX_MODEL;

export async function chat({ system='', messages=[], maxTokens=600, temperature=0.7, model, jsonMode=false } = {}){
  const p = provider();
  if(p === 'anthropic') return chatAnthropic({ system, messages, maxTokens, temperature, model });
  return chatTelnyx({ system, messages, maxTokens, temperature, model });
}

async function callOnce({ system, messages, maxTokens, temperature, model }){
  const oai = [];
  if(system) oai.push({ role:'system', content: system });
  for(const m of messages) oai.push({ role: m.role, content: m.content });
  const r = await fetch(TELNYX_INFERENCE, {
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${process.env.TELNYX_API_KEY}` },
    body: JSON.stringify({ model, messages: oai, max_tokens: maxTokens, temperature })
  });
  const data = await r.json();
  if(!r.ok) return { httpOk:false, text:'', raw:data, error: data?.error?.message || data?.errors?.[0]?.detail || `HTTP ${r.status}` };
  return { httpOk:true, text: data?.choices?.[0]?.message?.content || '', raw:data };
}

async function chatTelnyx({ system, messages, maxTokens, temperature, model }){
  if(!process.env.TELNYX_API_KEY) return { ok:false, text:'', provider:'telnyx', error:'Missing TELNYX_API_KEY' };
  const m = model || process.env.LLM_MODEL || DEFAULT_TELNYX_MODEL;
  // Telnyx/Kimi sometimes returns empty, and fails high-token gens.
  // Retry on empty with progressively smaller token budgets.
  const budgets = [ Math.min(maxTokens, 800), 600, 500, 400, 350 ];
  let last = { error:'no attempts' };
  for(let i=0;i<budgets.length;i++){
    try{
      const res = await callOnce({ system, messages, maxTokens: budgets[i], temperature: i>1?0.6:temperature, model: m });
      if(res.httpOk && res.text && res.text.trim()){
        return { ok:true, text:res.text, raw:res.raw, provider:'telnyx', model:m, attempt:i+1, tokens:budgets[i] };
      }
      last = { error: res.error || 'empty', raw:res.raw };
      if(!res.httpOk && res.error && !/empty/i.test(res.error)) {
        // a real HTTP error (bad model/auth) won't fix with fewer tokens — stop
        break;
      }
    }catch(e){ last = { error:String(e&&e.message||e) }; }
    await new Promise(r=>setTimeout(r, 250));
  }
  return { ok:false, text:'', provider:'telnyx', model:m, error:'all attempts empty: '+(last.error||'') };
}

async function chatAnthropic({ system, messages, maxTokens, temperature, model }){
  if(!process.env.ANTHROPIC_API_KEY) return { ok:false, text:'', provider:'anthropic', error:'Missing ANTHROPIC_API_KEY' };
  try{
    const r = await fetch(ANTHROPIC_API, { method:'POST', headers:{ 'Content-Type':'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version':'2023-06-01' }, body: JSON.stringify({ model: model || process.env.LLM_MODEL || DEFAULT_ANTHROPIC_MODEL, max_tokens: maxTokens, temperature, system, messages }) });
    const data = await r.json();
    if(!r.ok) return { ok:false, text:'', raw:data, provider:'anthropic', error: data?.error?.message || `HTTP ${r.status}` };
    return { ok:true, text: data?.content?.[0]?.text || '', raw:data, provider:'anthropic' };
  }catch(e){ return { ok:false, text:'', provider:'anthropic', error:String(e) }; }
}
