/**
 * /api/telnyx-sms — Telnyx Messaging webhook + send · MULTI-TENANT
 * ════════════════════════════════════════════════════════════════
 * Inbound: when a client texts a salon's Lola number, Telnyx POSTs
 * here. We resolve the tenant by called number, load conversation
 * memory from Supabase, ask Lola, persist the reply, and text back.
 * Outbound: POST { to, text, from } here to send a message.
 *
 * ENV VARS:
 *   ANTHROPIC_API_KEY
 *   TELNYX_API_KEY
 *   SUPABASE_URL · SUPABASE_SERVICE_KEY
 */

import {
  getTenantByPhone, upsertClient, getOrStartConversation,
  logMessage, getConversationHistory, logUsage, e164
} from './lib/db.js';

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
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'x-api-key':process.env.ANTHROPIC_API_KEY, 'anthropic-version':'2023-06-01' },
    body: JSON.stringify({ model:'claude-sonnet-4-6', max_tokens:200, system:systemPrompt(tenant), messages:history })
  });
  const data = await res.json();
  return data.content?.[0]?.text || "Thanks for texting! How can I help you book today?";
}

// Send an SMS via Telnyx
export async function sendSMS({ from, to, text, profileId }){
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

    // 2. Upsert client + find/start conversation thread
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

    // 3. Ask Lola
    const reply = await askLola(history, tenant);

    // 4. Persist this exchange
    if(conv?.id){
      try{
        await logMessage({ conversationId: conv.id, tenantId: tenantRow.id, role:'user', agent:'lola', content: text });
        await logMessage({ conversationId: conv.id, tenantId: tenantRow.id, role:'assistant', agent:'lola', content: reply });
        await logUsage(tenantRow.id, 'sms_received', 1);
        await logUsage(tenantRow.id, 'sms_sent', 1);
      }catch{}
    }

    // 5. Text the reply back
    try{ await sendSMS({ from: toNum, to: fromNum, text: reply }); }catch(e){}

    return res.status(200).json({ ok:true });
  }

  return res.status(200).json({ ok:true, ignored:true });
}
