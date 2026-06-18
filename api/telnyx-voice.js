/**
 * /api/telnyx-voice — Telnyx TeXML Voice webhook · MULTI-TENANT
 * ════════════════════════════════════════════════════════════════
 * ARCHITECTURE DECISION: Uses Telnyx <Say> (not <Play> + ElevenLabs)
 * for voice synthesis on calls. Here's why:
 *
 * The ElevenLabs-via-<Play> approach requires caching audio bytes in
 * memory, then serving them from /api/voice-audio. Vercel serverless
 * functions run as multiple isolated instances — the instance that
 * synthesizes audio is almost never the same instance that serves
 * /api/voice-audio, causing 404s and dead air on every real call.
 *
 * The ElevenLabs voice IS used in the dashboard (/api/speak) where
 * the browser fetches audio directly from the same function call.
 * For calls, <Say> with a high-quality neural voice is reliable,
 * consistent, and sounds far better than a broken/silent ElevenLabs
 * attempt. We use Telnyx's best available neural voice.
 *
 * Works with Telnyx API v1 (form-encoded) AND API v2 (JSON).
 * Vercel does NOT auto-parse form-encoded bodies — we parse manually.
 */
import {
  getTenantByPhone, upsertClient, getOrStartConversation,
  logMessage, getConversationHistory, logUsage, e164
} from './lib/db.js';
import { chat } from './lib/llm.js';

export const config = { api: { bodyParser: false } };

const XML = '<?xml version="1.0" encoding="UTF-8"?>';
// Best quality neural voice available on Telnyx TeXML
const VOICE = 'en-US-Neural2-F';

function texml(inner){ return `${XML}\n<Response>${inner}</Response>`; }
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function say(text){ return `<Say voice="${VOICE}">${esc(text)}</Say>`; }

async function readBody(req){
  return new Promise(resolve=>{
    let raw='';
    req.on('data',c=>{ raw+=c.toString(); });
    req.on('end',()=>{
      const ct=(req.headers['content-type']||'').toLowerCase();
      if(ct.includes('json')){
        try{ resolve(JSON.parse(raw)); }catch{ resolve({}); }
      } else {
        try{
          const p=new URLSearchParams(raw);
          const o={};
          for(const[k,v]of p) o[k]=v;
          resolve(o);
        }catch{ resolve({}); }
      }
    });
    req.on('error',()=>resolve({}));
  });
}

