/**
 * /api/operator-voice — the shared "Jarvis" line (owner voice control)
 * ════════════════════════════════════════════════════════════════════
 * ONE Telnyx number serves EVERY tenant. Point your owner/Jarvis
 * number's TeXML webhook here and the economics become pure SaaS:
 * zero marginal telco cost per salon, and "run your salon by voice"
 * becomes a plan feature instead of a per-tenant provisioning project.
 *
 * HOW THE CALLER IS RESOLVED (multi-tenant by CALLER, not called number):
 *   The owner registers their cell as operator_phone in Settings
 *   (/api/operator-setup). When they dial the Jarvis line, caller ID
 *   picks their salon. Unknown callers get a polite security refusal —
 *   never a demo tenant, never someone else's book.
 *
 * AUTHORIZATION MODEL (same as operator-tools):
 *   Caller ID is a soft signal — spoofable — so it grants READ access
 *   only (schedule, revenue, rebooking radar). Anything that changes
 *   the book or texts clients reuses the two-phase confirm from
 *   OPERATOR_SKILLS: preview → "say your PIN and confirm" → HMAC
 *   confirm_token + spoken PIN (verified against operator_pin_hash).
 *   The pending action rides base64url in the <Gather> action URL, so
 *   nothing is stored server-side between turns.
 *
 * Skills are the exact OPERATOR_SKILLS the Telnyx-AI-Assistant path
 * uses — one skill layer, two transports.
 */
import {
  e164, getTenantByOperatorPhone, logUsage,
  getOrStartConversation, logMessage
} from './lib/db.js';
import { OPERATOR_SKILLS } from './operator-tools.js';
import { answerOwner } from './lib/owner-brain.js';
import { getConversationHistory } from './lib/db.js';
import { synthesize, isConfigured as elevenLabsConfigured } from './lib/elevenlabs.js';
import { putAudioKeyed, getKeyedAudioId } from './lib/tts-cache.js';
import crypto from 'crypto';

