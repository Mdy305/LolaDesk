/**
 * /api/telnyx-sms — Telnyx SMS webhook · MULTI-TENANT + 10DLC compliant
 * Handles both API v1 (form-encoded) and API v2 (JSON) from Telnyx.
 */
import { getTenantByOperatorPhone, sameSalon, upsertClient, getClientMemory, setClientMemory, getOrStartConversation, logMessage, getConversationHistory, logUsage, e164, setOptOut, isOptedOut } from './lib/db.js';
import { resolveInboundTenant } from './lib/tenant-resolver.js';
// Imported (not only re-exported): a bare `export { … } from` does NOT make
// sendSMS usable inside this file, so every reply here used to throw silently.
import { sendSMS } from './lib/sms.js';
import { db } from './lib/db.js';
import { isHotLead, escalateLead, relayOwnerReply } from './lib/lead-relay.js';
export { sendSMS };
import { answerOwner } from './lib/owner-brain.js';
import { handleConfirmReply } from './lib/appointment-confirm.js';
import { handleCareText } from './lib/customer-care.js';
import { answerClient } from './lib/client-brain.js';
import { salonTz } from './lib/salon-time.js';
import { chat } from './lib/llm.js';
import { getTelnyxSignatureHeaders, verifyTelnyxSignature } from './lib/telnyx-signature.js';
import { buildClientMemoryBlock, buildLolaSystemPrompt, detectConversationMood, detectLolaIntent, deterministicSkillReply, evaluateInteractionQuality, extractPersonalizationSignals, mergeClientProfile, profileFromMemoryRows } from './lib/lola-skills.js';
import { moderateImage, analyzeHairPhoto } from './lib/lola-photo-analysis.js';


// Raw body for the Ed25519 signature check (Telnyx signs the exact bytes).
export const config = { api: { bodyParser: false } };

/** First time we see this Telnyx event? A retry of an answered (or still-answering) text is dropped;
 *  a retry of a run that crashed or timed out (>60s, never finished) is answered. */
async function firstTime(id){
  if(!id) return true;
  try{
    const c = db(); if(!c) return true;
    const seen = await c.from('telnyx_events').select('id,kind,created_at').eq('id', String(id)).maybeSingle().then((r) => r, () => ({ data: null }));
    if(seen?.data?.id){
      const stuck = seen.data.kind === 'sms:processing' && Date.now() - new Date(seen.data.created_at || 0).getTime() > 60e3;
      if(!stuck) return false;
      await c.from('telnyx_events').delete().eq('id', String(id)).then((r) => r, () => null);
    }
    const { error } = await c.from('telnyx_events').insert({ id: String(id), kind: 'sms:processing', created_at: new Date().toISOString() });
    if(!error) return true;
    if(String(error.code) === '23505' || /duplicate|unique/i.test(String(error.message))) return false;
    import('./lib/migrate.js').then((m) => m.ensureMigrations()).catch(() => {});   // table missing: create it for next time
    return true;
  }catch(_){ return true; }
}

const STOP=['stop','stopall','unsubscribe','cancel','end','quit'];
const START=['start','unstop'];   // not 'yes' — clients answer offers with yes
const HELP=['help','info'];
const kw=(t,l)=>l.includes(String(t||'').trim().toLowerCase());

