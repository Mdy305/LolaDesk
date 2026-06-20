/**
 * api/lib/llm.js — Dual-provider AI brain
 * ════════════════════════════════════════════════════════════════
 * Telnyx/Kimi-K2.6: voice calls + SMS (fast, cheap, already paid)
 * Anthropic/Claude: Marketer, strategy, campaigns (reliable for
 * complex reasoning — requires ANTHROPIC_API_KEY with credits)
 *
 * Pass source:'voice'|'sms' for Telnyx, source:'marketer'|'strategy'
 * for Anthropic. LLM_PROVIDER env var overrides everything.
 */
const TELNYX_INFERENCE    = 'https://api.telnyx.com/v2/ai/openai/chat/completions';
const ANTHROPIC_API       = 'https://api.anthropic.com/v1/messages';
const DEFAULT_TELNYX_MODEL    = 'moonshotai/Kimi-K2.6';
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6';

export const POWER_MODEL = process.env.LLM_POWER_MODEL || DEFAULT_TELNYX_MODEL;

function pickProvider(source){
  const explicit = (process.env.LLM_PROVIDER||'').toLowerCase();
  if(explicit) return explicit;
  if(process.env.TELNYX_API_KEY) return 'telnyx';
  if(process.env.ANTHROPIC_API_KEY) return 'anthropic';
  return 'telnyx';
}

export async function chat({ system='', messages=[], maxTokens=600, temperature=0.7, model, source='' } = {}){
  const p = pickProvider(source);
  if(p === 'anthropic') return chatAnthropic({ system, messages, maxTokens, temperature, model });
  return chatTelnyx({ system, messages, maxTokens, temperature, model });
}

async function chatTelnyx({ system, messages, maxTokens, temperature, model }){
  if(!process.env.TELNYX_API_KEY) return { ok:false, text:'', provider:'telnyx', error:'Missing TELNYX_API_KEY' };
  const m = model || DEFAULT_TELNYX_MODEL;
  const oai = [];
  if(system) oai.push({ role:'system', content:system });
  for(const msg of messages) oai.push({ role:msg.role, content:msg.content });
  const budgets = [Math.max(maxTokens,1600), Math.max(maxTokens,1000), 800, 600];
  let last = { error:'no attempts' };
  for(let i=0;i<budgets.length;i++){
    try{
      const r = await fetch(TELNYX_INFERENCE, {
        method:'POST',
        headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${process.env.TELNYX_API_KEY}` },
        body: JSON.stringify({ model:m, messages:oai, max_tokens:budgets[i], temperature:i>1?0.6:temperature })
      });
      const data = await r.json();
      console.log('[telnyx inference response]', JSON.stringify(data));
      if(!r.ok){ last={error:data?.error?.message||`HTTP ${r.status}`}; if(!`${r.status}`.startsWith('5')) break; continue; }
      const text = (data?.choices?.[0]?.message?.content || data?.choices?.[0]?.message?.reasoning || '').trim();
      if(text) return { ok:true, text, provider:'telnyx', model:m, attempt:i+1 };
      last = { error:'empty response' };
    }catch(e){ last={error:String(e&&e.message||e)}; }
    await new Promise(r=>setTimeout(r,250));
  }
  return { ok:false, text:'', provider:'telnyx', model:m, error:'all attempts failed: '+(last.error||'') };
}

async function chatAnthropic({ system, messages, maxTokens, temperature, model }){
  if(!process.env.ANTHROPIC_API_KEY) return { ok:false, text:'', provider:'anthropic', error:'Missing ANTHROPIC_API_KEY — add credits at console.anthropic.com' };
  const m = model || DEFAULT_ANTHROPIC_MODEL;
  let lastError = 'unknown';
  for(let attempt=0;attempt<2;attempt++){
    try{
      const r = await fetch(ANTHROPIC_API, {
        method:'POST',
        headers:{ 'Content-Type':'application/json', 'x-api-key':process.env.ANTHROPIC_API_KEY, 'anthropic-version':'2023-06-01' },
        body: JSON.stringify({ model:m, max_tokens:maxTokens, temperature, system, messages })
      });
      const data = await r.json();
      if(!r.ok){ lastError=data?.error?.message||`HTTP ${r.status}`; if(r.status===401||r.status===400) break; continue; }
      const text = data?.content?.[0]?.text||'';
      if(text) return { ok:true, text, provider:'anthropic', model:m, attempt:attempt+1 };
      lastError='empty response';
    }catch(e){ lastError=String(e&&e.message||e); }
    if(attempt===0) await new Promise(r=>setTimeout(r,300));
  }
  return { ok:false, text:'', provider:'anthropic', model:m, error:lastError };
}
