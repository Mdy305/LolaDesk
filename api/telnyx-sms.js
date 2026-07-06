/**
 * /api/telnyx-sms — Telnyx SMS webhook · MULTI-TENANT + 10DLC compliant
 * Handles both API v1 (form-encoded) and API v2 (JSON) from Telnyx.
 */
import { getTenantByPhone, getTenantByOperatorPhone, upsertClient, getClientMemory, setClientMemory, getOrStartConversation, logMessage, getConversationHistory, logUsage, e164, setOptOut, isOptedOut } from './lib/db.js';
import { answerOwner } from './lib/owner-brain.js';
import { chat } from './lib/llm.js';
import { getTelnyxSignatureHeaders, verifyTelnyxSignature } from './lib/telnyx-signature.js';
import { runLolaAgentReply } from './lib/lola-agent.js';
import { channelAllowed } from './lib/plans.js';
import { buildClientMemoryBlock, buildLolaSystemPrompt, detectConversationMood, detectLolaIntent, deterministicSkillReply, evaluateInteractionQuality, extractPersonalizationSignals, mergeClientProfile, profileFromMemoryRows } from './lib/lola-skills.js';


// NOTE: 'cancel' and 'yes' are intentionally NOT opt-out/opt-in keywords —
// in a salon context a bare "cancel" means cancel my appointment and "yes"
// means confirm. Treating them as STOP/START unsubscribes real clients.
const STOP=['stop','stopall','unsubscribe','quit','end'];
const START=['start','unstop'];
const HELP=['help','info'];
const kw=(t,l)=>l.includes(String(t||'').trim().toLowerCase());

// Keep the raw body intact so the Telnyx webhook signature can be verified.
// Without this, Vercel pre-parses the body and signature checks are skipped.
export const config = { api: { bodyParser: false } };

