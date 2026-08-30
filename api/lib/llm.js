/**
 * api/lib/llm.js — Telnyx-only LolaBrain inference gateway
 * ════════════════════════════════════════════════════════════════
 * Every LolaDesk channel calls this module for AI reasoning. Provider and
 * model selection are server-controlled so browser payloads, tenant data, or
 * stale environment variables cannot silently move Lola to another provider.
 */
const TELNYX_INFERENCE = 'https://api.telnyx.com/v2/ai/openai/chat/completions';
const DEFAULT_TELNYX_MODEL = 'moonshotai/Kimi-K2.6';
const REQUEST_TIMEOUT_MS = 30000;

export const AI_PROVIDER = 'telnyx';
export const POWER_MODEL = DEFAULT_TELNYX_MODEL;
export const TELNYX_CAPABILITIES = Object.freeze({
  inference: true,
  voice: true,
  sms: true,
  whatsapp: true,
  telephony: true,
  callControl: true
});

export async function chat({ system='', messages=[], maxTokens=600, temperature=0.7, tools=null } = {}){
  return chatTelnyx({ system, messages, maxTokens, temperature, tools });
}

async function chatTelnyx({ system, messages, maxTokens, temperature, tools }){
  if(!process.env.TELNYX_API_KEY){
    return { ok:false, text:'', provider:AI_PROVIDER, model:POWER_MODEL, error:'Missing TELNYX_API_KEY' };
  }

  const oai=[];
  if(system) oai.push({ role:'system', content:system });
  for(const msg of messages){
    if(!msg || !msg.role) continue;
    if(msg.role==='tool'){
      oai.push({ role:'tool', tool_call_id:msg.tool_call_id, name:msg.name, content:msg.content });
    }else if(msg.tool_calls){
      oai.push({ role:'assistant', content:msg.content||null, tool_calls:msg.tool_calls });
    }else{
      oai.push({ role:msg.role, content:msg.content });
    }
  }

  const requested=Math.max(1,Math.min(Number(maxTokens)||600,8000));
  const budgets=[Math.max(requested,3200),Math.max(requested,2000),1200,800];
  let last={error:'no attempts'};
  let dropTools=false;

  for(let i=0;i<budgets.length;i++){
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),REQUEST_TIMEOUT_MS);
    try{
      const payload={
        model:POWER_MODEL,
        messages:oai,
        max_tokens:budgets[i],
        temperature:i>1?0.6:temperature
      };
      if(tools?.length&&!dropTools) payload.tools=tools;

      const r=await fetch(TELNYX_INFERENCE,{
        method:'POST',
        signal:controller.signal,
        headers:{
          'Content-Type':'application/json',
          'Authorization':`Bearer ${process.env.TELNYX_API_KEY}`,
          'X-LolaDesk-AI-Provider':'telnyx'
        },
        body:JSON.stringify(payload)
      });
      const data=await r.json().catch(()=>({}));

      console.info('[telnyx-ai]',{
        ok:r.ok,
        status:r.status,
        model:POWER_MODEL,
        attempt:i+1,
        toolCalls:Array.isArray(data?.choices?.[0]?.message?.tool_calls)
          ? data.choices[0].message.tool_calls.length
          : 0
      });

      if(!r.ok){
        last={error:data?.error?.message||`HTTP ${r.status}`};
        if(r.status===400&&payload.tools&&!dropTools){ dropTools=true; continue; }
        if(!`${r.status}`.startsWith('5')&&r.status!==429) break;
        continue;
      }

      const msg=data?.choices?.[0]?.message;
      const text=String(msg?.content||msg?.reasoning||'').trim();
      const tool_calls=msg?.tool_calls||null;
      if(text||tool_calls){
        return { ok:true, text, tool_calls, provider:AI_PROVIDER, model:POWER_MODEL, attempt:i+1 };
      }
      last={error:'empty response'};
    }catch(error){
      last={error:error?.name==='AbortError'?'Telnyx inference timeout':String(error?.message||error)};
    }finally{
      clearTimeout(timer);
    }
    await new Promise(resolve=>setTimeout(resolve,250));
  }

  return {
    ok:false,
    text:'',
    provider:AI_PROVIDER,
    model:POWER_MODEL,
    error:'all Telnyx inference attempts failed: '+(last.error||'unknown error')
  };
}
