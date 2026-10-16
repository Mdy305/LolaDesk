/**
 * api/lib/llm.js — Telnyx-only LolaBrain inference gateway
 * ════════════════════════════════════════════════════════════════
 * Every LolaDesk channel calls this module for AI reasoning. Provider and
 * model selection are server-controlled so browser payloads, tenant data, or
 * stale environment variables cannot silently move Lola to another provider.
 */
import { modelFor, cachedModelFor, markModelBad, isModelError, FALLBACK } from './telnyx-models.js';
const TELNYX_INFERENCE = 'https://api.telnyx.com/v2/ai/openai/chat/completions';
// Models come from Telnyx's own list (telnyx-models.js) — never a hard-coded id Telnyx may have retired.
const DEFAULT_TELNYX_MODEL = FALLBACK.power;
const REQUEST_TIMEOUT_MS = 30000;
// Conversation needs speed: Lola answering a voice turn, a text, the website
// chat or the owner's command bar. Those go to a fast, non-reasoning open
// model hosted by Telnyx (same API, same key), inside a hard deadline — and
// fall back to Kimi only if that model is unavailable. Long-form writing
// (strategy, learning a website, campaign plans) stays on Kimi.
export const FAST_MODEL = () => cachedModelFor('fast');
const FAST_DEADLINE_MS = 15000;
const LONG_DEADLINE_MS = 48000;

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

export async function chat({ system='', messages=[], maxTokens=600, temperature=0.7, tools=null, fast, deadlineMs } = {}){
  const multimodal = (messages || []).some(m => m && m.content != null && typeof m.content !== 'string');
  const quick = fast ?? (!multimodal && Number(maxTokens || 600) <= 700);
  if(multimodal) return chatTelnyx({ system, messages, maxTokens, temperature, tools, deadlineMs });
  // Long-form writing (reading a website, the growth strategy, campaigns) used to go to Kimi alone:
  // a reasoning model that can think past 30s per attempt, so with retries the request outlived
  // Vercel's 60s limit and the owner saw nothing. Now it's written by the fast model inside one
  // 48s budget, with Kimi as the fallback in whatever time is left.
  return chatFast({ system, messages, maxTokens, temperature, tools, deadlineMs: deadlineMs || (quick ? FAST_DEADLINE_MS : LONG_DEADLINE_MS), long: !quick });
}

/** Strip any chain-of-thought a model leaks into its answer. */
export function cleanAnswer(text){
  return String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?think>/gi, '')
    .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
    .trim();
}

function toOpenAI(system, messages){
  const oai=[];
  if(system) oai.push({ role:'system', content:system });
  for(const msg of messages || []){
    if(!msg || !msg.role) continue;
    if(msg.role==='tool') oai.push({ role:'tool', tool_call_id:msg.tool_call_id, name:msg.name, content:msg.content });
    else if(msg.tool_calls) oai.push({ role:'assistant', content:msg.content||null, tool_calls:msg.tool_calls });
    else oai.push({ role:msg.role, content:msg.content });
  }
  return oai;
}