async function readBody(req){
  if(req.body && typeof req.body === 'object'){
    return { parsed: req.body, raw: '', parsedByRuntime: true };
  }
  return new Promise(resolve=>{
    let raw='';
    req.on('data',c=>raw+=c.toString());
    req.on('end',()=>{
      const ct=(req.headers['content-type']||'').toLowerCase();
      if(ct.includes('json')){ try{ resolve({ parsed: JSON.parse(raw), raw, parsedByRuntime: false }); }catch{ resolve({ parsed: {}, raw, parsedByRuntime: false }); } }
      else{ try{ const p=new URLSearchParams(raw),o={}; for(const[k,v]of p)o[k]=v; resolve({ parsed: o, raw, parsedByRuntime: false }); }catch{ resolve({ parsed: {}, raw, parsedByRuntime: false }); } }
    });
    req.on('error',()=>resolve({ parsed:{}, raw:'', parsedByRuntime:false }));
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

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, telnyx-signature-ed25519, telnyx-timestamp');
  if(req.method==='OPTIONS') return res.status(200).end();

  const incoming=await readBody(req);
  if(process.env.TELNYX_PUBLIC_KEY && !incoming.parsedByRuntime){
    const sig = getTelnyxSignatureHeaders(req);
    const verified = verifyTelnyxSignature({ rawBody: incoming.raw, signature: sig.signature, timestamp: sig.timestamp });
    if(!verified.ok){
      return res.status(403).json({ ok:false, error:`invalid telnyx signature: ${verified.reason}` });
    }
  }
  const raw=incoming.parsed;
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

  /* ── OWNER TEXTING THE JARVIS LINE ─────────────────────────────
     The shared owner number belongs to NO tenant, so a text to it
     matches nothing (getTenantByPhone returns the demo fallback,
     id 000...000). When that happens AND the SENDER is a registered
     operator_phone, this is the owner texting their adviser: full
     conversational owner brain — live business snapshot, owner
     memory, operator-channel history — by text. Same continuous
     Jarvis, second transport. 10DLC STOP/START gates don't apply
     (this is the owner's own tool, not marketing), but the exchange
     is persisted to the same operator audit trail. */
  const DEMO_ID = '00000000-0000-0000-0000-000000000000';
  if(!row?.id || row.id === DEMO_ID){
    const ownerTenant = await getTenantByOperatorPhone(fromN).catch(()=>null);
    if(ownerTenant?.id){
      let conv=null, hist=[];
      try{
        conv = await getOrStartConversation(ownerTenant.id, { channel:'operator', agent:'jarvis' });
        if(conv?.id) hist = await getConversationHistory(conv.id, 10);
      }catch{}
      const brain = await answerOwner(ownerTenant, hist, text, { channel:'sms' });
      const reply = brain.ok ? brain.text
        : "I can text you your day, revenue, or who's due — or call me on this number to move, cancel, book, or blast by voice.";
      try{
        if(conv?.id){
          await logMessage({ conversationId: conv.id, tenantId: ownerTenant.id, role:'user', agent:'jarvis', content:text });
          await logMessage({ conversationId: conv.id, tenantId: ownerTenant.id, role:'assistant', agent:'jarvis', content:reply });
        }
        await logUsage(ownerTenant.id, 'operator_sms', 1);
      }catch{}
      try{ await sendSMS({ from: toN, to: fromN, text: reply, tenantId: ownerTenant.id, skipOptOut:true, type }); }catch{}
      return res.status(200).json({ ok:true, handled:'owner_chat' });
    }
  }

  if(!row?.id) return res.status(200).json({ok:true,ignored:'no_tenant'});
  // Admin control panel: a suspended/cancelled salon does not send/receive Lola texts.
  if(['suspended','cancelled'].includes(String(row.billing_status||''))){
    return res.status(200).json({ ok:true, handled:'suspended' });
  }
  // Plan entitlement: WhatsApp is a Pro/Med Spa channel (admin can unlock per tenant). SMS is on every plan.
  if(channel==='whatsapp' && !channelAllowed(row, 'whatsapp')){
    return res.status(200).json({ ok:true, handled:'whatsapp_not_on_plan' });
  }
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

  let client=null,conv=null,hist=[{role:'user',content:text}],clientProfile=null;
  try{
    if(fromN) client=await upsertClient(row.id,{phone:fromN});
    conv=await getOrStartConversation(row.id,{clientId:client?.id,channel,agent:'lola'});
    if(conv?.id){ const p=await getConversationHistory(conv.id,10); hist=[...p,{role:'user',content:text}]; }
    if(fromN){
      const rows = await getClientMemory(row.id, fromN);
      clientProfile = profileFromMemoryRows(rows);
    }
  }catch{}

  const signals = extractPersonalizationSignals(text);
  if(signals.hasSignal && fromN){
    try{
      clientProfile = mergeClientProfile(clientProfile, signals);
      await setClientMemory(row.id, fromN, 'profile', clientProfile);
      if(signals.feedback){
        await setClientMemory(row.id, fromN, 'last_feedback', {
          ...signals.feedback,
          at: new Date().toISOString()
        });
      }
    }catch{}
  }

  const intent = detectLolaIntent(text);
  const mood = detectConversationMood(text);
  // Lola runs her real front-desk skills (check availability, book, reschedule,
  // cancel) on text — the same tools the dashboard chat uses. If the agent or
  // LLM is unavailable, fall back to the deterministic reply so texts never go dark.
  let reply = '';
  try{
    const agent = await runLolaAgentReply({
      tenant: row,
      clientPhone: fromN,
      channel,
      system: buildLolaSystemPrompt({ tenant: row, channel, intent, mood, memoryBlock: buildClientMemoryBlock(clientProfile) }),
      messages: hist,
      maxTokens: 280
    });
    if(agent.ok && agent.text) reply = agent.text;
  }catch{}
  if(!reply){
    reply = deterministicSkillReply({
      tenant: row,
      intent,
      channel: 'sms',
      clientName: client?.name ? String(client.name).split(' ')[0] : ''
    }) || 'Thanks for texting! How can I help you book?';
  }

  try{
    const quality = evaluateInteractionQuality({
      intent,
      mood,
      personalized: !!signals.hasSignal || !!buildClientMemoryBlock(clientProfile),
      reply,
      userText: text,
      channel
    });
    await logUsage(row.id, 'interaction_quality', quality.score, {
      channel,
      level: quality.level,
      intent,
      mood
    });
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