async function readBody(req){
  if(req.body && typeof req.body === 'object'){
    return { parsed: req.body, raw: '', parsedByRuntime: true };
  }
  return new Promise(resolve=>{
    const chunks=[]; let raw='';
    req.on('data',c=>chunks.push(Buffer.isBuffer(c)?c:Buffer.from(c)));
    req.on('end',()=>{
      raw=Buffer.concat(chunks).toString('utf8');   // whole bytes: a split multi-byte character must not break the signature
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
    const mediaUrls = Array.isArray(p.media) ? p.media.map(m=>m?.url).filter(Boolean) : [];
    return { inbound:true, from:p.from?.phone_number||'', to:(Array.isArray(p.to)?p.to[0]?.phone_number:p.to?.phone_number)||'', text:p.text||'', type:p.type||'SMS', mediaUrls };
  }
  return { inbound:true, from:raw.From||raw.from||'', to:raw.To||raw.to||'', text:raw.Body||raw.text||'', type: 'SMS', mediaUrls: [] };
}

async function markDone(id){
  if(!id) return;
  try{ const c = db(); if(c) await c.from('telnyx_events').update({ kind: 'sms' }).eq('id', String(id)); }catch(_){}
}

export default async function handler(req,res){
  let eventId = null;
  const out = await handleText(req, res, (id) => { eventId = id; });   // a crash leaves it 'processing' → Telnyx's retry is answered
  if(eventId) await markDone(eventId);
  return out;
}

async function handleText(req,res,noteEvent){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, telnyx-signature-ed25519, telnyx-timestamp');
  if(req.method==='OPTIONS') return res.status(200).end();

  const incoming=await readBody(req);
  // Ed25519 signs Telnyx's v2 JSON webhooks; a legacy v1 (form) profile can't carry it — LolaDesk's
  // messaging heal moves the profile to v2, and only then is every text verified.
  const isJson = /json/i.test(String(req.headers?.['content-type'] || '')) || /^\s*\{/.test(incoming.raw || '');
  if(process.env.TELNYX_PUBLIC_KEY && !incoming.parsedByRuntime && isJson){
    const sig = getTelnyxSignatureHeaders(req);
    const verified = verifyTelnyxSignature({ rawBody: incoming.raw, signature: sig.signature, timestamp: sig.timestamp });
    if(!verified.ok){
      return res.status(403).json({ ok:false, error:`invalid telnyx signature: ${verified.reason}` });
    }
  }
  const raw=incoming.parsed;
  const body=extract(raw);

  // Delivery receipts (message.sent / message.finalized …) are not texts to answer.
  if(raw?.data?.event_type && raw.data.event_type !== 'message.received') return res.status(200).json({ ok:true, ignored: raw.data.event_type });
  if(!body.from || !body.to) return res.status(200).json({ ok:true, ignored:'no sender' });
  const evId = raw?.data?.payload?.id || raw?.data?.id || null;
  if(!(await firstTime(evId))) return res.status(200).json({ ok:true, duplicate:true });
  noteEvent(evId);

  const fromN=e164(body.from), toN=e164(body.to), text=body.text||'', type=body.type||'SMS';
  const isWhatsApp = String(type).toUpperCase() === 'WHATSAPP';
  const channel = isWhatsApp ? 'whatsapp' : 'sms';
  console.log(`[${channel}]`,{from:fromN,to:toN,text:text.slice(0,40)});

  // ── MULTI-TENANT ROUTING: strict number → tenant, never the demo salon ──
  const routing = await resolveInboundTenant({ to: toN, from: fromN }).catch(() => ({ status:'error', reason:'resolver-error', tenant:null }));
  let row = routing.status === 'resolved' ? routing.tenant : null;

  /* ── OWNER TEXTING THE SHARED JARVIS LINE ─────────────────────────────
     The shared owner number belongs to NO tenant, so a text to it resolves
     to 'not_found'. When that happens AND the SENDER is a registered
     operator_phone, this is the owner texting their adviser: full
     conversational owner brain — live business snapshot, owner memory,
     operator-channel history — by text. Same continuous Jarvis, second
     transport. 10DLC STOP/START gates don't apply (this is the owner's own
     tool, not marketing), but the exchange is persisted to the same
     operator audit trail. */
  if(!row){
    // LolaDesk's own support line: Lola answers questions about the app.
    try{
      const care = await handleCareText(db(), { to: toN, from: fromN, text }, { send: (m) => sendSMS({ ...m, type }) });
      if(care) return res.status(200).json({ ok:true, handled: care.handled });
    }catch(e){ console.warn('[care-sms]', String(e?.message||e).slice(0,120)); }
    // Owner only on LolaDesk's own owner line: a number no salon owns ('not_found' — never a salon's
    // disabled/ambiguous line), and when OWNER_LINE_NUMBER is configured, exactly that number. The
    // sender must be the operator phone of exactly ONE salon (getTenantByOperatorPhone is strict).
    const ownerLine = e164(process.env.OWNER_LINE_NUMBER || process.env.LOLADESK_OWNER_LINE || '');
    const onOwnerLine = routing.status === 'not_found' && (!ownerLine || ownerLine === toN);
    const ownerTenant = onOwnerLine ? await getTenantByOperatorPhone(fromN).catch(()=>null) : null;
    if(ownerTenant?.id){
      let conv=null, hist=[];
      try{
        conv = await getOrStartConversation(ownerTenant.id, { channel:'operator', agent:'jarvis', participant:'owner' });
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
    if(routing.status === 'disabled'){
      try{ await sendSMS({ from: toN, to: fromN, text: 'This number is not active yet. Please contact support.', skipOptOut: true, type }); }catch{}
    }
    return res.status(200).json({ ok:true, ignored:'no_tenant', routing: routing.status });
  }
  const tName=row.name;

  // ── The owner texting their own salon line ──
  // If a hot lead is open, the text goes to that client (Lola relays it).
  // Otherwise the owner is talking to Lola, their assistant — never treated as a client.
  // Owner = the sender is THIS salon's operator phone AND that phone belongs to exactly one salon
  // (this one). If another salon also lists the same cell, it's ambiguous → treated as a client:
  // a spoofed/shared number must never get the owner brain (business snapshot) or relay powers.
  // On the salon's OWN line the salon already trusts its own operator phone, so the cell may also be listed
  // on another (test / duplicate) salon without the owner losing their assistant here. The strict
  // one-salon rule only guards LolaDesk's shared owner line (above) and the owner voice line.
  const isOwnerText = !!(row.operator_phone && fromN && fromN === e164(row.operator_phone));
  if(isOwnerText){
    try{ const rel = await relayOwnerReply(db(), row, { text }); if(rel.handled) return res.status(200).json({ ok:true, handled:'owner_relay', sent: rel.sent }); }catch{}
    let conv=null, hist=[];
    try{ conv = await getOrStartConversation(row.id, { channel:'operator', agent:'jarvis', participant:'owner' }); if(conv?.id) hist = await getConversationHistory(conv.id, 10); }catch{}
    const brain = await answerOwner(row, hist, text, { channel:'sms' }).catch(()=>({ ok:false }));
    const reply = brain && brain.ok ? brain.text : "I can text you your day, revenue, or who's due. When a hot lead comes in, reply to my alert and I'll pass your message on.";
    try{ if(conv?.id){ await logMessage({ conversationId: conv.id, tenantId: row.id, role:'user', agent:'jarvis', content:text }); await logMessage({ conversationId: conv.id, tenantId: row.id, role:'assistant', agent:'jarvis', content:reply }); } }catch{}
    try{ await sendSMS({ from: toN, to: fromN, text: reply, tenantId: row.id, skipOptOut:true, type }); }catch{}
    return res.status(200).json({ ok:true, handled:'owner_chat' });
  }

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

  // A client answering "YES" to Lola's confirmation request: mark it confirmed, thank them.
  try{
    const tz = await salonTz(row.id).catch(()=> 'America/New_York');
    const conf = await handleConfirmReply(db(), row, fromN, text, { tz });
    if(conf){
      try{ await sendSMS({ from: toN, to: fromN, text: conf.reply, tenantId: row.id, type }); }catch{}
      try{ const cl = fromN ? await upsertClient(row.id,{ phone: fromN }) : null; const cv = await getOrStartConversation(row.id,{ clientId: cl?.id, channel, agent:'lola' }); if(cv?.id){ await logMessage({conversationId:cv.id,tenantId:row.id,role:'user',agent:'lola',content:text}); await logMessage({conversationId:cv.id,tenantId:row.id,role:'assistant',agent:'lola',content:conf.reply}); } await logUsage(row.id,'appointment_confirmed',1); }catch{}
      return res.status(200).json({ ok:true, handled:'confirmed', booking_id: conf.booking_id });
    }
  }catch{}

  let client=null,conv=null,hist=[{role:'user',content:text}],clientProfile=null;
  try{
    if(fromN) client=await upsertClient(row.id,{phone:fromN,whatsappEnabled:isWhatsApp});
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

  // Real vision-AI photo consultation — a client texting a hair photo is
  // exactly the kind of thing that should make Lola meaningfully smarter
  // than a generic booking bot, not just something she silently ignores.
  // Best-effort: any failure here falls through to the normal text-only
  // reply path untouched.
  let photoContext = '';
  if(body.mediaUrls?.length){
    try{
      const imageUrl = body.mediaUrls[0];
      const moderation = await moderateImage(imageUrl);
      if(moderation?.appropriate){
        const analysis = await analyzeHairPhoto(imageUrl, text, row.id);
        if(analysis && !analysis.error){
          photoContext = `\nCLIENT JUST SENT A PHOTO — real vision-AI analysis (use this, do not ignore the photo):\nCondition: ${analysis.condition||'unknown'}\nRisk level: ${analysis.riskLevel||'unknown'}\n${analysis.requiresConsultation ? 'This needs an in-person consultation before booking — say so warmly, do not just quote a price.' : ''}\n${analysis.notes ? 'Notes: '+analysis.notes : ''}`;
        }
      }
    }catch(e){ console.warn('[sms] Photo analysis failed, continuing text-only:', e.message); }
  }
  // One Lola: same memory and the same hands (check times, book, move, cancel) as on the phone.
  let reply = '';
  try{
    const tz = await salonTz(row.id).catch(()=> 'America/New_York');
    const prior = hist.slice(0, -1).filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string');
    const ans = await answerClient({ tenant: row, client, channel, text, history: prior, phone: fromN, tz, extra: photoContext });
    reply = ans.reply;
  }catch(e){ console.warn('[sms] client brain:', String(e?.message||e).slice(0,120)); }
  if(!reply){
    reply = deterministicSkillReply({ tenant: row, intent, channel: 'sms', clientName: client?.first_name || '' }) || 'Thanks for texting! What would you like to book?';
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

  // Something a person should close: text the owner, and tell the client they will.
  if(isHotLead(text)){
    try{
      const alert = await escalateLead(db(), row, { channel, phone: fromN, name: client?.name || '', text, conversationId: conv?.id || null });
      if(alert && alert.texted) reply = String(reply).trim() + ' I\u2019ve also let the owner know, so they can text you personally.';
    }catch{}
  }
  try{ await sendSMS({from:toN,to:fromN,text:reply,tenantId:row.id,type}); }catch(e){ console.error(`[${channel}] send err:`,e.message); }
  return res.status(200).json({ok:true});
}