async function callOnce({ model, oai, maxTokens, temperature, tools, timeoutMs }){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(), Math.max(1000, timeoutMs));
  try{
    const payload={ model, messages:oai, max_tokens:maxTokens, temperature };
    if(tools?.length) payload.tools=tools;
    const r=await fetch(TELNYX_INFERENCE,{
      method:'POST', signal:controller.signal,
      headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${process.env.TELNYX_API_KEY}`, 'X-LolaDesk-AI-Provider':'telnyx' },
      body:JSON.stringify(payload)
    });
    const data=await r.json().catch(()=>({}));
    if(!r.ok) return { ok:false, status:r.status, error:data?.error?.message || data?.errors?.[0]?.detail || `HTTP ${r.status}` };
    const msg=data?.choices?.[0]?.message;
    return { ok:true, text:cleanAnswer(msg?.content), tool_calls:msg?.tool_calls?.length ? msg.tool_calls : null };
  }catch(error){
    return { ok:false, status:0, error:error?.name==='AbortError'?'Telnyx inference timeout':String(error?.message||error) };
  }finally{ clearTimeout(timer); }
}

async function chatFast({ system, messages, maxTokens, temperature, tools, deadlineMs, long = false }){
  if(!process.env.TELNYX_API_KEY) return { ok:false, text:'', provider:AI_PROVIDER, model:FAST_MODEL(), error:'Missing TELNYX_API_KEY' };
  const started=Date.now(), deadline=Math.max(3000, Number(deadlineMs) || FAST_DEADLINE_MS);
  const left=()=>deadline-(Date.now()-started);
  const oai=toOpenAI(system, messages);
  const want=Math.max(200, Math.min(Number(maxTokens)||600, long ? 4000 : 1200));
  // The fast model and the strong one, both from what Telnyx really serves right now.
  const pick=(role)=>Promise.race([modelFor(role), new Promise((r)=>setTimeout(()=>r(cachedModelFor(role)), 3000))]);
  const [fastId, powerId]=await Promise.all([pick('fast'), pick('power')]);
  const plan=[];
  if(fastId && fastId!==powerId) plan.push({ model:fastId, maxTokens:want });
  plan.push({ model:powerId, maxTokens:Math.max(want, 2000) });   // the strong model may think before it speaks
  let last={ error:'no attempts' };
  for(let i=0;i<plan.length;i++){
    const step=plan[i], lastStep=i===plan.length-1;
    if(left()<2500) break;
    let useTools=tools;
    let r=await callOnce({ ...step, oai, temperature, tools:useTools, timeoutMs:left() });
    let toolsDropped=false;
    // Telnyx refused the MODEL (retired / not enabled): never ask for it again until the list changes.
    if(!r.ok && isModelError(r.status, r.error)){ markModelBad(step.model); last=r; console.info('[telnyx-ai]', { ok:false, status:r.status, model:step.model, refused:true }); continue; }
    // Refused the TOOLS: the next model gets them; only the last one answers without hands.
    if(!r.ok && r.status===400 && useTools?.length){
      if(!lastStep){ last=r; continue; }
      if(left()>2500){ useTools=null; toolsDropped=true; r=await callOnce({ ...step, oai, temperature, tools:null, timeoutMs:left() }); }
    }
    console.info('[telnyx-ai]', { ok:r.ok, status:r.status||200, model:step.model, fast:true, ms:Date.now()-started, toolCalls:r.tool_calls?.length||0 });
    if(r.ok && (r.text || r.tool_calls)) return { ok:true, text:r.text, tool_calls:r.tool_calls, provider:AI_PROVIDER, model:step.model, ms:Date.now()-started, ...(toolsDropped ? { toolsDropped:true } : {}) };
    last=r.ok ? { error:'empty response' } : r;
  }
  return { ok:false, text:'', provider:AI_PROVIDER, model:fastId || FAST_MODEL(), error:'Telnyx inference failed: '+(last.error||'unknown error') };
}

async function chatTelnyx({ system, messages, maxTokens, temperature, tools, deadlineMs }){
  // Optional overall budget (a texted photo must not outlive the request): every attempt fits inside it.
  const started=Date.now();
  const left=()=>deadlineMs ? Number(deadlineMs)-(Date.now()-started) : Infinity;
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

  const multimodal=(messages||[]).some(m => m && m.content != null && typeof m.content !== 'string');
  let model=await Promise.race([modelFor(multimodal ? 'vision' : 'power'), new Promise((r)=>setTimeout(()=>r(cachedModelFor(multimodal ? 'vision' : 'power')), 3000))]);
  const requested=Math.max(1,Math.min(Number(maxTokens)||600,8000));
  const budgets=[Math.max(requested,3200),Math.max(requested,2000),1200,800];
  let last={error:'no attempts'};
  let dropTools=false;

  for(let i=0;i<budgets.length;i++){
    if(left()<1000){ last={error:last.error==='no attempts'?'Telnyx inference deadline':last.error}; break; }
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),Math.max(500,Math.min(REQUEST_TIMEOUT_MS,left())));
    try{
      const payload={
        model,
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
        model,
        attempt:i+1,
        toolCalls:Array.isArray(data?.choices?.[0]?.message?.tool_calls)
          ? data.choices[0].message.tool_calls.length
          : 0
      });

      if(!r.ok){
        last={error:data?.error?.message||data?.errors?.[0]?.detail||`HTTP ${r.status}`};
        if(isModelError(r.status, last.error)){ markModelBad(model); const next=await modelFor(multimodal ? 'vision' : 'power').catch(()=>null); if(next && next!==model){ model=next; continue; } }
        if(r.status===400&&payload.tools&&!dropTools){ dropTools=true; continue; }
        if(!`${r.status}`.startsWith('5')&&r.status!==429) break;
        continue;
      }

      const msg=data?.choices?.[0]?.message;
      const text=cleanAnswer(msg?.content||'');   // never speak the model's private reasoning
      const tool_calls=msg?.tool_calls||null;
      if(text||tool_calls){
        return { ok:true, text, tool_calls, provider:AI_PROVIDER, model, attempt:i+1, ...(dropTools&&tools?.length ? { toolsDropped:true } : {}) };
      }
      last={error:'empty response'};
    }catch(error){
      last={error:error?.name==='AbortError'?'Telnyx inference timeout':String(error?.message||error)};
    }finally{
      clearTimeout(timer);
    }
    if(left()<1250) break;
    await new Promise(resolve=>setTimeout(resolve,250));
  }

  return {
    ok:false,
    text:'',
    provider:AI_PROVIDER,
    model,
    error:'all Telnyx inference attempts failed: '+(last.error||'unknown error')
  };
}
