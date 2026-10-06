import { resolveInboundTenant } from './lib/tenant-resolver.js';
import { db,
  e164,
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
import { synthesize, isConfigured as elevenLabsConfigured } from './lib/elevenlabs.js';
// tts-cache.js is now a stub — Supabase Storage logic is inline below
import { sendSMS } from './telnyx-sms.js';
import { missedCallTextbackText, smsGreeting } from './lib/lola-persona.js';
import crypto from 'crypto';
import { readWebhookBody, checkTelnyxSignature } from './lib/webhook-body.js';
import { serviceGate, logCostSafe, voiceMinuteCents, ttsCents } from './lib/paid-hooks.js';
import { textBackOnce } from './lib/textback.js';
import { withStopLine } from './lib/legal.js';
import { buildClientMemoryBlock, buildLolaSystemPrompt, detectConversationMood, detectLolaIntent, deterministicSkillReply, evaluateInteractionQuality, extractPersonalizationSignals, mergeClientProfile, profileFromMemoryRows } from './lib/lola-skills.js';
import { answerClient } from './lib/client-brain.js';
import { getInCallMmsResult, buildMmsVisionPromptBlock } from './lib/telnyx-live-mms-vision.js';

function escapeXml(value=''){
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Telnyx signs the exact bytes of every TeXML request: read them raw (no runtime body parsing)
// and verify them whenever TELNYX_PUBLIC_KEY is set.
export const config = { api: { bodyParser: false } };

function extractVoicePayload(parsed){
  const p = parsed?.data?.payload || parsed || {};
  return {
    callControlId: p.call_control_id || parsed?.call_control_id || '',
    from: p.from || p.From || parsed?.From || parsed?.from || '',
    to: p.to || p.To || parsed?.To || parsed?.to || '',
    speechResult: p.speech_result || p.SpeechResult || parsed?.SpeechResult || parsed?.speech_result || parsed?.speech || '',
    digits: String(p.digits || p.Digits || parsed?.Digits || parsed?.digits || '').replace(/[^0-9*#]/g, ''),
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
const SYNTH_TRY_MS = 3500;     // one ElevenLabs request
const SYNTH_BUDGET_MS = 6000;  // all tries for one line of speech

export function keypadWords(d){
  const digits = String(d || '').replace(/[^0-9*#]/g, '').replace(/#$/, '');
  if(!digits) return '';
  if(/^\d{10,11}$/.test(digits)) return `(typed on the keypad) My number is ${digits}.`;
  if(digits === '1') return '(pressed 1 on the keypad) Yes.';
  if(digits === '2') return '(pressed 2 on the keypad) No.';
  if(digits === '0') return '(pressed 0 on the keypad) I\'d like to talk to someone at the salon.';
  if(digits === '*') return '(pressed * on the keypad) Can you repeat that?';
  return `(typed on the keypad) ${digits}`;
}

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
  // ONE LOLA, ONE VOICE — never a substitute. If Lola's canonical voice
  // can't be produced, fail loudly instead of speaking in a Polly voice.
  if(!playUrl){
    // ONE voice: if hers can't be produced right now, never a robot voice — end the call cleanly
    // (the caller gets a text from Lola instead; see voiceDown below).
    console.error('[VOICE] Lola\'s voice unavailable (ElevenLabs or the voice-audio bucket) — ending the call cleanly.');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Hangup/>\n</Response>`;
  }
  const speakBlock = `<Play>${escapeXml(playUrl)}</Play>`;
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
  <Gather input="dtmf speech" finishOnKey="#" language="en-US" timeout="6" speechTimeout="auto"${hintsAttr} action="/api/telnyx-voice" method="POST"/>
  <Redirect method="POST">/api/telnyx-voice?silence=${silence + 1}</Redirect>
</Response>`;
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, telnyx-signature-ed25519, telnyx-timestamp');
  if(req.method === 'OPTIONS') return res.status(200).end();
  if(req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  // Top-level try-catch: any crash returns a loud 502 (never a substitute
  // voice) so the failure is visible in Vercel logs and the Telnyx dashboard.
  try{
  const incoming = await readWebhookBody(req);
  // Every content type (TeXML posts form-urlencoded), whenever TELNYX_PUBLIC_KEY is set. It used to be
  // skipped whenever the runtime had parsed the body — i.e. always on Vercel.
  const verified = checkTelnyxSignature(req, incoming, { texml: true });
  if(!verified.ok){
    return res.status(403).json({ error: `invalid telnyx signature: ${verified.reason}` });
  }
  const parsed = incoming.parsed;
  // The call line's status callback lands here too: a finished call is not a new caller.
  const callStatus = String(parsed?.CallStatus || parsed?.call_status || '').toLowerCase();
  if(/^(completed|busy|failed|no-answer|canceled)$/.test(callStatus)){
    // The call is over: its transcript + summary land on the Calls screen and in the salon's email.
    if(callStatus === 'completed'){
      try{
        const sid = String(parsed?.CallSid || parsed?.call_sid || '');
        const routed = await resolveInboundTenant({ to: e164(parsed?.To || parsed?.to || '') });
        // What the call cost the salon's line (minutes, rounded up). Silent if billing isn't deployed.
        const secs = Number(parsed?.CallDuration || parsed?.call_duration || 0);
        if(secs > 0 && routed?.status === 'resolved' && routed.tenant?.id){
          await logCostSafe(routed.tenant.id, 'cost_voice_minutes', voiceMinuteCents(secs), { call_sid: sid || null, seconds: secs, source: 'texml' });
        }
        const c = db();
        if(sid && routed?.status === 'resolved' && routed.tenant && c){
          const call = await getCallByTelnyxId(routed.tenant.id, sid);
          const { parseLines, summarize, reportConversation } = await import('./lib/conversation-report.js');
          const turns = parseLines(call?.recording_url || '');
          if(call && turns.length){
            const booked = call.status === 'booked' || call.outcome === 'booked';
            const summary = await summarize(turns, { salon: routed.tenant.name, booked });
            await reportConversation(c, routed.tenant, { turns, summary, booked, key: 'texml:' + sid, channel: 'phone', callControlId: sid,
              fromNumber: call.from_number || parsed?.From || null, toNumber: call.to_number || parsed?.To || null, durationSeconds: Number(parsed?.CallDuration || 0) || null });
          }
        }
      }catch(e){ console.warn('[VOICE] call report:', String(e?.message || e).slice(0, 160)); }
    }
    res.setHeader('Content-Type', 'application/xml');
    return res.status(200).send('<?xml version="1.0" encoding="UTF-8"?>\n<Response/>');
  }

  const payload = extractVoicePayload(parsed);
  const toN = e164(payload.to);
  const fromN = e164(payload.from);

  // ── Lola's voice on the phone: ElevenLabs, cached in Supabase Storage ──
  // Synthesized once per line of text, uploaded to the public 'voice-audio' bucket and played by
  // Telnyx from its CDN URL (works across every Vercel instance). The bucket is created if missing.
  const VOICE_BUCKET = 'voice-audio';
  const supabase = db();
  const voiceId = process.env.ELEVENLABS_VOICE_ID || '';
  let tenantForUsage = null, voiceDownLogged = false;
  const payloadSid = (() => { try{ const p0 = extractVoicePayload(parsed); return p0.callSid || p0.callControlId || ''; }catch(_){ return ''; } })();
  async function upload(path, audio){
    let { error } = await supabase.storage.from(VOICE_BUCKET).upload(path, audio, { contentType: 'audio/mpeg', upsert: true });
    if(error && /not.?found|does not exist|bucket/i.test(String(error.message || error))){
      await supabase.storage.createBucket(VOICE_BUCKET, { public: true }).catch(() => null);
      ({ error } = await supabase.storage.from(VOICE_BUCKET).upload(path, audio, { contentType: 'audio/mpeg', upsert: true }));
    }
    return error;
  }
  async function speakCached(text){
    if(!elevenLabsConfigured()){
      // Never a robot voice — but never a silent hang-up nobody hears about either.
      const missing = ['ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID'].filter((k) => !process.env[k]);
      console.error(`[VOICE] Lola's voice is not configured (missing ${missing.join(', ') || 'voice'}) — call ${payloadSid || '?'} cannot be answered in her voice.`);
      if(tenantForUsage && !voiceDownLogged){ voiceDownLogged = true; try{ await logUsage(tenantForUsage.id, 'voice_unavailable', 1, { reason: 'elevenlabs_not_configured', missing }); }catch(_){} }
      return '';
    }
    if(!supabase || !text) return '';
    const key = crypto.createHash('sha1').update(`${voiceId}|${text}`).digest('hex');
    const storagePath = `cached/${key}.mp3`;
    try{
      const { data: pubData } = supabase.storage.from(VOICE_BUCKET).getPublicUrl(storagePath);
      if(pubData?.publicUrl){
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2500);
        try{
          const r = await fetch(pubData.publicUrl, { method: 'HEAD', signal: controller.signal });
          if(r.ok) return pubData.publicUrl;
        }catch{}finally{ clearTimeout(timer); }
      }
    }catch{}
    // ElevenLabs gets a hard deadline (a hung request used to hold the caller in silence until Telnyx
    // gave up): ~3.5s per try, one retry only if it still fits the budget.
    const started = Date.now();
    for(let attempt = 0; attempt < 2; attempt++){
      const left = SYNTH_BUDGET_MS - (Date.now() - started);
      if(attempt > 0 && left < 1500) break;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(500, Math.min(SYNTH_TRY_MS, left)));
      try{
        const audio = await synthesize(text, { signal: controller.signal });
        clearTimeout(timer);
        const upErr = await upload(storagePath, audio);
        if(upErr){ console.error('[VOICE] Supabase upload error:', upErr?.message || upErr); return ''; }
        const { data: pubData2 } = supabase.storage.from(VOICE_BUCKET).getPublicUrl(storagePath);
        if(tenantForUsage){
          try{ await logUsage(tenantForUsage.id, 'tts_chars', text.length, { source: 'voice' }); }catch(_){}
          await logCostSafe(tenantForUsage.id, 'cost_tts', ttsCents(text.length), { chars: text.length, source: 'voice' });
        }
        return pubData2?.publicUrl || '';
      }catch(e){ console.error('[VOICE] synth failed' + (controller.signal.aborted ? ' (deadline)' : '') + ':', String(e?.message||e).slice(0,120)); }
      finally{ clearTimeout(timer); }
    }
    return '';
  }

  // ── MULTI-TENANT ROUTING (before Lola's first syllable) ──
  // Strictly resolve the DIALED number to one tenant. Any miss, disabled
  // number, or ambiguous mapping is a hard refuse — never demo data, never
  // another salon's book. Hang up (don't Gather) so an unroutable caller
  // isn't left looping on the line.
  const routing = await resolveInboundTenant({ to: toN });
  if(routing.status !== 'resolved' || !routing.tenant){
    const say = routing.status === 'disabled'
      ? 'This number is not active yet. Please try again later.'
      : 'Sorry, we cannot route this call yet. Please try again shortly.';
    const xml = texmlSayAndGather({ say, playUrl: await speakCached(say), hangupAfter: true });
    res.setHeader('Content-Type', 'application/xml');
    return res.status(200).send(xml);
  }
  const tenant = routing.tenant;
  tenantForUsage = tenant;

  // ── OWNER VOICE COMMAND ("Jarvis, but better") ────────────────
  // If the CALLER is this salon's registered owner (tenants.operator_phone,
  // set in Settings), the owner's OWN Lola number doubles as their private
  // voice-command line — no second number to remember, no app to open.
  // Hand off to /api/operator-voice, which re-resolves by caller ID and
  // runs the privileged owner flow (schedule, revenue, rebooking radar;
  // PIN-gated for anything destructive). Caller ID is a soft signal here —
  // the PIN still guards every action that changes the book or texts clients.
  if(fromN && tenant.operator_phone && e164(tenant.operator_phone) === fromN){
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Redirect method="POST">/api/operator-voice</Redirect>\n</Response>`;
    res.setHeader('Content-Type', 'application/xml');
    return res.status(200).send(xml);
  }

  // ── Silence path: Gather timed out and <Redirect> brought us back ──
  let silence = 0, continueText = '';
  try{
    const sp = new URL(req.url, 'http://x').searchParams;
    silence = parseInt(sp.get('silence') || '0', 10) || 0;
    const c = sp.get('continue');
    if(c) continueText = Buffer.from(c, 'base64url').toString('utf8').slice(0, 600);
  }catch{}
  const firstTurn = !silence && !continueText && !String(payload.speechResult || '').trim() && !payload.digits;

  // ── Paid service gate (first turn): an expired / cancelled / unpaid salon's line says so, in
  // Lola's voice, and hangs up — no AI, no booking. Fails open if the billing module isn't there.
  if(firstTurn){
    const gate = await serviceGate(tenant);
    if(!gate.ok){
      const say = gate.say || `Thanks for calling ${tenant.name || 'the salon'}. The salon's line is not taking requests right now — please text or call back later. Goodbye!`;
      try{ await logUsage(tenant.id, 'voice_paused', 1, { reason: gate.reason || null }); }catch(_){}
      const xml = texmlSayAndGather({ say, playUrl: await speakCached(say), hangupAfter: true });
      res.setHeader('Content-Type', 'application/xml');
      return res.status(200).send(xml);
    }
  }
  if(silence > 0){
    if(silence === 1){
      // One gentle re-prompt before letting anyone go — a human
      // receptionist doesn't hang up at the first pause either.
      const say = `Are you still there? I'm happy to help with booking, prices, or anything else.`;
      const xml = texmlSayAndGather({ say, playUrl: await speakCached(say), hints: buildHints(tenant), silence });
      res.setHeader('Content-Type', 'application/xml');
      return res.status(200).send(xml);
    }
    // Second silence: warm goodbye + missed-call text-back (gated by the
    // owner's Settings > Messaging toggle), then hang up.
    const textbackEnabled = tenant.missed_call_textback !== false;
    const bye = textbackEnabled
      ? `No worries — I'll text you so you can book whenever suits you. Bye for now!`
      : `No worries — have a great day, and call us back any time. Bye for now!`;
    if(fromN && textbackEnabled){
      // The one missed-call sender: STOP line, once per caller per day, not after they just booked.
      try{
        const r = await textBackOnce(supabase, tenant, { from: fromN, to: toN, source: 'silent_caller' });
        if(r.sent) await logUsage(tenant.id, 'sms_sent', 1, { source: 'missed_call_textback' });
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
  // Keypad (Telnyx <Gather input="dtmf speech">): callers can press keys as well as talk —
  // a phone number typed in, 1 for yes / 2 for no, 0 to reach the salon. Lola hears it as words.
  if(!speech && payload.digits) speech = keypadWords(payload.digits);
  let reply = '';
  let actions = [];

  const telnyxCallId = payload.callSid || payload.callControlId || '';
  if(continueText && !speech) speech = continueText; // second leg of the instant-ack flow
  const firstName = client?.name && !/^client$/i.test(String(client.name)) ? String(client.name).split(' ')[0] : '';
  if(!speech){
    // Hello — with the disclosure every caller is owed (AI assistant, call may be recorded).
    const salon = tenant.name || 'the salon';
    reply = firstName
      ? `Hi ${firstName}, welcome back to ${salon}! It's Lola, the salon's AI assistant — this call may be recorded. What can I do for you today?`
      : `Thanks for calling ${salon}! This is Lola, the salon's AI assistant — this call may be recorded. How can I help you today?`;
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

    /* ── NO DEAD AIR, EVER ─────────────────────────────────────────
       Lola thinks (and books) while a short acknowledgment plays: Telnyx gets an instant
       "one sec…" plus a <Redirect> carrying the caller's words; the second leg does the real
       work with her tools. Perceived response time: under half a second, every turn. */
    if(!continueText){
      const ACKS = [
        `Mm-hm, one sec…`,
        `Sure — let me check that for you…`,
        `Okay, give me just a second…`,
        `Got it — one moment…`
      ];
      const ack = ACKS[(String(payload.callSid||fromN).split('').reduce((a,c)=>a+c.charCodeAt(0),0) + speech.length) % ACKS.length];
      const ackUrl = await speakCached(ack);
      if(ackUrl){
        const state = Buffer.from(speech).toString('base64url');
        const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Play>${escapeXml(ackUrl)}</Play>\n  <Redirect method="POST">/api/telnyx-voice?continue=${state}</Redirect>\n</Response>`;
        res.setHeader('Content-Type', 'application/xml');
        return res.status(200).send(xml);
      }
      // No ack audio: think right away instead.
    }

    let history = [];
    try{
      if(conversation?.id) history = await getConversationHistory(conversation.id, 10);
    }catch{}

    // ── HER BRAIN, WITH HER HANDS ─────────────────────────────────
    // The same brain as texts, WhatsApp, Instagram and the website: Telnyx AI with Lola's real
    // tools — check availability, book, confirm, reschedule, cancel, take a message — for THIS
    // salon, for THIS caller (Telnyx's caller ID is the client's verified line).
    let extra = `HOW YOU SPEAK (this is a live phone call):
- Contractions always. One thought per sentence. Two sentences is usually perfect; three max.
- Vary how you open; tiny natural interjections only when genuine. Use their first name now and then, never every turn.
- Mirror their energy. Refer back to what they said earlier in this call.
- Say numbers like a person: "three ninety-five", "two thirty tomorrow afternoon".
- Never sound like a list or a menu: weave options into one flowing sentence.
- When they ask for a person, take a message for the team (take_message) and say someone will call them back.
- Callers can also use the keypad; their keys arrive as "(pressed …)" / "(typed on the keypad) …". If you asked a yes/no question you may say "or press 1 for yes" — once, not every turn.
- Caller's mood right now: ${mood || 'neutral'}; what they seem to want: ${intent || 'unclear'}.`;
    try{
      const mmsResult = await getInCallMmsResult(payload.callControlId);   // async: a pending Promise used to read as a result
      if(mmsResult) extra += '\n' + buildMmsVisionPromptBlock(mmsResult);
    }catch{}
    try{
      const out = await answerClient({
        tenant, client, channel: 'voice', text: speech, history, phone: fromN || null,
        memoryKey: fromN || null, tz: tenant.timezone || tenant.time_zone || 'America/New_York',
        extra, budgetMs: 9000
      });
      reply = String(out?.reply || '').trim();
      actions = out?.actions || [];
    }catch(e){ console.error('[VOICE] brain:', String(e?.message || e).slice(0, 200)); }
    if(!reply) reply = `Sorry, I didn't quite catch that — could you say it one more time?`;

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

  // Bookkeeping runs while her voice renders (one round trip, not two).
  const bookkeeping = (async () => {
  if(conversation?.id){
      try{
        if(speech){
          await logMessage({ conversationId: conversation.id, tenantId: tenant.id, role: 'user', agent: 'lola', content: speech });
        }
        await logMessage({ conversationId: conversation.id, tenantId: tenant.id, role: 'assistant', agent: 'lola', content: reply });
        // One voice_call per CALL (its greeting), not one per turn.
        if(!speech) await logUsage(tenant.id, 'voice_call', 1, { call_control_id: payload.callControlId || '', call_sid: payload.callSid || '' });
        else await logUsage(tenant.id, 'ai_token', 1, { source: 'voice' });
        // keep the call record alive: rolling transcript + outcome upgrades
        try{
          if(telnyxCallId && speech){
            const call = await getCallByTelnyxId(tenant.id, telnyxCallId);
            if(call){
              const line = `Caller: ${speech}\nLola: ${reply}\n`;
              // Canonical call contract: the rolling transcript rides in
              // recording_url and the outcome in status (legacy transcript/
              // outcome columns are generated aliases — never writable).
              const base = String(call.recording_url || call.transcript || '');
              const patch = { recording_url: base + line };
              const booked = actions.some((x) => x?.tool === 'book_appointment' && x?.result?.booked === true);
              if(booked && call.status !== 'booked' && call.outcome !== 'booked') patch.status = 'booked';
              await updateCallByTelnyxId(tenant.id, telnyxCallId, patch);
            }
          }
        }catch{}
      }catch{}
    }
  })().catch(() => {});

  // clean for the mouth: no markdown, no newlines, spoken-length cap
  reply = String(reply).replace(/[*_#`]/g,'').replace(/\s*\n+\s*/g,' ').slice(0, 420).trim();
  const [playUrl] = await Promise.all([speakCached(reply), bookkeeping]);
  if(!playUrl && fromN){
    // Her voice is down: the caller still gets Lola — by text, from the salon's own number.
    try{ await sendSMS({ from: toN, to: fromN, text: withStopLine(`Hi, it's Lola at ${tenant.name || 'the salon'} — sorry, our line dropped. Text me here what you need and I'll take care of it right away.`), tenantId: tenant.id }); }catch(_){}
  }

  const xml = texmlSayAndGather({ say: reply, playUrl, hints: buildHints(tenant) });
  res.setHeader('Content-Type', 'application/xml');
  return res.status(200).send(xml);
  }catch(handlerErr){
    console.error('[VOICE] HANDLER CRASH:', String(handlerErr?.message||handlerErr).slice(0,500), handlerErr?.stack?.slice(0,500));
    // Fail loudly, never substitute a voice. A 502 is visible in Vercel
    // logs and the Telnyx dashboard — misconfig becomes unmissable.
    return res.status(502).json({
      error: 'Lola voice unavailable — call refused rather than speaking in a substitute voice',
      detail: String(handlerErr?.message||handlerErr).slice(0,300)
    });
  }
}