function extract(raw){
  // Telnyx API v2 JSON structure
  if(raw.data?.payload){
    const p=raw.data.payload;
    const toVal = p.to || p.to_number;
    const fromVal = p.from || p.from_number;
    return {
      to: typeof toVal==='object' ? (toVal.phone_number||'') : (toVal||''),
      from: typeof fromVal==='object' ? (fromVal.phone_number||'') : (fromVal||''),
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

function systemPrompt(t){
  const svc=(t.services||[]).map(s=>`${s.name} $${s.price}`).join(', ');
  return `You are Lola, the AI receptionist for ${t.name}${t.location?` in ${t.location}`:''}.\nLive phone call — keep every reply to ONE short sentence. No filler words. Warm, direct, always move toward booking.\nServices: ${svc}.\nHours: ${t.hours||'Tuesday to Saturday, noon to 8pm'}.\nBooking: ${t.bookingUrl||''}.\nTo book: collect service + preferred day + client name, then say you'll text them the booking link.\nIf you can't help with something, offer to take a message for the team.\nNever say you are an AI unless the caller asks directly.`;
}

function decState(s){
  try{ return JSON.parse(Buffer.from(s||'','base64').toString()); }
  catch{ return {h:[]}; }
}
function encState(o){ return Buffer.from(JSON.stringify(o)).toString('base64'); }
function shape(t){ return { name:t.name, location:t.location, hours:t.hours, bookingUrl:t.booking_url, services:t.services||[] }; }

export default async function handler(req,res){
  res.setHeader('Content-Type','application/xml');

  // Health check
  if(req.method==='GET'){
    return res.status(200).send(texml(say('Lola is live and ready.')));
  }

  const raw = await readBody(req);
  const {to, from, speech, state} = extract(raw);
  const toN = e164(to);
  const fromN = e164(from);
  const ACTION = '/api/telnyx-voice';

  console.log(`[voice] call: to=${toN} from=${fromN} speech="${speech?.slice(0,50)||'(none)'}"`);

  // ── Tenant resolution (core of multi-tenancy) ──
  let row=null;
  try{ row = await getTenantByPhone(toN); }
  catch(e){ console.error('[voice] tenant lookup error:', e.message); }

  if(!row?.id){
    console.error('[voice] no tenant found for number:', toN);
    return res.status(200).send(texml(
      say("Hi! This salon's Lola line is being set up. Please call back shortly.") +
      '<Hangup/>'
    ));
  }
  const tenant = shape(row);

  // ── Client + conversation ──
  let client=null, conv=null;
  try{
    if(fromN) client = await upsertClient(row.id, {phone:fromN});
    conv = await getOrStartConversation(row.id, {clientId:client?.id, channel:'voice', agent:'lola'});
  }catch(e){ console.error('[voice] client/conv error:', e.message); }

  // ── Per-turn state ──
  const st = decState(state);
  if(!st.h) st.h=[];
  if(!st.cid && conv?.id) st.cid = conv.id;

  // Load persistent memory on first turn
  if(st.h.length===0 && conv?.id){
    try{
      const past = await getConversationHistory(conv.id, 6);
      if(past.length) st.h = past;
    }catch{}
  }

  // ── Greeting (first turn) ──
  if(!speech){
    const name = client?.name ? `, ${client.name.split(' ')[0]}` : '';
    const isReturn = st.h.length > 0;
    const greeting = isReturn
      ? `Welcome back${name}! It's Lola at ${tenant.name} — how can I help you today?`
      : `Hi, thanks for calling ${tenant.name}! This is Lola. How can I help you today?`;

    try{ await logUsage(row.id,'voice_call',1,{source:'voice'}); }catch{}

    return res.status(200).send(texml(
      `<Gather input="speech" action="${ACTION}" method="POST" speechTimeout="auto" language="en-US" client_state="${encState(st)}">` +
      say(greeting) +
      `</Gather>` +
      say("I didn't quite catch that — please feel free to call back anytime!") +
      '<Hangup/>'
    ));
  }

  // ── Caller spoke: ask Lola ──
  st.h.push({role:'user', content:speech});

  let reply = "I'm sorry, I had a little trouble there — could you say that again?";
  try{
    const r = await chat({
      system: systemPrompt(tenant),
      messages: st.h,
      maxTokens: 90,
      temperature: 0.7
    });
    if(r.ok && r.text) reply = r.text.trim();
    else console.error('[voice] LLM failed:', r.error);
  }catch(e){ console.error('[voice] chat error:', e.message); }

  st.h.push({role:'assistant', content:reply});

  // Persist to DB
  if(st.cid){
    try{
      await logMessage({conversationId:st.cid, tenantId:row.id, role:'user', agent:'lola', content:speech});
      await logMessage({conversationId:st.cid, tenantId:row.id, role:'assistant', agent:'lola', content:reply});
      await logUsage(row.id,'ai_token',1,{source:'voice'});
    }catch{}
  }

  // Keep history lean for latency
  if(st.h.length > 10) st.h = st.h.slice(-10);

  return res.status(200).send(texml(
    `<Gather input="speech" action="${ACTION}" method="POST" speechTimeout="auto" language="en-US" client_state="${encState(st)}">` +
    say(reply) +
    `</Gather>` +
    say(`Thanks for calling ${tenant.name}. Have a great day!`) +
    '<Hangup/>'
  ));
}
