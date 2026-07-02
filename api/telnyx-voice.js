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

  let tenant = null;
  try{ tenant = await getTenantByPhone(toN); }catch{}
  if(!tenant?.id){
    const xml = texmlSayAndGather({ say: 'Sorry, we cannot route this call yet. Please try again shortly.' });
    res.setHeader('Content-Type', 'application/xml');
    return res.status(200).send(xml);
  }

  // Cached synthesis for repeated lines — greeting, re-prompt, goodbye,
  // deterministic replies. First caller of the window pays ElevenLabs;
  // everyone after gets instant answer at zero tts_chars cost.
  async function speakCached(text){
    if(!elevenLabsConfigured() || !process.env.APP_URL) return '';
    const base = process.env.APP_URL.replace(/\/+$/,'');
    const key = crypto.createHash('sha1').update(`${process.env.ELEVENLABS_VOICE_ID||''}|${text}`).digest('hex');
    let id = getKeyedAudioId(key);
    if(!id){
      try{
        const audio = await synthesize(text);
        id = putAudioKeyed(key, audio);
        await logUsage(tenant.id, 'tts_chars', text.length, { source: 'voice' }).catch?.(()=>{});
      }catch(e){ console.error('[VOICE] cached synth failed:', String(e.message||e).slice(0,100)); return ''; }
    }
    return `${base}/api/voice-audio?id=${encodeURIComponent(id)}`;
  }

  // ── Silence path: Gather timed out and <Redirect> brought us back ──
  let silence = 0;
  try{ silence = parseInt(new URL(req.url, 'http://x').searchParams.get('silence') || '0', 10) || 0; }catch{}
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
      
      // Build enhanced system prompt with advanced features
      let systemPrompt = buildLolaSystemPrompt({
        tenant,
        channel: 'voice',
        intent,
        mood,
        memoryBlock: buildClientMemoryBlock(clientProfile)
      });
      
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
  const playUrl = await speakCached(reply);

  const xml = texmlSayAndGather({ say: reply, playUrl, hints: buildHints(tenant) });
  res.setHeader('Content-Type', 'application/xml');
  return res.status(200).send(xml);
}
