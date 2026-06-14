/**
 * /api/telnyx-sms — Telnyx Messaging webhook + send
 * ════════════════════════════════════════════════════════════════
 * Inbound: when a client texts a salon's Lola number, Telnyx POSTs
 * here. We ask Lola and text the reply back.
 * Outbound: other code can POST { to, text, from } to this same
 * endpoint to send a message (e.g. booking confirmations).
 *
 * SETUP:
 *   1. Telnyx Portal → Messaging → create a Messaging Profile (API v2)
 *   2. Set its inbound webhook URL to:
 *        https://YOUR-APP.vercel.app/api/telnyx-sms
 *   3. Assign your number to that messaging profile
 *
 * ENV VARS:
 *   ANTHROPIC_API_KEY
 *   TELNYX_API_KEY
 */

// Simple per-number memory (resets on cold start; use Redis/DB in prod)
const memory = globalThis.__lolaSmsMemory || (globalThis.__lolaSmsMemory = new Map());

function resolveTenant(toNumber){
  return {
    name: 'MMΛ Salon',
    location: 'Miami Beach',
    bookingUrl: 'https://www.mmasalon.com/book',
    services: [
      { name:'Balayage', price:395 },
      { name:'Extensions', price:800 },
      { name:'Hair Botox', price:325 },
      { name:'Cut and Gloss', price:225 },
      { name:'Blowout', price:95 }
    ]
  };
}

function systemPrompt(tenant){
  const svc = tenant.services.map(s=>`${s.name} $${s.price}`).join('; ');
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
    body: JSON.stringify({
      from,                              // your Telnyx number, E.164
      to,                                // recipient, E.164
      text,
      messaging_profile_id: profileId    // optional
    })
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
      return res.status(200).json({ ok:true, result });
    }catch(e){
      return res.status(500).json({ ok:false, error:String(e) });
    }
  }

  // ── INBOUND: Telnyx delivers an inbound message webhook ──
  // Telnyx v2 webhook shape: { data: { event_type, payload: { from:{phone_number}, to:[{phone_number}], text } } }
  const evt = body.data;
  if(evt && evt.event_type === 'message.received'){
    const payload = evt.payload || {};
    const fromNum = payload.from?.phone_number;
    const toNum = Array.isArray(payload.to) ? payload.to[0]?.phone_number : payload.to?.phone_number;
    const text = payload.text || '';

    const tenant = resolveTenant(toNum);
    const key = `${toNum}:${fromNum}`;
    const history = memory.get(key) || [];
    history.push({ role:'user', content:text });

    const reply = await askLola(history, tenant);
    history.push({ role:'assistant', content:reply });
    if(history.length > 12) history.splice(0, history.length-12);
    memory.set(key, history);

    // text the reply back (Lola's number = the number they texted = toNum)
    try{ await sendSMS({ from: toNum, to: fromNum, text: reply }); }catch(e){}

    return res.status(200).json({ ok:true });
  }

  // delivery receipts / other events
  return res.status(200).json({ ok:true, ignored:true });
}
