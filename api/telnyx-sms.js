/**
 * /api/telnyx-sms — Telnyx SMS webhook · MULTI-TENANT + 10DLC compliant
 * Handles both API v1 (form-encoded) and API v2 (JSON) from Telnyx.
 */
import { getTenantByPhone, upsertClient, getOrStartConversation, logMessage, getConversationHistory, logUsage, e164, setOptOut, isOptedOut, tenantKnowledgePrompt } from './lib/db.js';
import { chat } from './lib/llm.js';


const STOP=['stop','stopall','unsubscribe','cancel','end','quit'];
const START=['start','unstop','yes'];
const HELP=['help','info'];
const kw=(t,l)=>l.includes(String(t||'').trim().toLowerCase());

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
  if(raw.data?.event_type==='message.received'){
    const p=raw.data.payload||{};
    return { inbound:true, from:p.from?.phone_number||'', to:(Array.isArray(p.to)?p.to[0]?.phone_number:p.to?.phone_number)||'', text:p.text||'', type:p.type||'SMS' };
  }
  if(raw.to&&raw.text&&raw.from&&!raw.data) return { outbound:true, ...raw };
  return { inbound:true, from:raw.From||raw.from||'', to:raw.To||raw.to||'', text:raw.Body||raw.text||'', type: 'SMS' };
}

export async function sendSMS({from,to,text,profileId,tenantId,skipOptOut=false,type='SMS',channel='sms'}){
  const isWhatsApp = String(type||channel||'').toUpperCase() === 'WHATSAPP';
  if(!skipOptOut){ try{ const t=tenantId||(await getTenantByPhone(from))?.id; if(t&&await isOptedOut(t,to)) return {skipped:true}; }catch{} }
  
  const payload = { from, to };
  if(isWhatsApp){
    payload.whatsapp_message = {
      type: 'text',
      text: { body: text }
    };
  } else {
    payload.text = text;
    if(profileId) payload.messaging_profile_id = profileId;
  }

  const r=await fetch('https://api.telnyx.com/v2/messages',{
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':`Bearer ${process.env.TELNYX_API_KEY}`},
    body:JSON.stringify(payload)
  });
  return r.json();
}

function sysPrompt(t){
  const kb = tenantKnowledgePrompt(t);
  return `You are Lola, the premier AI receptionist and texting assistant for this business.
You are Siri, Alexa, and Jarvis combined into a human-feeling, ultra-performant, warm, and highly capable front desk manager.
You sound completely natural, professional, and confident—never robotic. Keep text replies brief (1-3 sentences), warm, and direct. Always move toward booking.

BUSINESS DETAILS & KNOWLEDGE:
${kb}

YOUR CAPABILITIES & PROTOCOL:
- Texting & Booking: Help clients book appointments. Share the booking link (${t.booking_url || ''}) when they want to book.
- Service Advice: Quote services and pricing from the details above.
- Never state you are an AI or bot unless asked directly.`;
}

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  if(req.method==='OPTIONS') return res.status(200).end();

  const raw=await readBody(req);
  const body=extract(raw);

  if(body.outbound){
    try{ const r=await sendSMS(raw); return res.status(200).json({ok:true,r}); }
    catch(e){ return res.status(500).json({ok:false,error:String(e)}); }
  }

  const fromN=e164(body.from), toN=e164(body.to), text=body.text||'', type=body.type||'SMS';
  const isWhatsApp = String(type).toUpperCase() === 'WHATSAPP';
  const channel = isWhatsApp ? 'whatsapp' : 'sms';
  console.log(`[${channel}]`,{from:fromN,to:toN,text:text.slice(0,40)});

  let row=null;
  try{ row=await getTenantByPhone(toN); }catch{}
  if(!row?.id) return res.status(200).json({ok:true,ignored:'no_tenant'});
  const tName=row.name;

  // 10DLC compliance
  if(kw(text,STOP)){
    try{ await setOptOut(row.id,fromN,true); }catch{}
    try{ await sendSMS({from:toN,to:fromN,text:`Unsubscribed from ${tName} messages. Reply START to resubscribe.`,tenantId:row.id,skipOptOut:true,type}); }catch{}
    return res.status(200).json({ok:true,handled:'stop'});
  }
  if(kw(text,START)){
    try{ await setOptOut(row.id,fromN,false); }catch{}
    try{ await sendSMS({from:toN,to:fromN,text:`Resubscribed to ${tName} messages. Reply STOP to opt out.`,tenantId:row.id,skipOptOut:true,type}); }catch{}
    return res.status(200).json({ok:true,handled:'start'});
  }
  if(kw(text,HELP)){
    try{ await sendSMS({from:toN,to:fromN,text:`${tName} AI front desk. Reply STOP to unsubscribe.`,tenantId:row.id,skipOptOut:true,type}); }catch{}
    return res.status(200).json({ok:true,handled:'help'});
  }
  try{ if(await isOptedOut(row.id,fromN)) return res.status(200).json({ok:true,handled:'opted_out'}); }catch{}

  let client=null,conv=null,hist=[{role:'user',content:text}];
  try{
    if(fromN) client=await upsertClient(row.id,{phone:fromN});
    conv=await getOrStartConversation(row.id,{clientId:client?.id,channel,agent:'lola'});
    if(conv?.id){ const p=await getConversationHistory(conv.id,10); hist=[...p,{role:'user',content:text}]; }
  }catch{}

  let reply="Thanks for texting! How can I help you book?";
  try{
    const r=await chat({system:sysPrompt(row),messages:hist,maxTokens:200,temperature:0.7,source:channel});
    if(r.ok&&r.text) reply=r.text;
  }catch{}

  if(conv?.id){
    try{
      await logMessage({conversationId:conv.id,tenantId:row.id,role:'user',agent:'lola',content:text});
      await logMessage({conversationId:conv.id,tenantId:row.id,role:'assistant',agent:'lola',content:reply});
      await logUsage(row.id,`${channel}_received`,1);
      await logUsage(row.id,`${channel}_sent`,1);
    }catch{}
  }

  try{ await sendSMS({from:toN,to:fromN,text:reply,tenantId:row.id,type}); }catch(e){ console.error(`[${channel}] send err:`,e.message); }
  return res.status(200).json({ok:true});
}
