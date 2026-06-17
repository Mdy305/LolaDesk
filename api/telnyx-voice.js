/**
 * /api/telnyx-voice — Telnyx Voice (TeXML) webhook · MULTI-TENANT
 * ════════════════════════════════════════════════════════════════
 * When someone calls a salon's Lola number, Telnyx hits this URL.
 * We look up which salon owns the called number, load context, ask
 * Claude, and reply with TeXML.
 *
 * VOICE: Lola speaks in her real ElevenLabs voice on every call — the
 * same voice as the dashboard's /api/speak — via TeXML's <Play>
 * verb, which fetches audio we synthesize and cache at /api/voice-audio.
 * If ElevenLabs is unreachable or misconfigured, we fall back to
 * Telnyx's built-in <Say> so a caller never hears dead air — but
 * normal operation should always use the real Lola voice.
 *
 * ENV VARS (Vercel → Settings → Environment Variables):
 *   ANTHROPIC_API_KEY / LLM_PROVIDER  Lola's brain
 *   TELNYX_API_KEY                   for outbound actions
 *   SUPABASE_URL / SUPABASE_SERVICE_KEY   multi-tenant lookup
 *   ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID   Lola's real voice
 *
 * Conversation memory persists to Supabase: Lola REMEMBERS every
 * caller across calls. State per-turn still rides in client_state for
 * speed; we mirror to DB at the end of each turn.
 */

import {
  getTenantByPhone, upsertClient, getOrStartConversation,
  endConversation, logMessage, getConversationHistory,
  logCall, logUsage, e164
} from './lib/db.js';
import { chat } from './lib/llm.js';
import { synthesize, isConfigured as elevenLabsConfigured } from './lib/elevenlabs.js';
import { putAudio } from './lib/tts-cache.js';

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>';

function texml(inner){
  return `${XML_HEADER}\n<Response>${inner}</Response>`;
}

function xmlEscape(s){
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Fallback-only voice — used ONLY if ElevenLabs synthesis fails on a
// live call, so a caller hears *something* instead of silence. This
// is never Lola's "real" voice; it's a safety net.
const FALLBACK_VOICE = 'Polly.Joanna-Neural';

function appBaseUrl(){
  return process.env.APP_URL || 'https://www.loladesk.com';
}

// Render one spoken line as TeXML: real Lola voice via <Play> when
// possible, otherwise <Say> with the fallback voice. Never throws —
// synthesis failures degrade gracefully instead of breaking the call.
async function speakLine(text){
  if(elevenLabsConfigured()){
    try{
      const buf = await synthesize(text);
      const id = putAudio(buf);
      return `<Play>${appBaseUrl()}/api/voice-audio?id=${id}</Play>`;
    }catch(e){
      console.error('[voice] ElevenLabs synthesis failed, falling back to Say:', String(e&&e.message||e));
    }
  }
  return `<Say voice="${FALLBACK_VOICE}">${xmlEscape(text)}</Say>`;
}

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
  const result = await chat({
    system: buildSystemPrompt(tenant),
    messages: history,
    maxTokens: 150,
    temperature: 0.7
  });
  if(!result.ok){
    console.error('[voice] LLM failed:', result.error);
    return "I'm having trouble hearing you — let me have someone call you right back.";
  }
  return result.text || "I'm sorry, could you say that again?";
}

// Resolve which salon this number belongs to.
// Map a tenant row (from DB) into the prompt-friendly shape buildSystemPrompt expects.
function shapeTenant(t){
  return {
    name: t.name,
    location: t.location,
    hours: t.hours,
    bookingUrl: t.booking_url,
    services: t.services || []
  };
}

export default async function handler(req, res){
  res.setHeader('Content-Type', 'application/xml');

  // Telnyx posts application/x-www-form-urlencoded for TeXML
  const body = req.body || {};
  const callStatus = body.CallStatus || body.call_status;
  const speech = body.SpeechResult || body.Digits || '';
  const toNumber = body.To || body.to || '';
  const fromNumber = body.From || body.from || '';
  const telnyxCallId = body.CallSid || body.call_control_id || '';
  const actionUrl = '/api/telnyx-voice';

  // ── 1. Resolve tenant by the called number (multi-tenant entry point) ──
  const tenantRow = await getTenantByPhone(toNumber);
  const tenant = shapeTenant(tenantRow);

  // ── 2. Find or create the client by caller number, get the open conversation ──
  let client = null, conversation = null;
  try{
    client = await upsertClient(tenantRow.id, { phone: fromNumber });
    conversation = await getOrStartConversation(tenantRow.id, {
      clientId: client?.id, channel: 'voice', agent: 'lola'
    });
  }catch(e){ /* DB optional — proceed with in-memory */ }

  // ── 3. Decode per-turn state (history fast-path) ──
  let state = decodeState(body.client_state);
  if(!state.history) state.history = [];
  if(!state.convId && conversation?.id) state.convId = conversation.id;

  // If first turn AND we have a DB, pull persistent memory from past calls
  if(state.history.length === 0 && conversation?.id){
    try{
      const past = await getConversationHistory(conversation.id, 8);
      if(past.length) state.history = past;
    }catch(e){}
  }

  // ── First contact: greet, then gather speech ──
  if(!speech && (!callStatus || callStatus === 'ringing' || state.history.length === 0)){
    const known = client?.name ? `, ${client.name.split(' ')[0]}` : '';
    const greeting = state.history.length > 0
      ? `Welcome back${known}! It's Lola. What can I help you with today?`
      : `Hi, thanks for calling ${tenant.name}! This is Lola. How can I help you today?`;
    const greetingTag = await speakLine(greeting);
    const noInputTag = await speakLine("I didn't catch that. Please call back anytime!");
    const xml = texml(
      `<Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" language="en-US" client_state="${encodeState(state)}">` +
      greetingTag +
      `</Gather>` +
      noInputTag
    );
    if(tenantRow?.id) try{ await logUsage(tenantRow.id, 'voice_call', 1, { source:'voice' }); }catch(e){}
    return res.status(200).send(xml);
  }

  // ── Caller said something: ask Lola, reply, gather again ──
  state.history.push({ role:'user', content: speech || '(no response)' });
  const reply = await askLola(state.history, tenant);
  state.history.push({ role:'assistant', content: reply });

  // Persist this turn to DB
  if(state.convId){
    try{
      await logMessage({ conversationId: state.convId, tenantId: tenantRow.id, role:'user', agent:'lola', content: speech || '(no response)' });
      await logMessage({ conversationId: state.convId, tenantId: tenantRow.id, role:'assistant', agent:'lola', content: reply });
      await logUsage(tenantRow.id, 'ai_token', 1, { source:'voice' });
      await logUsage(tenantRow.id, 'tts_chars', reply.length, { source:'voice', provider: elevenLabsConfigured() ? 'elevenlabs' : 'polly' });
    }catch(e){}
  }

  // keep history small for latency
  if(state.history.length > 12) state.history = state.history.slice(-12);
  const nextState = encodeState(state);

  const replyTag = await speakLine(reply);
  const closingTag = await speakLine(`Thanks for calling ${tenant.name}. Talk soon!`);
  const xml = texml(
    `<Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" language="en-US" client_state="${nextState}">` +
    replyTag +
    `</Gather>` +
    closingTag +
    `<Hangup/>`
  );
  return res.status(200).send(xml);
}
