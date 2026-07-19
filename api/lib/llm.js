/**
 * api/lib/llm.js — Telnyx AI brain
 * ════════════════════════════════════════════════════════════════
 * All LolaDesk channels use Telnyx inference. Keeping provider selection in
 * one server-side module prevents an environment variable or browser payload
 * from silently switching the product to another AI provider.
 */
const TELNYX_INFERENCE    = 'https://api.telnyx.com/v2/ai/openai/chat/completions';
const DEFAULT_TELNYX_MODEL    = 'moonshotai/Kimi-K2.6';

export const POWER_MODEL = process.env.LLM_POWER_MODEL || DEFAULT_TELNYX_MODEL;

export async function chat({ system='', messages=[], maxTokens=600, temperature=0.7, model, source='', tools=null } = {}){
  return chatTelnyx({ system, messages, maxTokens, temperature, model, tools });
}

async function chatTelnyx({ system, messages, maxTokens, temperature, model, tools }){
  if(!process.env.TELNYX_API_KEY) return { ok:false, text:'', provider:'telnyx', error:'Missing TELNYX_API_KEY' };
  const m = model || DEFAULT_TELNYX_MODEL;
  const oai = [];
  if(system) oai.push({ role:'system', content:system });
  for(const msg of messages) {
    if(msg.role === 'tool') {
      oai.push({ role: 'tool', tool_call_id: msg.tool_call_id, name: msg.name, content: msg.content });
    } else if (msg.tool_calls) {
      oai.push({ role: 'assistant', content: msg.content || null, tool_calls: msg.tool_calls });
    } else {
      oai.push({ role:msg.role, content:msg.content });
    }
  }
  const budgets = [Math.max(maxTokens,3200), Math.max(maxTokens,2000), 1200, 800];
  let last = { error:'no attempts' };
  let dropTools = false;
  for(let i=0;i<budgets.length;i++){
    try{
      const payload = { model:m, messages:oai, max_tokens:budgets[i], temperature:i>1?0.6:temperature };
      if(tools && tools.length > 0 && !dropTools) payload.tools = tools;

      const r = await fetch(TELNYX_INFERENCE, {
        method:'POST',
        headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${process.env.TELNYX_API_KEY}` },
        body: JSON.stringify(payload)
      });
      const data = await r.json();
      console.log('[telnyx inference response]', JSON.stringify(data));
      if(!r.ok){
        last={error:data?.error?.message||`HTTP ${r.status}`};
        // If the provider rejects the request while tools are attached, retry
        // once WITHOUT tools so Lola can still respond conversationally.
        if(r.status === 400 && payload.tools && !dropTools){ dropTools = true; continue; }
        if(!`${r.status}`.startsWith('5')) break;
        continue;
      }
      
      const msg = data?.choices?.[0]?.message;
      const text = (msg?.content || msg?.reasoning || '').trim();
      const tool_calls = msg?.tool_calls || null;
      
      if(text || tool_calls) return { ok:true, text, tool_calls, provider:'telnyx', model:m, attempt:i+1 };
      last = { error:'empty response' };
    }catch(e){ last={error:String(e&&e.message||e)}; }
    await new Promise(r=>setTimeout(r,250));
  }
  return { ok:false, text:'', provider:'telnyx', model:m, error:'all attempts failed: '+(last.error||'') };
}

