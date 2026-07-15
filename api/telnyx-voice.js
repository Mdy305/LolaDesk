import {
  e164,
  findTenantByPhone,
  upsertClient,
  getClientMemory,
  setClientMemory,
  getOrStartConversation,
  getConversationHistory,
  logMessage,
  logUsage,
  logCall,
  getCallByTelnyxId,
  updateCallByTelnyxId
} from './lib/db.js';
import { chat } from './lib/llm.js';
import { synthesize, isConfigured as elevenLabsConfigured, registerForText } from './lib/elevenlabs.js';
import { putAudioKeyed, getKeyedAudioId } from './lib/tts-cache.js';
import { sendSMS } from './telnyx-sms.js';
import crypto from 'crypto';
import { getTelnyxSignatureHeaders, verifyTelnyxSignature } from './lib/telnyx-signature.js';
import { buildClientMemoryBlock, buildLolaSystemPrompt, detectConversationMood, detectLolaIntent, deterministicSkillReply, evaluateInteractionQuality, extractPersonalizationSignals, mergeClientProfile, profileFromMemoryRows } from './lib/lola-skills.js';
import { buildMCPToolsPrompt, executeMCPTool } from './lib/telnyx-mcp-integration.js';
import { getInCallMmsResult, buildMmsVisionPromptBlock } from './lib/telnyx-live-mms-vision.js';

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

/* ── TeXML builders ─────────────────────────────────────────────
   Three UX upgrades over the plain Play+Gather loop:

   1. ASR HINTS from the tenant's own menu. Telnyx speech recognition
      accepts a hints list; feeding it the salon's actual service
      names ("balayage", "brazilian blowout", "dermaplaning") plus
      core booking vocabulary makes it hear THIS salon's callers
      dramatically better than a generic model. Unknown attributes
      are ignored by the parser, so this degrades safely.

   2. NO MORE DEAD-AIR HANGUPS. Gather only posts back when speech is
      heard; on silence the document used to simply end — the caller
      got dropped without a goodbye. Now silence falls through to a
      <Redirect> back into this handler with a silence counter:
      first silence → warm "are you still there?" re-prompt; second
      → graceful goodbye + missed-call TEXT-BACK (below) + <Hangup/>.

   3. MISSED-CALL TEXT-BACK — the single biggest revenue-recovery
      move a salon line can make. A caller who went silent or gave up
      gets an instant SMS from Lola's same number inviting them to
      book by text. The lead that used to evaporate lands in the
      Inbox as a warm conversation instead. Opt-outs are respected
      (sendSMS checks the opt-out table) and each send is logged as
      a usage event for billing.
   ───────────────────────────────────────────────────────────── */
function buildHints(tenant){
  const services = [];
  try{
    const list = Array.isArray(tenant?.services) ? tenant.services
      : (typeof tenant?.services === 'string' ? JSON.parse(tenant.services) : []);
    for(const s of list||[]) services.push(String(s?.name || s).toLowerCase());
  }catch{}
  const core = ['appointment','booking','book','reschedule','cancel','price','how much','availability','today','tomorrow','next week','morning','afternoon'];
  return [...new Set([...services, ...core])].filter(Boolean).slice(0, 40).join(', ');
}

