/**
 * /api/telnyx-voice — Telnyx Voice (TeXML) webhook
 * ════════════════════════════════════════════════════════════════
 * When someone calls a salon's Lola number, Telnyx hits this URL.
 * We return TeXML (XML) that makes Lola speak, listen, and book.
 *
 * SETUP (once):
 *   1. Telnyx Portal → Voice → Programmable Voice → Create TeXML App
 *   2. Set the Voice URL to:  https://YOUR-APP.vercel.app/api/telnyx-voice
 *   3. Method: POST
 *   4. Assign your purchased number to this TeXML app
 *
 * ENV VARS (Vercel → Settings → Environment Variables):
 *   ANTHROPIC_API_KEY   (Lola's brain)
 *   TELNYX_API_KEY      (for outbound actions, optional here)
 *
 * This handler is stateless across turns; conversation state rides
 * in the TeXML <Gather> "action" loop. Each caller turn POSTs the
 * transcribed speech back here, we ask Claude, and reply with TeXML.
 */

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>';

function texml(inner){
  return `${XML_HEADER}\n<Response>${inner}</Response>`;
}

function xmlEscape(s){
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Lola's voice persona for the phone. Telnyx supports many TTS voices;
// "Polly.Joanna-Neural" is a warm US female. Swap per-tenant if you like.
const LOLA_VOICE = 'Polly.Joanna-Neural';

function buildSystemPrompt(tenant){
  const svc = (tenant.services||[]).map(s=>`${s.name} $${s.price} (${s.duration||''})`).join('; ');
  return `You are Lola, the AI receptionist answering the phone for ${tenant.name}, a salon at ${tenant.location||''}.
You are warm, quick, and human — never robotic. Keep EVERY reply under 2 sentences because this is a live phone call. Always move toward booking.
Services: ${svc}.
Hours: ${tenant.hours||'Tue–Sat, Noon–8pm'}. Booking link: ${tenant.bookingUrl||''}.
If the caller wants to book, collect: service, day, and name — then confirm you'll text them the booking link. If they ask something you can't do, offer to take a message.
Never say you are an AI unless asked directly. Speak naturally, like the salon's best receptionist.`;
}

// Minimal in-call history is passed via Gather's "client_state" base64.
function decodeState(s){
  try { return JSON.parse(Buffer.from(s||'', 'base64').toString('utf8')); }
  catch { return { history: [] }; }
}
function encodeState(obj){
  return Buffer.from(JSON.stringify(obj)).toString('base64');
}

async function askLola(history, tenant){
  try{
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'x-api-key':process.env.ANTHROPIC_API_KEY, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({
        model:'claude-sonnet-4-6',
        max_tokens: 150,
        system: buildSystemPrompt(tenant),
        messages: history
      })
    });
    const data = await res.json();
    return data.content?.[0]?.text || "I'm sorry, could you say that again?";
  }catch(e){
    return "I'm having trouble hearing you — let me have someone call you right back.";
  }
}

// Resolve which salon this number belongs to.
// In production: look up tenant by the called number (To) in your DB.
// For now we return a default; wire your lookup here.
function resolveTenant(toNumber){
  return {
    name: 'MMΛ Salon',
    location: 'Miami Beach',
    hours: 'Tuesday to Saturday, noon to 8pm',
    bookingUrl: 'https://www.mmasalon.com/book',
    services: [
      { name:'Balayage', price:395, duration:'2h30' },
      { name:'Extensions', price:800, duration:'consult' },
      { name:'Hair Botox', price:325, duration:'2h' },
      { name:'Cut and Gloss', price:225, duration:'1h15' },
      { name:'Blowout', price:95, duration:'1h' }
    ]
  };
}

export default async function handler(req, res){
  res.setHeader('Content-Type', 'application/xml');

  // Telnyx posts application/x-www-form-urlencoded for TeXML
  const body = req.body || {};
  const callStatus = body.CallStatus || body.call_status;
  const speech = body.SpeechResult || body.Digits || '';
  const toNumber = body.To || body.to || '';
  const actionUrl = '/api/telnyx-voice';

  const tenant = resolveTenant(toNumber);
  let state = decodeState(body.client_state);
  if(!state.history) state.history = [];

  // ── First contact: greet, then gather speech ──
  if(!speech && (!callStatus || callStatus === 'ringing' || state.history.length === 0)){
    const greeting = `Hi, thanks for calling ${tenant.name}! This is Lola. How can I help you today?`;
    const xml = texml(
      `<Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" language="en-US">` +
      `<Say voice="${LOLA_VOICE}">${xmlEscape(greeting)}</Say>` +
      `</Gather>` +
      `<Say voice="${LOLA_VOICE}">I didn't catch that. Please call back anytime!</Say>`
    );
    return res.status(200).send(xml);
  }

  // ── Caller said something: ask Lola, reply, gather again ──
  state.history.push({ role:'user', content: speech || '(no response)' });
  const reply = await askLola(state.history, tenant);
  state.history.push({ role:'assistant', content: reply });

  // keep history small for latency
  if(state.history.length > 12) state.history = state.history.slice(-12);
  const nextState = encodeState(state);

  // If Lola signaled a booking, we could fire an SMS here with the link.
  // (see /api/telnyx-sms — call it server-side to text the caller.)

  const xml = texml(
    `<Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" language="en-US" client_state="${nextState}">` +
    `<Say voice="${LOLA_VOICE}">${xmlEscape(reply)}</Say>` +
    `</Gather>` +
    `<Say voice="${LOLA_VOICE}">Thanks for calling ${xmlEscape(tenant.name)}. Talk soon!</Say>` +
    `<Hangup/>`
  );
  return res.status(200).send(xml);
}
