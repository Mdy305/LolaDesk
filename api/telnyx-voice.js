/**
 * /api/telnyx-voice — Telnyx TeXML Voice webhook · MULTI-TENANT
 * Plain Vercel serverless function (NOT Next.js).
 * No config export — Vercel auto-parses both JSON and form bodies.
 */
import { getTenantByPhone, upsertClient, getOrStartConversation, logMessage, getConversationHistory, logUsage, e164 } from './lib/db.js';
import { chat } from './lib/llm.js';

const XML   = '<?xml version="1.0" encoding="UTF-8"?>';
const VOICE = 'en-US-Neural2-F';

function texml(inner){ return `${XML}\n<Response>${inner}</Response>`; }
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function say(t){ return `<Say voice="${VOICE}">${esc(t)}</Say>`; }

// Extract fields from Telnyx payload — handles both API v1 and v2
function extract(b){
  if(!b) return { to:'', from:'', speech:'', state:'' };
  // API v2 JSON nested payload
  if(b.data?.payload){
    const p = b.data.payload;
    const toRaw   = p.to   || p.to_number   || '';
    const fromRaw = p.from || p.from_number || '';
    return {
      to:     typeof toRaw   === 'object' ? (toRaw.phone_number||'')   : toRaw,
      from:   typeof fromRaw === 'object' ? (fromRaw.phone_number||'') : fromRaw,
      speech: p.speech_result || p.recognition_result?.transcription || '',
      state:  p.client_state || ''
    };
  }
  // API v1 flat fields (form-encoded or JSON)
  return {
    to:     b.To    || b.to    || '',
    from:   b.From  || b.from  || '',
    speech: b.SpeechResult || b.Digits || '',
    state:  b.client_state || ''
  };
}

function decState(s){ try{ return JSON.parse(Buffer.from(s||'','base64').toString()); }catch{ return {h:[]}; } }
function encState(o){ return Buffer.from(JSON.stringify(o)).toString('base64'); }
function shape(t){ return { name:t.name, location:t.location, hours:t.hours, bookingUrl:t.booking_url, services:t.services||[] }; }

function systemPrompt(t){
  const svc = (t.services||[]).map(s=>`${s.name} $${s.price}`).join(', ');
  return `You are Lola, AI receptionist for ${t.name}${t.location?` in ${t.location}`:''}. Live phone call — ONE short sentence per reply. Warm, direct, always move toward booking. Services: ${svc}. Hours: ${t.hours||'Tue-Sat noon-8pm'}. Booking link: ${t.bookingUrl||''}. Collect service + day + name to book, then say you'll text them the link. Never say you are an AI unless asked.`;
}

export default async function handler(req, res){
  res.setHeader('Content-Type','application/xml');

  if(req.method === 'GET'){
    return res.status(200).send(texml(say('Lola is live.')));
  }

  // Vercel auto-parses JSON. For form-encoded, body may be a string.
  let body = req.body || {};
  if(typeof body === 'string'){
    try{
      const p = new URLSearchParams(body);
      body = {};
      for(const [k,v] of p) body[k] = v;
    }catch{ body = {}; }
  }

  const { to, from, speech, state } = extract(body);
  const toN   = e164(to);
  const fromN = e164(from);
  const ACTION = '/api/telnyx-voice';

  console.log(`[voice] to=${toN} from=${fromN} speech="${(speech||'').slice(0,40)}"`);

  // Tenant resolution
  let row = null;
  try{ row = await getTenantByPhone(toN); }
  catch(e){ console.error('[voice] tenant err:', e.message); }

  if(!row?.id){
    console.error('[voice] no tenant for:', toN);
    return res.status(200).send(texml(
      say("Hi! This salon's Lola line is being set up. Please call back shortly.") + '<Hangup/>'
    ));
  }

  const tenant = shape(row);

  // Client + conversation
  let client = null, conv = null;
  try{
    if(fromN) client = await upsertClient(row.id, { phone: fromN });
    conv = await getOrStartConversation(row.id, { clientId: client?.id, channel:'voice', agent:'lola' });
  }catch(e){ console.error('[voice] client err:', e.message); }

  const st = decState(state);
  if(!st.h) st.h = [];
  if(!st.cid && conv?.id) st.cid = conv.id;

  if(st.h.length === 0 && conv?.id){
    try{ const past = await getConversationHistory(conv.id, 6); if(past.length) st.h = past; }catch{}
  }

  // First turn — greet
  if(!speech){
    const known = client?.name ? `, ${client.name.split(' ')[0]}` : '';
    const greet = st.h.length > 0
      ? `Welcome back${known}! It's Lola at ${tenant.name} — how can I help?`
      : `Hi, thanks for calling ${tenant.name}! This is Lola. How can I help you today?`;
    try{ await logUsage(row.id,'voice_call',1,{source:'voice'}); }catch{}
    return res.status(200).send(texml(
      `<Gather input="speech" action="${ACTION}" method="POST" speechTimeout="auto" language="en-US" client_state="${encState(st)}">` +
      say(greet) + `</Gather>` +
      say("I didn't quite catch that — please feel free to call back anytime!") +
      '<Hangup/>'
    ));
  }

  // Lola responds
  st.h.push({ role:'user', content:speech });
  let reply = "I'm sorry, could you say that again?";
  try{
    const r = await chat({ system:systemPrompt(tenant), messages:st.h, maxTokens:90, temperature:0.7, source:'voice' });
    if(r.ok && r.text) reply = r.text.trim();
    else console.error('[voice] LLM:', r.error);
  }catch(e){ console.error('[voice] chat err:', e.message); }
  st.h.push({ role:'assistant', content:reply });

  if(st.cid){
    try{
      await logMessage({ conversationId:st.cid, tenantId:row.id, role:'user', agent:'lola', content:speech });
      await logMessage({ conversationId:st.cid, tenantId:row.id, role:'assistant', agent:'lola', content:reply });
      await logUsage(row.id,'ai_token',1,{source:'voice'});
    }catch{}
  }

  if(st.h.length > 10) st.h = st.h.slice(-10);

  return res.status(200).send(texml(
    `<Gather input="speech" action="${ACTION}" method="POST" speechTimeout="auto" language="en-US" client_state="${encState(st)}">` +
    say(reply) + `</Gather>` +
    say(`Thanks for calling ${tenant.name}. Have a great day!`) +
    '<Hangup/>'
  ));
}
