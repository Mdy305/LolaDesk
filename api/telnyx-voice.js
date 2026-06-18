/**
 * /api/telnyx-voice — Telnyx TeXML Voice webhook · MULTI-TENANT
 * Works with Telnyx API v1 (form-encoded) AND API v2 (JSON).
 * Vercel does NOT auto-parse form-encoded bodies — we do it manually.
 */
import { getTenantByPhone, upsertClient, getOrStartConversation, logMessage, getConversationHistory, logUsage, e164 } from './lib/db.js';
import { chat } from './lib/llm.js';
import { synthesize, isConfigured as elevenLabsConfigured } from './lib/elevenlabs.js';
import { putAudio } from './lib/tts-cache.js';

export const config = { api: { bodyParser: false } };

const XML = '<?xml version="1.0" encoding="UTF-8"?>';
const FALLBACK = 'Polly.Joanna-Neural';
const BASE = () => process.env.APP_URL || 'https://www.loladesk.com';

function texml(inner){ return `${XML}\n<Response>${inner}</Response>`; }
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

async function readBody(req){
  return new Promise(resolve=>{
    let raw='';
    req.on('data',c=>raw+=c.toString());
    req.on('end',()=>{
      const ct=(req.headers['content-type']||'').toLowerCase();
      if(ct.includes('json')){ try{ resolve(JSON.parse(raw)); }catch{ resolve({}); } }
      else{ try{ const p=new URLSearchParams(raw),o={}; for(const[k,v]of p)o[k]=v; resolve(o); }catch{ resolve({}); } }
    });
    req.on('error',()=>resolve({}));
  });
}

function extract(raw){
  // Telnyx API v2 JSON
  if(raw.data?.payload){
    const p=raw.data.payload;
    return {
      to: p.to || p.to_number?.phone_number || '',
      from: p.from || p.from_number?.phone_number || '',
      speech: p.speech_result || p.recognition_result?.transcription || '',
      state: p.client_state || '',
      status: p.state || 'ringing'
    };
  }
  // API v1 form-encoded
  return {
    to: raw.To || raw.to || '',
    from: raw.From || raw.from || '',
    speech: raw.SpeechResult || raw.Digits || '',
    state: raw.client_state || '',
    status: raw.CallStatus || raw.call_status || 'ringing'
  };
}

async function speak(text){
  if(elevenLabsConfigured()){
    try{ const buf=await synthesize(text); const id=putAudio(buf); return `<Play>${BASE()}/api/voice-audio?id=${id}</Play>`; }
    catch(e){ console.error('[voice] ElevenLabs err:',e.message); }
  }
  return `<Say voice="${FALLBACK}">${esc(text)}</Say>`;
}

function prompt(t){
  const svc=(t.services||[]).map(s=>`${s.name} $${s.price}`).join(', ');
  return `You are Lola, AI receptionist for ${t.name} (${t.location||''}). Live phone call — ONE short sentence per reply, no filler words, always move toward booking. Services: ${svc}. Hours: ${t.hours||'Tue-Sat noon-8pm'}. Booking: ${t.bookingUrl||''}. Collect service+day+name to book, confirm you'll text the link. Never say you are an AI unless asked.`;
}

function decState(s){ try{ return JSON.parse(Buffer.from(s||'','base64').toString()); }catch{ return {h:[]}; } }
function encState(o){ return Buffer.from(JSON.stringify(o)).toString('base64'); }

function shape(t){ return { name:t.name, location:t.location, hours:t.hours, bookingUrl:t.booking_url, services:t.services||[] }; }

export default async function handler(req,res){
  res.setHeader('Content-Type','application/xml');
  if(req.method==='GET') return res.status(200).send(texml('<Say>Lola is live.</Say>'));

  const raw=await readBody(req);
  const {to,from,speech,state,status}=extract(raw);
  const toN=e164(to), fromN=e164(from);
  const ACTION='/api/telnyx-voice';

  console.log('[voice]',{to:toN,from:fromN,speech:!!speech,status});

  // Tenant lookup
  let tenant=null,row=null;
  try{ row=await getTenantByPhone(toN); if(row?.id) tenant=shape(row); }catch(e){ console.error('[voice] tenant err:',e.message); }

  if(!tenant){
    console.error('[voice] no tenant for',toN);
    const s=await speak("Hi! This Lola line is being set up. Please call back soon.");
    return res.status(200).send(texml(s));
  }

  // Client + conversation
  let client=null,conv=null;
  try{
    if(fromN) client=await upsertClient(row.id,{phone:fromN});
    conv=await getOrStartConversation(row.id,{clientId:client?.id,channel:'voice',agent:'lola'});
  }catch(e){ console.error('[voice] client err:',e.message); }

  // State
  const st=decState(state);
  if(!st.h) st.h=[];
  if(!st.cid && conv?.id) st.cid=conv.id;
  if(st.h.length===0 && conv?.id){ try{ const p=await getConversationHistory(conv.id,8); if(p.length) st.h=p; }catch{} }

  // Greeting
  if(!speech){
    const name=client?.name?`, ${client.name.split(' ')[0]}`:'';
    const greet=st.h.length>0?`Welcome back${name}! It's Lola — how can I help?`:`Hi, thanks for calling ${tenant.name}! This is Lola. How can I help?`;
    const gTag=await speak(greet);
    const nTag=await speak("I didn't catch that — please call back anytime!");
    try{ await logUsage(row.id,'voice_call',1,{source:'voice'}); }catch{}
    return res.status(200).send(texml(
      `<Gather input="speech" action="${ACTION}" method="POST" speechTimeout="auto" language="en-US" client_state="${encState(st)}">` +
      gTag+`</Gather>`+nTag
    ));
  }

  // Lola responds
  st.h.push({role:'user',content:speech});
  let reply="I'm having a little trouble — could you say that again?";
  try{
    const r=await chat({system:prompt(tenant),messages:st.h,maxTokens:90,temperature:0.7});
    if(r.ok && r.text) reply=r.text;
    else console.error('[voice] LLM:',r.error);
  }catch(e){ console.error('[voice] chat err:',e.message); }
  st.h.push({role:'assistant',content:reply});

  if(st.cid){
    try{
      await logMessage({conversationId:st.cid,tenantId:row.id,role:'user',agent:'lola',content:speech});
      await logMessage({conversationId:st.cid,tenantId:row.id,role:'assistant',agent:'lola',content:reply});
      await logUsage(row.id,'ai_token',1,{source:'voice'});
      await logUsage(row.id,'tts_chars',reply.length,{source:'voice'});
    }catch{}
  }

  if(st.h.length>12) st.h=st.h.slice(-12);

  const rTag=await speak(reply);
  const cTag=await speak(`Thanks for calling ${tenant.name}. Talk soon!`);
  return res.status(200).send(texml(
    `<Gather input="speech" action="${ACTION}" method="POST" speechTimeout="auto" language="en-US" client_state="${encState(st)}">` +
    rTag+`</Gather>`+cTag+`<Hangup/>`
  ));
}
