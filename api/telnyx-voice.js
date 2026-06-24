import {
  e164,
  getTenantByPhone,
  upsertClient,
  getClientMemory,
  setClientMemory,
  getOrStartConversation,
  getConversationHistory,
  logMessage,
  logUsage
} from './lib/db.js';
import { chat } from './lib/llm.js';
import { synthesize, isConfigured as elevenLabsConfigured } from './lib/elevenlabs.js';
import { putAudio } from './lib/tts-cache.js';
import { getTelnyxSignatureHeaders, verifyTelnyxSignature } from './lib/telnyx-signature.js';
import { buildClientMemoryBlock, buildLolaSystemPrompt, detectConversationMood, detectLolaIntent, deterministicSkillReply, evaluateInteractionQuality, extractPersonalizationSignals, mergeClientProfile, profileFromMemoryRows } from './lib/lola-skills.js';

function escapeXml(value=''){
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function readBody(req){
  if(req.body && typeof req.body === 'object'){
    return { parsed: req.body, raw: '', parsedByRuntime: true };
  }
  return new Promise(resolve => {
    let raw = '';
    req.on('data', c => raw += c.toString());
    req.on('end', () => {
      const ct = String(req.headers['content-type'] || '').toLowerCase();
      if(ct.includes('application/json')){
        try{ return resolve({ parsed: JSON.parse(raw), raw, parsedByRuntime: false }); }catch{ return resolve({ parsed: {}, raw, parsedByRuntime: false }); }
      }
      if(ct.includes('application/x-www-form-urlencoded')){
        try{
          const p = new URLSearchParams(raw);
          const obj = {};
          for(const [k,v] of p.entries()) obj[k] = v;
          return resolve({ parsed: obj, raw, parsedByRuntime: false });
        }catch{
          return resolve({ parsed: {}, raw, parsedByRuntime: false });
        }
      }
      resolve({ parsed: {}, raw, parsedByRuntime: false });
    });
    req.on('error', () => resolve({ parsed: {}, raw: '', parsedByRuntime: false }));
  });
}

function extractVoicePayload(parsed){
  const p = parsed?.data?.payload || parsed || {};
  return {
    callControlId: p.call_control_id || parsed?.call_control_id || '',
    from: p.from || p.From || parsed?.From || parsed?.from || '',
    to: p.to || p.To || parsed?.To || parsed?.to || '',
    speechResult: p.speech_result || p.SpeechResult || parsed?.SpeechResult || parsed?.speech_result || parsed?.speech || '',
    callSid: p.call_leg_id || p.call_session_id || parsed?.CallSid || parsed?.call_sid || ''
  };
}

function texmlSayAndGather({ say, playUrl }){
  const speakBlock = playUrl
    ? `<Play>${escapeXml(playUrl)}</Play>`
    : `<Say voice="Polly.Joanna-Neural">${escapeXml(say)}</Say>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${speakBlock}
  <Gather input="speech" language="en-US" timeout="6" speechTimeout="auto" action="/api/telnyx-voice" method="POST"/>
</Response>`;
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, telnyx-signature-ed25519, telnyx-timestamp');
  if(req.method === 'OPTIONS') return res.status(200).end();
  if(req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const incoming = await readBody(req);
  if(process.env.TELNYX_PUBLIC_KEY && !incoming.parsedByRuntime){
    const sig = getTelnyxSignatureHeaders(req);
    const verified = verifyTelnyxSignature({ rawBody: incoming.raw, signature: sig.signature, timestamp: sig.timestamp });
    if(!verified.ok){
      return res.status(403).json({ error: `invalid telnyx signature: ${verified.reason}` });
    }
  }
  const parsed = incoming.parsed;

  const payload = extractVoicePayload(parsed);
  const toN = e164(payload.to);
  const fromN = e164(payload.from);

  let tenant = null;
  try{ tenant = await getTenantByPhone(toN); }catch{}
  if(!tenant?.id){
    const xml = texmlSayAndGather({ say: 'Sorry, we cannot route this call yet. Please try again shortly.' });
    res.setHeader('Content-Type', 'application/xml');
    return res.status(200).send(xml);
  }

  let client = null;
  let conversation = null;
  let clientProfile = null;
  try{
    client = fromN ? await upsertClient(tenant.id, { phone: fromN }) : null;
    conversation = await getOrStartConversation(tenant.id, { clientId: client?.id, channel: 'voice', agent: 'lola' });
    if(fromN){
      const rows = await getClientMemory(tenant.id, fromN);
      clientProfile = profileFromMemoryRows(rows);
    }
  }catch{}

  const speech = String(payload.speechResult || '').trim();
  let reply = '';

  if(!speech){
    const name = client?.name ? ` ${client.name.split(' ')[0]}` : '';
    reply = `Hi${name}, this is Lola at ${tenant.name}. How can I help you today?`;
  }else{
    const intent = detectLolaIntent(speech);
    const mood = detectConversationMood(speech);
    const signals = extractPersonalizationSignals(speech);
    if(signals.hasSignal && fromN){
      try{
        clientProfile = mergeClientProfile(clientProfile, signals);
        await setClientMemory(tenant.id, fromN, 'profile', clientProfile);
        if(signals.feedback){
          await setClientMemory(tenant.id, fromN, 'last_feedback', {
            ...signals.feedback,
            at: new Date().toISOString()
          });
        }
      }catch{}
    }
    reply = deterministicSkillReply({
      tenant,
      intent,
      channel: 'voice',
      clientName: client?.name ? String(client.name).split(' ')[0] : ''
    });

    let history = [];
    try{
      if(conversation?.id) history = await getConversationHistory(conversation.id, 10);
    }catch{}
    if(!reply){
      const messages = [...history, { role: 'user', content: speech }];
      try{
        const ai = await chat({
          system: buildLolaSystemPrompt({
            tenant,
            channel: 'voice',
            intent,
            mood,
            memoryBlock: buildClientMemoryBlock(clientProfile)
          }),
          messages,
          maxTokens: 220,
          temperature: 0.5,
          source: 'voice'
        });
        reply = ai.ok && ai.text ? ai.text.trim() : '';
      }catch{}
    }
    if(!reply) reply = 'Got it. I can help with that. What day works best for you?';

    try{
      const quality = evaluateInteractionQuality({
        intent,
        mood,
        personalized: !!signals.hasSignal || !!buildClientMemoryBlock(clientProfile),
        reply,
        userText: speech,
        channel: 'voice'
      });
      await logUsage(tenant.id, 'interaction_quality', quality.score, {
        channel: 'voice',
        level: quality.level,
        intent,
        mood
      });
    }catch{}
  }

  if(conversation?.id){
    try{
      if(speech){
        await logMessage({ conversationId: conversation.id, tenantId: tenant.id, role: 'user', agent: 'lola', content: speech });
      }
      await logMessage({ conversationId: conversation.id, tenantId: tenant.id, role: 'assistant', agent: 'lola', content: reply });
      await logUsage(tenant.id, 'voice_call', 1, { call_control_id: payload.callControlId || '', call_sid: payload.callSid || '' });
      await logUsage(tenant.id, 'ai_token', 1, { source: 'voice' });
    }catch{}
  }

  let playUrl = '';
  let synthesisError = '';
  
  // CRITICAL: Always attempt ElevenLabs before falling back to Polly
  if(elevenLabsConfigured() && process.env.APP_URL){
    try{
      const audio = await synthesize(reply);
      const id = putAudio(audio);
      playUrl = `${process.env.APP_URL.replace(/\/+$/,'')}/api/voice-audio?id=${encodeURIComponent(id)}`;
    }catch(e){
      synthesisError = String(e.message || e).slice(0, 100);
      console.error(`[VOICE] ElevenLabs synthesis failed for tenant ${tenant.id}: ${synthesisError}`);
    }
  }else{
    const missing = [];
    if(!process.env.ELEVENLABS_API_KEY) missing.push('ELEVENLABS_API_KEY');
    if(!process.env.ELEVENLABS_VOICE_ID) missing.push('ELEVENLABS_VOICE_ID');
    if(!process.env.APP_URL) missing.push('APP_URL');
    console.warn(`[VOICE] ElevenLabs not configured. Missing: ${missing.join(', ')}`);
  }

  const xml = texmlSayAndGather({ say: reply, playUrl });
  res.setHeader('Content-Type', 'application/xml');
  return res.status(200).send(xml);
}
