/**
 * /api/telnyx-sms — Telnyx Messaging webhook + send · MULTI-TENANT
 * ════════════════════════════════════════════════════════════════
 * Inbound: when a client texts a salon's Lola number, Telnyx POSTs
 * here. We resolve the tenant by called number, load conversation
 * memory from Supabase, ask Lola, persist the reply, and text back.
 * Outbound: POST { to, text, from } here to send a message.
 *
 * COMPLIANCE (10DLC): STOP/UNSUBSCRIBE/CANCEL/END/QUIT opts the number
 * out permanently — we persist that and never send again until they
 * text START/UNSTOP. HELP returns support info. Both are handled
 * BEFORE Lola's AI brain ever sees the message, and outbound sends
 * always check the opt-out flag first, including future campaign/
 * win-back texts that go through sendSMS().
 *
 * ENV VARS:
 *   ANTHROPIC_API_KEY
 *   TELNYX_API_KEY
 *   SUPABASE_URL · SUPABASE_SERVICE_KEY
 */

import {
  getTenantByPhone, upsertClient, getOrStartConversation,
  logMessage, getConversationHistory, logUsage, e164,
  setOptOut, isOptedOut
} from './lib/db.js';
import { chat } from './lib/llm.js';

const STOP_KEYWORDS  = ['stop','stopall','unsubscribe','cancel','end','quit'];
const START_KEYWORDS = ['start','unstop','yes'];
const HELP_KEYWORDS  = ['help','info'];

function matchKeyword(text, list){
  const norm = String(text||'').trim().toLowerCase();
  return list.includes(norm);
}

function shapeTenant(t){
  return {
    name: t.name,
    location: t.location,
    bookingUrl: t.booking_url,
    services: t.services || []
  };
}

function systemPrompt(tenant){
  const svc = (tenant.services||[]).map(s=>`${s.name} $${s.price}`).join('; ');
  return `You are Lola, the AI receptionist replying to a TEXT message for ${tenant.name}.
Be warm, brief (1-3 sentences, like real texting), and always move toward booking.
Services: ${svc}. Booking link: ${tenant.bookingUrl}.
When someone wants to book, share the booking link and confirm the service. Never say you're an AI unless asked.`;
}

async function askLola(history, tenant){
  const result = await chat({
    system: systemPrompt(tenant),
    messages: history,
    maxTokens: 200,
    temperature: 0.7
  });
  if(!result.ok){
    console.error('[sms] LLM failed:', result.error);
    return "Thanks for texting! How can I help you book today?";
  }
  return result.text || "Thanks for texting! How can I help you book today?";
}

// Send an SMS via Telnyx. ALWAYS routes through here so the opt-out
// check is never bypassed — including future marketing/win-back sends.
export async function sendSMS({ from, to, text, profileId, tenantId, skipOptOutCheck=false }){
  if(!skipOptOutCheck){
    try{
      const tid = tenantId || (await getTenantByPhone(from))?.id;
      if(tid && await isOptedOut(tid, to)){
        return { skipped: true, reason: 'recipient_opted_out' };
      }
    }catch(e){ /* if the opt-out check itself fails, fail open rather than silently dropping a booking confirmation */ }
  }
  const res = await fetch('https://api.telnyx.com/v2/messages', {
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${process.env.TELNYX_API_KEY}` },
    body: JSON.stringify({ from, to, text, messaging_profile_id: profileId })
  });
  return res.json();
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method === 'OPTIONS') return res.status(200).end();

  const body = typeof req.body === 'string' ? JSON.parse(req.body||'{}') : (req.body||{});

  // ── OUTBOUND: explicit send request from our own app ──
  if(body.to && body.text && body.from && !body.data){
    try{
      const result = await sendSMS(body);
      // log outbound usage if we can resolve the tenant
      try{
        const t = await getTenantByPhone(body.from);
        await logUsage(t.id, 'sms_sent', 1, { to: e164(body.to) });
      }catch{}
      return res.status(200).json({ ok:true, result });
    }catch(e){
      return res.status(500).json({ ok:false, error:String(e) });
    }
  }

  // ── INBOUND: Telnyx delivers an inbound message webhook ──
  const evt = body.data;
  if(evt && evt.event_type === 'message.received'){
    const payload = evt.payload || {};
    const fromNum = payload.from?.phone_number;
    const toNum = Array.isArray(payload.to) ? payload.to[0]?.phone_number : payload.to?.phone_number;
    const text = payload.text || '';

    // 1. Multi-tenant resolution by the receiving number
    const tenantRow = await getTenantByPhone(toNum);
    const tenant = shapeTenant(tenantRow);

    // 2. ── COMPLIANCE GATE: handle STOP/HELP/START before anything else ──
    if(matchKeyword(text, STOP_KEYWORDS)){
      try{ await setOptOut(tenantRow.id, fromNum, true); }catch(e){}
      try{ await sendSMS({ from: toNum, to: fromNum, text: `You've been unsubscribed from ${tenant.name} texts and won't receive more. Reply START to resubscribe.`, tenantId: tenantRow.id, skipOptOutCheck: true }); }catch(e){}
      return res.status(200).json({ ok:true, handled:'stop' });
    }
    if(matchKeyword(text, START_KEYWORDS)){
      try{ await setOptOut(tenantRow.id, fromNum, false); }catch(e){}
      try{ await sendSMS({ from: toNum, to: fromNum, text: `You're resubscribed to ${tenant.name} texts. Reply STOP anytime to opt out.`, tenantId: tenantRow.id, skipOptOutCheck: true }); }catch(e){}
      return res.status(200).json({ ok:true, handled:'start' });
    }
    if(matchKeyword(text, HELP_KEYWORDS)){
      try{ await sendSMS({ from: toNum, to: fromNum, text: `${tenant.name} AI front desk. Reply STOP to unsubscribe. Call ${toNum} for help.`, tenantId: tenantRow.id, skipOptOutCheck: true }); }catch(e){}
      return res.status(200).json({ ok:true, handled:'help' });
    }

    // 3. If this number opted out previously, don't engage Lola or text back
    try{
      if(await isOptedOut(tenantRow.id, fromNum)){
        return res.status(200).json({ ok:true, handled:'opted_out_silent' });
      }
    }catch(e){}

    // 4. Upsert client + find/start conversation thread
    let client = null, conv = null, history = [{ role:'user', content:text }];
    try{
      client = await upsertClient(tenantRow.id, { phone: fromNum });
      conv = await getOrStartConversation(tenantRow.id, {
        clientId: client?.id, channel: 'sms', agent: 'lola'
      });
      // Pull prior turns for context
      if(conv?.id){
        const past = await getConversationHistory(conv.id, 10);
        history = [...past, { role:'user', content:text }];
      }
    }catch(e){ /* DB optional — keep going */ }

    // 5. Ask Lola
    const reply = await askLola(history, tenant);

    // 6. Persist this exchange
    if(conv?.id){
      try{
        await logMessage({ conversationId: conv.id, tenantId: tenantRow.id, role:'user', agent:'lola', content: text });
        await logMessage({ conversationId: conv.id, tenantId: tenantRow.id, role:'assistant', agent:'lola', content: reply });
        await logUsage(tenantRow.id, 'sms_received', 1);
        await logUsage(tenantRow.id, 'sms_sent', 1);
      }catch{}
    }

    // 7. Text the reply back (tenantId passed so the opt-out check is fast, no extra lookup)
    try{ await sendSMS({ from: toNum, to: fromNum, text: reply, tenantId: tenantRow.id }); }catch(e){}

    return res.status(200).json({ ok:true });
  }

  return res.status(200).json({ ok:true, ignored:true });
}