function escapeXml(v=''){ return String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;'); }

async function readBody(req){
  if(req.body && typeof req.body === 'object') return req.body;
  return new Promise(resolve => {
    let raw=''; req.on('data',c=>raw+=c); req.on('end',()=>{
      const ct = String(req.headers['content-type']||'').toLowerCase();
      if(ct.includes('json')){ try{ return resolve(JSON.parse(raw)); }catch{ return resolve({}); } }
      if(ct.includes('urlencoded')){ const o={}; for(const [k,v] of new URLSearchParams(raw)) o[k]=v; return resolve(o); }
      resolve({});
    }); req.on('error',()=>resolve({}));
  });
}

function extract(parsed){
  const p = parsed?.data?.payload || parsed || {};
  return {
    from: p.from || p.From || parsed?.From || '',
    to:   p.to   || p.To   || parsed?.To   || '',
    speech: String(p.speech_result || p.SpeechResult || parsed?.SpeechResult || '').trim(),
    callId: p.call_leg_id || p.call_session_id || parsed?.CallSid || ''
  };
}

/* ── state carried between turns in the action URL ── */
function packState(s){ return Buffer.from(JSON.stringify(s)).toString('base64url'); }
function unpackState(raw){ try{ return JSON.parse(Buffer.from(String(raw||''), 'base64url').toString()); }catch{ return null; } }

/* ── owner-vocabulary intent parser ─────────────────────────────────
   Deterministic on purpose: the operator line must work even with
   every AI provider down, and owner commands are a small, closed
   vocabulary. Returns { tool, args } or null. */
const DATE_WORD = "today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week";
export function parseOperatorIntent(text){
  const t = String(text||'').toLowerCase().replace(/[.?!]+$/,'').trim();
  if(!t) return null;
  let m;

  /* Order matters: specific commands FIRST, the broad schedule match
     LAST — "rebook", "book jane", and "cancel X's appointment" all
     contain schedule-ish words and must not fall into whats_my_day. */

  // cancel NAME ['s] [appointment] [on DATE]
  if((m = t.match(new RegExp(`^cancel\\s+([a-z ]+?)(?:'s)?(?:\\s+appointment)?(?:\\s+(?:on\\s+)?(${DATE_WORD}))?$`))))
    return { tool:'cancel_appointment', args:{ client_name: m[1].trim(), date: m[2] || '' } };

  // move/reschedule NAME [on DATE] to NEWDATE [at TIME]
  if((m = t.match(new RegExp(`^(?:move|reschedule)\\s+([a-z ]+?)(?:'s)?(?:\\s+appointment)?(?:\\s+(?:on|from)\\s+(${DATE_WORD}))?\\s+to\\s+(${DATE_WORD}|[a-z]+ \\d+)(?:\\s+at\\s+([\\w: ]+))?$`))))
    return { tool:'move_appointment', args:{ client_name: m[1].trim(), date: m[2]||'', new_date: m[3], new_time: (m[4]||'').trim() } };

  // broadcast: text my vips saying ... / text everyone: ...
  if((m = t.match(/^(?:text|message|blast|broadcast)\s+(?:my\s+)?(vips?|everyone|all|overdue|due)\b(?:\s*(?:saying|that|with|:)?\s*(.+))?/))){
    const seg = /vip/.test(m[1]) ? 'vip' : /due|overdue/.test(m[1]) ? 'due' : 'all';
    return { tool:'broadcast_text', args:{ segment: seg, message: (m[2]||'').trim() } };
  }

  // book NAME for SERVICE [on DATE] [at TIME]
  if((m = t.match(new RegExp(`^book\\s+([a-z ]+?)\\s+for\\s+(?:a\\s+)?([a-z &]+?)(?:\\s+(?:on\\s+)?(${DATE_WORD}))?(?:\\s+at\\s+([\\w: ]+))?$`))))
    return { tool:'book_for_client', args:{ client_name: m[1].trim(), service: m[2].trim(), date: m[3]||'today', time: (m[4]||'').trim() } };

  // rebooking radar
  if(/(?:who'?s|who is)\s*(?:due|overdue)|\brebook|win.?back|\boverdue\b/.test(t))
    return { tool:'who_is_due', args:{} };

  // revenue
  if(/revenue|sales|earnings|how much (?:did|have) (?:we|i)|money (?:did|have)/.test(t)){
    const range = /month/.test(t) ? 'month' : /week/.test(t) ? 'week' : '';
    const date = (!range && (t.match(new RegExp(`(${DATE_WORD})`))||[])[1]) || '';
    return { tool:'find_revenue', args:{ range, date } };
  }

  // schedule / day — the broad one, deliberately last
  if(/\b(day|schedule|on the books|appointments?)\b/.test(t)){
    const date = (t.match(new RegExp(`(${DATE_WORD})`))||[])[1] || 'today';
    return { tool:'whats_my_day', args:{ date } };
  }

  return null;
}

// PIN spoken as "4 3 2 1 confirm" / "1234, confirm" / "confirm 1234"
export function parsePinConfirm(text){
  const t = String(text||'').toLowerCase();
  if(!/confirm/.test(t)) return null;
  const digits = (t.match(/\d/g)||[]).join('');
  return digits.length >= 3 ? digits : null;
}

const HINTS = 'schedule, revenue, this week, this month, rebook, overdue, cancel, move, reschedule, appointment, text my VIPs, confirm, today, tomorrow';

function texml({ say, playUrl, state = null, hangup = false }){
  const speak = playUrl ? `<Play>${escapeXml(playUrl)}</Play>` : `<Say voice="Polly.Joanna-Neural">${escapeXml(say)}</Say>`;
  if(hangup) return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  ${speak}\n  <Hangup/>\n</Response>`;
  const action = '/api/operator-voice' + (state ? `?state=${packState(state)}` : '');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  ${speak}\n  <Gather input="speech" language="en-US" timeout="7" speechTimeout="auto" hints="${escapeXml(HINTS)}" action="${escapeXml(action)}" method="POST"/>\n  <Redirect method="POST">/api/operator-voice?silence=1${state?`&amp;state=${packState(state)}`:''}</Redirect>\n</Response>`;
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  if(req.method === 'OPTIONS') return res.status(200).end();
  if(req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const parsed = await readBody(req);
  const { from, to, speech, callId } = extract(parsed);
  const url = new URL(req.url, 'http://x');
  const silence = url.searchParams.get('silence') === '1';
  const state = unpackState(url.searchParams.get('state'));

  const xmlOut = (xml)=>{ res.setHeader('Content-Type','application/xml'); return res.status(200).send(xml); };

  // ── Who runs this salon? ──
  const tenant = await getTenantByOperatorPhone(from);
  if(!tenant){
    return xmlOut(texml({
      say: "This line is reserved for registered salon owners. Add your cell as the operator phone in your LolaDesk settings, then call me right back.",
      hangup: true
    }));
  }

  // cached synthesis for repeated owner-line phrases (greeting, prompts)
  async function speakCached(text){
    if(!elevenLabsConfigured() || !process.env.APP_URL) return '';
    const key = crypto.createHash('sha1').update(`op|${process.env.ELEVENLABS_VOICE_ID||''}|${text}`).digest('hex');
    let id = getKeyedAudioId(key);
    if(!id){
      try{ id = putAudioKeyed(key, await synthesize(text)); }
      catch{ return ''; }
    }
    return `${process.env.APP_URL.replace(/\/+$/,'')}/api/voice-audio?id=${encodeURIComponent(id)}`;
  }

  // audit trail: the owner line writes to the same memory substrate
  let conversation = null;
  try{ conversation = await getOrStartConversation(tenant.id, { channel: 'operator', agent: 'jarvis' }); }catch{}
  async function audit(userText, replyText){
    try{
      if(!conversation?.id) return;
      if(userText)  await logMessage({ conversationId: conversation.id, tenantId: tenant.id, role:'user', agent:'jarvis', content: userText });
      if(replyText) await logMessage({ conversationId: conversation.id, tenantId: tenant.id, role:'assistant', agent:'jarvis', content: replyText });
    }catch{}
  }

  // ── silence handling: one nudge, then a graceful goodbye ──
  if(silence){
    const bye = `I'm here whenever you need me${tenant.owner_name ? `, ${String(tenant.owner_name).split(' ')[0]}` : ''}. Bye for now.`;
    return xmlOut(texml({ say: bye, playUrl: await speakCached(bye), hangup: true }));
  }

  // ── greeting turn ──
  if(!speech){
    try{ await logUsage(tenant.id, 'operator_call', 1, { call_id: callId }); }catch{}
    const name = tenant.owner_name ? ` ${String(tenant.owner_name).split(' ')[0]}` : '';
    const greet = `Hey${name}, it's Lola. Ask me about your day, revenue, or who's due — or tell me to move, cancel, or text clients.`;
    return xmlOut(texml({ say: greet, playUrl: await speakCached(greet) }));
  }

  // ── pending destructive confirm? ──
  if(state?.tool && state?.confirm_token){
    const pin = parsePinConfirm(speech);
    if(pin){
      const result = await OPERATOR_SKILLS[state.tool](tenant, { ...state.args, confirm: true, pin, confirm_token: state.confirm_token })
        .catch(()=>({ speak: "Something went sideways — nothing was changed." }));
      await audit(speech, result.speak);
      return xmlOut(texml({ say: result.speak + ' Anything else?', playUrl: await speakCached(result.speak + ' Anything else?') }));
    }
    if(/cancel that|never ?mind|stop|forget it/.test(speech.toLowerCase())){
      const ok = "Okay — nothing changed. What else?";
      await audit(speech, ok);
      return xmlOut(texml({ say: ok, playUrl: await speakCached(ok) }));
    }
    const again = "To go ahead, say your PIN and the word confirm. Or say never mind.";
    return xmlOut(texml({ say: again, playUrl: await speakCached(again), state }));
  }

  // ── normal command turn ──
  const intent = parseOperatorIntent(speech);
  if(!intent){
    // FULL CONVERSATION MODE: anything outside the closed command grammar
    // goes to the owner brain — the real LLM grounded in a live snapshot
    // of THIS salon (today's book, week/month revenue, rebooking radar,
    // menu, owner notes, accumulated owner memory) plus the recent
    // operator-channel history. Pricing strategy, tricky clients, promo
    // ideas, "why was Tuesday slow" — all fair game, spoken back in
    // 1–3 sentences. Falls back to the command help line only if every
    // AI provider is down.
    let history = [];
    try{ if(conversation?.id) history = await getConversationHistory(conversation.id, 10); }catch{}
    const brain = await answerOwner(tenant, history, speech, { channel: 'voice' });
    if(brain.ok){
      await audit(speech, brain.text);
      return xmlOut(texml({ say: brain.text }));
    }
    const help = "I can read your day, pull revenue, flag who's due to rebook, move or cancel appointments, book clients, or text a segment. What do you need?";
    await audit(speech, help);
    return xmlOut(texml({ say: help, playUrl: await speakCached(help) }));
  }

  const result = await OPERATOR_SKILLS[intent.tool](tenant, intent.args)
    .catch(()=>({ speak: "I hit a snag pulling that up — try me again." }));
  await audit(speech, result.speak);

  if(result.needs_confirmation && result.confirm_token){
    // carry the pending action into the next turn — nothing stored server-side
    return xmlOut(texml({
      say: result.speak,
      playUrl: await speakCached(result.speak),
      state: { tool: intent.tool, args: intent.args, confirm_token: result.confirm_token }
    }));
  }

  const line = result.speak + ' Anything else?';
  return xmlOut(texml({ say: line, playUrl: await speakCached(line) }));
}