function texmlSayAndGather({ say, playUrl, hints = '', silence = 0, hangupAfter = false }){
  const speakBlock = playUrl
    ? `<Play>${escapeXml(playUrl)}</Play>`
    : `<Say voice="Polly.Joanna-Neural">${escapeXml(say)}</Say>`;
  if(hangupAfter){
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${speakBlock}
  <Hangup/>
</Response>`;
  }
  const hintsAttr = hints ? ` hints="${escapeXml(hints)}"` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${speakBlock}
  <Gather input="speech" language="en-US" timeout="6" speechTimeout="auto"${hintsAttr} action="/api/telnyx-voice" method="POST"/>
  <Redirect method="POST">/api/telnyx-voice?silence=${silence + 1}</Redirect>
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
  if(!toN){
    const xml = texmlSayAndGather({ say: 'Sorry, we could not verify this number yet. Please try again shortly.', hangupAfter: true });
    res.setHeader('Content-Type', 'application/xml');
    return res.status(200).send(xml);
  }

  let tenant = null;
  try{ tenant = await findTenantByPhone(toN, { allowDemoFallback:false }); }catch{}
  if(!tenant?.id){
    const xml = texmlSayAndGather({ say: 'Sorry, we cannot route this call yet. Please try again shortly.', hangupAfter: true });
    res.setHeader('Content-Type', 'application/xml');
    return res.status(200).send(xml);
  }

  // Cached synthesis for repeated lines — greeting, re-prompt, goodbye,
  // deterministic replies. First caller of the window pays ElevenLabs;
  // everyone after gets instant answer at zero tts_chars cost.
  async function speakCached(text, register){
    if(!elevenLabsConfigured() || !process.env.APP_URL) return '';
    const reg = register || registerForText(text);
    const base = process.env.APP_URL.replace(/\/+$/,'');
    const key = crypto.createHash('sha1').update(`${process.env.ELEVENLABS_VOICE_ID||''}|${reg}|${text}`).digest('hex');
    let id = getKeyedAudioId(key);
    if(!id){
      try{
        const audio = await synthesize(text, { register: reg });
        id = putAudioKeyed(key, audio);
        await logUsage(tenant.id, 'tts_chars', text.length, { source: 'voice' }).catch?.(()=>{});
      }catch(e){ console.error('[VOICE] cached synth failed:', String(e.message||e).slice(0,100)); return ''; }
    }
    return `${base}/api/voice-audio?id=${encodeURIComponent(id)}`;
  }

  // ── Silence path: Gather timed out and <Redirect> brought us back ──
  let silence = 0, continueText = '';
  try{
    const sp = new URL(req.url, 'http://x').searchParams;
    silence = parseInt(sp.get('silence') || '0', 10) || 0;
    const c = sp.get('continue');
    if(c) continueText = Buffer.from(c, 'base64url').toString('utf8').slice(0, 600);
  }catch{}
  if(silence > 0){
    if(silence === 1){
      // One gentle re-prompt before letting anyone go — a human
      // receptionist doesn't hang up at the first pause either.
      const say = `Are you still there? I'm happy to help with booking, prices, or anything else.`;
      const xml = texmlSayAndGather({ say, playUrl: await speakCached(say), hints: buildHints(tenant), silence });
      res.setHeader('Content-Type', 'application/xml');
      return res.status(200).send(xml);
    }
    // Second silence: warm goodbye + missed-call text-back, then hang up.
    const bye = `No worries — I'll text you so you can book whenever suits you. Bye for now!`;
    if(fromN){
      try{
        const textback = `Hi, it's Lola from ${tenant.name} 💗 Sorry we got cut off! I can book you right here — just tell me the service and a day that works.`;
        const r = await sendSMS({ from: toN, to: fromN, text: textback, tenantId: tenant.id });
        if(!r?.skipped){
          await logUsage(tenant.id, 'sms_sent', 1, { source: 'missed_call_textback' });
          await logUsage(tenant.id, 'textback_sent', 1);
        }
      }catch(e){ console.error('[VOICE] textback failed:', e.message); }
    }
    const xml = texmlSayAndGather({ say: bye, playUrl: await speakCached(bye), hangupAfter: true });
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

  let speech = String(payload.speechResult || '').trim();
  let reply = '';

  const telnyxCallId = payload.callSid || payload.callControlId || '';
  if(continueText && !speech) speech = continueText; // second leg of the instant-ack flow
  if(!speech){
    const name = client?.name ? ` ${client.name.split(' ')[0]}` : '';
    reply = `Hi${name}, this is Lola at ${tenant.name}. How can I help you today?`;
    // The Calls page is where owners SEE Lola earning her keep — a call
    // row per answered call, filled in turn by turn below.
    try{
      if(telnyxCallId && !(await getCallByTelnyxId(tenant.id, telnyxCallId))){
        await logCall({ tenantId: tenant.id, conversationId: conversation?.id, clientId: client?.id,
          fromNumber: fromN, toNumber: toN, direction: 'inbound', outcome: 'answered',
          transcript: '', telnyxCallId });
      }
    }catch{}
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

    /* ── NO DEAD AIR, EVER ─────────────────────────────────────────
       The single biggest machine "tell" is the 2–4s of silence while
       the LLM thinks and the voice renders. Humans never go silent —
       they say "mm, let me check…" within a heartbeat. So: if the
       answer needs the LLM (no deterministic reply), we respond to
       Telnyx IMMEDIATELY with a short cached acknowledgment and a
       <Redirect> that carries the caller's words back to us; the
       second leg does the real thinking WHILE the ack is playing.
       Perceived response time: under half a second, every turn.
       (Deterministic answers skip this — they're already instant.) */
    const isContinuation = !!continueText;
    if(!reply && !isContinuation){
      const ACKS = [
        `Mm-hm, one sec…`,
        `Sure — let me check that for you…`,
        `Okay, give me just a second…`,
        `Got it — one moment…`
      ];
      const ack = ACKS[(String(payload.callSid||fromN).split('').reduce((a,c)=>a+c.charCodeAt(0),0) + speech.length) % ACKS.length];
      const state = Buffer.from(speech).toString('base64url');
      const ackUrl = await speakCached(ack, 'warm');
      const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  ${ackUrl ? `<Play>${escapeXml(ackUrl)}</Play>` : `<Say voice="Polly.Joanna-Neural">${escapeXml(ack)}</Say>`}\n  <Redirect method="POST">/api/telnyx-voice?continue=${state}</Redirect>\n</Response>`;
      res.setHeader('Content-Type', 'application/xml');
      return res.status(200).send(xml);
    }

    let history = [];
    try{
      if(conversation?.id) history = await getConversationHistory(conversation.id, 10);
    }catch{}
    if(!reply){
      const messages = [...history, { role: 'user', content: speech }];
      
      // Build enhanced system prompt with advanced features
      let systemPrompt = buildLolaSystemPrompt({
        tenant,
        channel: 'voice',
        intent,
        mood,
        memoryBlock: buildClientMemoryBlock(clientProfile)
      });
      
      // ── SPOKEN HUMANITY — how a person sounds, not a system ──
      systemPrompt += `\nHOW YOU SPEAK (this is a live phone call):
- Contractions always: "you're", "we've", "can't". One thought per sentence. Two sentences is usually perfect; three max.
- Vary how you open — never start consecutive replies the same way. Tiny natural interjections ("Oh nice!", "Mm, good question") sparingly, only when they'd be genuine.
- Use the caller's first name occasionally when you know it — once every few turns, never every turn.
- Mirror their energy: excited caller gets lift, stressed caller gets calm and unhurried.
- Refer back to what THEY said earlier in this call — it's what listening sounds like.
- Say numbers like a person: "three ninety-five", "two thirty tomorrow afternoon".
- Never sound like a list or a menu. If offering options, weave them into one flowing sentence.`;

      // Add MCP tools availability to system prompt
      systemPrompt += '\n' + buildMCPToolsPrompt();
      
      // Add MMS vision results if available
      const mmsResult = getInCallMmsResult(payload.callControlId);
      if(mmsResult){
        systemPrompt += '\n' + buildMmsVisionPromptBlock(mmsResult);
      }
      
      try{
        const ai = await chat({
          system: systemPrompt,
          messages,
          maxTokens: 220,
          temperature: 0.5,
          source: 'voice'
        });
        
       if(ai.ok && ai.text){
         reply = ai.text.trim();
          
         // Check if LLM requested a tool invocation (MCP)
         const toolMatch = reply.match(/\[TOOL:\s*(\w+)\s*\{([^}]*)\}\]/);
         if(toolMatch){
           const toolName = toolMatch[1];
           try{
             const params = JSON.parse('{' + toolMatch[2] + '}');
             const toolResult = await executeMCPTool(toolName, params, tenant.id);
              
             // Refine reply with tool result
             const refinedMessages = [
               ...messages,
               { role: 'assistant', content: reply },
               { role: 'user', content: `Tool "${toolName}" returned: ${JSON.stringify(toolResult)}` }
             ];
              
             const refined = await chat({
               system: systemPrompt,
               messages: refinedMessages,
               maxTokens: 200,
               temperature: 0.5,
               source: 'voice'
             });
              
             if(refined.ok && refined.text){
               reply = refined.text.trim();
             }
           }catch(e){
             console.error(`[MCP] Tool execution error: ${e.message}`);
             // Fall back to original reply
           }
         }
       }
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
      // keep the call record alive: rolling transcript + outcome upgrades
      try{
        if(telnyxCallId && speech){
          const call = await getCallByTelnyxId(tenant.id, telnyxCallId);
          if(call){
            const line = `Caller: ${speech}\nLola: ${reply}\n`;
            const patch = { transcript: String(call.transcript || '') + line };
            const booked = /\b(book(ed)?|confirmed|see you (on|at))\b/i.test(reply) && /\b(book|appointment|come in|schedule)\b/i.test(speech);
            if(booked && call.outcome !== 'booked') patch.outcome = 'booked';
            await updateCallByTelnyxId(tenant.id, telnyxCallId, patch);
          }
        }
      }catch{}
    }catch{}
  }

  // Synthesis via the keyed cache: the greeting, re-prompts, and
  // deterministic skill replies repeat constantly across calls — they
  // synthesize once per cache window and replay instantly (faster
  // answer, zero repeated ElevenLabs spend). Unique LLM replies simply
  // pass through the same path. <Say> fallback preserved when empty.
  if(!elevenLabsConfigured() || !process.env.APP_URL){
    const missing = [];
    if(!process.env.ELEVENLABS_API_KEY) missing.push('ELEVENLABS_API_KEY');
    if(!process.env.ELEVENLABS_VOICE_ID) missing.push('ELEVENLABS_VOICE_ID');
    if(!process.env.APP_URL) missing.push('APP_URL');
    console.warn(`[VOICE] ElevenLabs not configured. Missing: ${missing.join(', ')}`);
  }
  // clean for the mouth: no markdown, no newlines, spoken-length cap
  reply = String(reply).replace(/[*_#`]/g,'').replace(/\s*\n+\s*/g,' ').slice(0, 420).trim();
  const playUrl = await speakCached(reply, registerForText(reply));

  const xml = texmlSayAndGather({ say: reply, playUrl, hints: buildHints(tenant) });
  res.setHeader('Content-Type', 'application/xml');
  return res.status(200).send(xml);
}
