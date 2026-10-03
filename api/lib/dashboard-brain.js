/**
 * api/lib/dashboard-brain.js — the shared Lola brain for the dashboard
 * ════════════════════════════════════════════════════════════════
 * Extracted from the /api/lola handler so EVERY direct voice channel
 * (the browser orb's tap-to-talk / wake-word, the keyboard command
 * bar, and the new /api/voice/session endpoint) runs the EXACT same
 * brain: persistent memory, booking fast-path, availability fast-path,
 * elite-skill fast-path, LLM tool-calling loop, and the deterministic
 * fallback tiers.

 * It is deliberately TELEPHONY-INDEPENDENT: it takes a tenant and a
 * conversation, never a call_control_id or a calls-table row. A
 * salon with zero calls today gets the same instant, fully capable
 * Lola as one with fifty — telephony state never gates the answer.
 *
 * `dashboardBrainReply({ tenant, body })` returns `{ status, json }`
 * so every caller (lola.js, voice/session.js) renders the identical
 * contract the dashboard already consumes.
 */

import { chat } from './llm.js';
import { executeSkill } from './orchestrator.js';
import { SKILLS } from '../lola-tools.js';
import { resolveDate } from './operator-db.js';
import { getOrStartConversation, getConversationHistory, logMessage, getOwnerMemory, setOwnerMemory } from './db.js';
import { buildClientMemoryBlock, extractPersonalizationSignals, mergeClientProfile, profileFromMemoryRows, detectLolaIntent, deterministicSkillReply } from './lola-skills.js';
import { OWNER_TOOLS, OWNER_TOOL_NAMES, runOwnerTool, ownerSystemPrompt, takePendingAction, isOwnerCommand } from './owner-tools.js';
import { routeOwnerIntent, agentFor } from './owner-intents.js';
import { lolaSelfCheck } from './lola-doctor.js';
import { getUserFromToken, bearer, isAdminEmail } from './auth.js';

// Lola must answer a spoken turn fast: the whole brain has this long.
const BRAIN_BUDGET_MS = 22000;
const plan = (name) => ({ agents: [agentFor(name || '')], skill: name || null });

// Real, fresh business facts pulled from the SERVER's own tenant record —
// not whatever the client happened to have cached. Phone calls already get
// real data this way via tenantKnowledgePrompt()/agent-variables.js; this
// brings the dashboard chat + direct voice session up to the same standard
// so both "brains" agree.
function realBusinessFacts(tenant){
  if(!tenant) return '';
  const services = (tenant.services||[])
    .map(s => `${s.name}${s.price!=null?` — $${s.price}`:''}${s.duration?` (${s.duration})`:''}`)
    .join('\n');
  const team = (tenant.team||[]).map(t => `${t.name}${t.role?` (${t.role})`:''}`).join(', ');
  const lines = [
    'AUTHORITATIVE BUSINESS FACTS (from the live tenant record — these override anything else said above about services, hours, team, or booking):',
    tenant.name ? `Salon: ${tenant.name}${tenant.location?` in ${tenant.location}`:''}` : '',
    tenant.hours ? `Hours: ${tenant.hours}` : '',
    services ? `Services & prices:\n${services}` : '',
    team ? `Team: ${team}` : '',
    tenant.booking_url ? `Booking link: ${tenant.booking_url}` : '',
    tenant.phone_number ? `Salon phone: ${tenant.phone_number}` : ''
  ].filter(Boolean);
  return lines.length > 1 ? lines.join('\n') : '';
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "book_appointment",
      description: "Book an appointment for a client.",
      parameters: {
        type: "object",
        properties: {
          service: { type: "string", description: "The service to book (e.g. balayage)" },
          date: { type: "string", description: "Date like 2026-06-25" },
          time: { type: "string", description: "Time like 14:00" },
          client_name: { type: "string" },
          client_phone: { type: "string" }
        },
        required: ["service", "client_name"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_services",
      description: "List all services offered by the salon.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "get_pricing",
      description: "Get pricing and duration for a specific service.",
      parameters: {
        type: "object",
        properties: { service: { type: "string" } },
        required: ["service"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "check_availability",
      description: "Check if the salon has openings for a service.",
      parameters: {
        type: "object",
        properties: { service: { type: "string" }, date: { type: "string" } },
        required: ["service"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "confirm_booking",
      description: "Confirm a client's upcoming booking by phone or name.",
      parameters: {
        type: "object",
        properties: {
          client_phone: { type: "string" },
          client_name: { type: "string" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "reschedule_appointment",
      description: "Reschedule an existing appointment to a new date/time.",
      parameters: {
        type: "object",
        properties: {
          booking_id: { type: "string" },
          client_phone: { type: "string" },
          new_date: { type: "string", description: "Date like 2026-06-25" },
          new_time: { type: "string", description: "Time like 14:00 or 2:00 PM" }
        },
        required: ["new_date", "new_time"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "cancel_appointment",
      description: "Cancel an existing appointment.",
      parameters: {
        type: "object",
        properties: {
          booking_id: { type: "string" },
          client_phone: { type: "string" }
        }
      }
    }
  }
];

// ── Sentence → booking extraction ────────────────────────────────────────
function fmtDate(d){ return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }

// Pull a concrete YYYY-MM-DD out of natural phrasing (today/tomorrow/weekday/
// next week/in N days). Returns null when no date is mentioned.
function parseDateFromText(t){
  if(/\btomorrow\b/.test(t)) return fmtDate(resolveDate('tomorrow'));
  if(/\bday after tomorrow\b/.test(t)) return fmtDate(resolveDate('day after tomorrow'));
  if(/\btoday\b/.test(t)) return fmtDate(resolveDate('today'));
  const wd = t.match(/\b(this|next|coming)?\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if(wd) return fmtDate(resolveDate(((wd[1] ? wd[1] + ' ' : '') + wd[2]).trim()));
  const inN = t.match(/\bin\s+(\d+)\s+days?\b/);
  if(inN) return fmtDate(resolveDate('in ' + inN[1] + ' days'));
  if(/\bnext week\b/.test(t)) return fmtDate(resolveDate('next week'));
  return null;
}

function matchService(t, tenant){
  const svcList = Array.isArray(tenant?.services) ? tenant.services.map(s => (s && (s.name || s))).filter(Boolean) : [];
  for(const s of svcList){ if(t.includes(String(s).toLowerCase())){ return s; } }
  const kw = ['balayage','colour','color','haircut','cut','styling','blowout','ombre','highlights','keratin','extensions','extension','treatment','facial','manicure','pedicure','wax','massage'];
  for(const k of kw){ if(t.includes(k)){ return k; } }
  return null;
}

function extractBooking(text, tenant){
  if(!text) return null;
  const t = text.toLowerCase();
  if(!/\b(book|schedule|rebook|pencil(?:\s+in)?|set\s+up)\b/.test(t)) return null;

  const service = matchService(t, tenant);

  let client_name = null;
  const m = text.match(/\bfor\s+([A-Z][a-zA-Z]+)/) || text.match(/\bbook\s+([A-Z][a-zA-Z]+)/);
  if(m && !['a','an','the','me','my'].includes(m[1].toLowerCase())) client_name = m[1];

  let time = null;
  const tm = text.match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i) || text.match(/\b(\d{1,2}:\d{2})\b/);
  if(tm) time = tm[1].replace(/\s+/g,'');

  const date = parseDateFromText(t);

  if(!service && !time && !client_name) return null;
  return { service: service || 'appointment', date, time, client_name };
}

// "am I free friday", "any openings tomorrow", "is 3pm open", "what's available"
function extractAvailabilityQuery(text, tenant){
  if(!text) return null;
  const t = text.toLowerCase();
  if(/\b(book|rebook|pencil)\b/.test(t) && /\bfor\s+[a-z]/i.test(text)) return null;
  const asks = /\b(free|availab|openings?|slots?|booked up|when can|what times?|do you have (?:any )?(?:time|openings?|availability|slots?)|is\s+\d{1,2}\s*(?:am|pm)?\s*(?:free|open|available|taken|booked))\b/.test(t);
  if(!asks) return null;
  return { service: matchService(t, tenant), date: parseDateFromText(t) };
}

/* Built-in answer machine — the last resilience tier. Synthesizes an
   answer directly from the tenant's own data so Lola stays useful even
   with every AI provider down or unconfigured. */
function builtinAnswer(tenant, text){
  const t = String(text||'').toLowerCase();
  let services = [];
  try{ services = Array.isArray(tenant?.services) ? tenant.services : JSON.parse(tenant?.services||'[]'); }catch{}
  if(/(service|offer|menu|price|pricing|cost|how much)/.test(t) && services.length){
    const list = services.map(s=>`${s.name}${s.price?` — $${s.price}`:''}`).join(', ');
    return `Here's our menu: ${list}. Want me to book any of these?`;
  }
  if(/(hour|open|close|schedule|when are you)/.test(t) && tenant?.hours) return `We're open ${tenant.hours}.`;
  if(/(where|location|address|find you)/.test(t) && tenant?.location) return `You'll find us at ${tenant.location}.`;
  return `I'm having trouble reaching my full brain right now, but I can still handle bookings, services, prices, and hours — what do you need?`;
}

function lastUserText(messages){
  const m = [...(messages||[])].reverse().find(x => x && x.role === 'user');
  return (m && typeof m.content === 'string') ? m.content : '';
}

/**
 * Compute Lola's reply for a dashboard/direct-voice conversation.
 * Pure brain — no req/res, no telephony state. Returns { status, json }.
 */
export async function dashboardBrainReply({ tenant, body, req }){
  // `let`: past conversation is merged in below (a `const` here made that
  // assignment throw, silently skipping Lola's history).
  let messages = Array.isArray(body.messages) ? body.messages : [];

  /* ── PERSISTENT MEMORY — Lola remembers everything ──────────────
     Every dashboard exchange persists to conversations/messages
     (channel 'dashboard'), same tables as calls and texts — one
     memory substrate across ALL channels. */
  const lastUserTextMsg = lastUserText(messages);
  let memConversation = null, memoryBlock = '';
  try{
    memConversation = await getOrStartConversation(tenant.id, { channel: body.channel || 'dashboard', agent: 'lola' });
    let ownerProfile = profileFromMemoryRows(await getOwnerMemory(tenant.id));
    memoryBlock = buildClientMemoryBlock(ownerProfile) || '';
    if(memConversation?.id && messages.length <= 2){
      const past = await getConversationHistory(memConversation.id, 12);
      if(past.length) messages = [...past, ...messages];
    }
    if(lastUserTextMsg){
      const signals = extractPersonalizationSignals(lastUserTextMsg);
      if(signals?.hasSignal){
        ownerProfile = mergeClientProfile(ownerProfile, signals);
        await setOwnerMemory(tenant.id, 'profile', ownerProfile);
      }
    }
  }catch{ /* memory must never block the answer */ }

  const started = Date.now();
  const left = () => BRAIN_BUDGET_MS - (Date.now() - started);
  let ownerPrompt = '';
  try{ ownerPrompt = await ownerSystemPrompt(tenant); }catch{}
  // body.system is only ever page context from the Lola panel ("the owner is on
  // the Calendar page…") — never a persona; the persona lives on the server.
  const pageContext = typeof body.system === 'string' && body.system.length <= 800 ? `PAGE CONTEXT: ${body.system}` : '';
  const voiceStyle = body.voice ? 'The owner is SPEAKING to you: answer in one or two short spoken sentences, no lists, no markdown, no links.' : '';
  const systemPrompt = [ownerPrompt, pageContext, voiceStyle, realBusinessFacts(tenant), memoryBlock].filter(Boolean).join('\n') || undefined;
  // Owner commands (text/call/cancel/move/no-show/fill/revenue/brief…) go
  // straight to the tool-calling brain, never the caller fast-paths.
  const ownerCmd = isOwnerCommand(lastUserTextMsg);

  // Persist the turn regardless of which branch produced the reply.
  async function remember(replyText){
    try{
      if(body.silent || !memConversation?.id) return;   // her own hello isn't part of your conversation
      if(lastUserTextMsg) await logMessage({ conversationId: memConversation.id, tenantId: tenant.id, role: 'user', agent: 'lola', content: lastUserTextMsg });
      if(replyText)   await logMessage({ conversationId: memConversation.id, tenantId: tenant.id, role: 'assistant', agent: 'lola', content: String(replyText) });
    }catch{}
  }

  // ── Booking fast-path: write a real appointment from the sentence ──────
  // A bare yes/no answers the action Lola just proposed — run exactly what was previewed.
  try{
    const pend = await takePendingAction({ tenant, text: lastUserTextMsg, req });
    if(pend){
      await remember(pend.say);
      return { status: 200, json: { content:[{ type:'text', text: pend.say }], intent:'owner_action', source:'owner-tool',
        actions: pend.ui ? [pend.ui] : undefined, needs_confirmation: !!pend.needs_confirmation, orchestration: plan('execution') } };
    }
  }catch(e){ /* fall through */ }

  // ── Reflexes: the everyday commands run instantly, no model in the loop ──
  try{
    const hit = routeOwnerIntent(lastUserTextMsg);
    if(hit?.self_check){
      let platform = false;
      try { const u = req ? await getUserFromToken(bearer(req)) : null; platform = !!(u && isAdminEmail(u.email)); } catch {}
      const chk = await lolaSelfCheck(tenant, { platform });
      await remember(chk.say);
      return { status: 200, json: { content:[{ type:'text', text: chk.say }], intent:'self_check', source:'reflex', checks: chk.checks, orchestration: plan('self_check') } };
    }
    if(hit?.navigate){
      await remember(hit.say);
      return { status: 200, json: { content:[{ type:'text', text: hit.say }], intent:'open_page', source:'reflex', actions:[{ navigate: hit.navigate }], orchestration: plan('open_page') } };
    }
    if(hit?.tool){
      const out = await runOwnerTool({ tenant, name: hit.tool, args: hit.args, req });
      const say = out.say || 'Done.';
      await remember(say);
      return { status: 200, json: { content:[{ type:'text', text: say }], intent: hit.tool, source:'reflex',
        actions: out.ui ? [out.ui] : undefined, needs_confirmation: !!out.needs_confirmation,
        suggestions: Array.isArray(out.suggestions) ? out.suggestions : undefined, orchestration: plan(hit.tool) } };
    }
  }catch(e){ /* fall through to the brain */ }

  try{
    const booking = ownerCmd ? null : extractBooking(lastUserTextMsg, tenant);
    if(booking){
      const result = await executeSkill(tenant, booking.client_phone || null, 'book_appointment', booking, SKILLS);
      if(result && (result.speak || result.booked !== undefined)){
        await remember(result.speak || 'Done.');
        return {
          status: 200,
          json: {
            content: [{ type:'text', text: result.speak || 'Done.' }],
            intent: 'book_appointment', booked: !!result.booked, source: 'skill'
          }
        };
      }
    }
  }catch(e){ /* fall through to skill/conversation */ }

  // ── Availability sight: let Lola see her calendar and answer openings ──
  try{
    const aq = ownerCmd ? null : extractAvailabilityQuery(lastUserTextMsg, tenant);
    if(aq){
      const result = await executeSkill(tenant, null, 'check_availability', aq, SKILLS);
      if(result && result.speak){
        await remember(result.speak);
        return { status: 200, json: { content:[{ type:'text', text: result.speak }], intent:'check_availability', source:'skill' } };
      }
    }
  }catch(e){ /* fall through */ }

  // (The caller-side "elite skill" canned replies — photo contests, referral
  // credits — used to fire here and answer the OWNER as if they were a client.
  // The owner always gets the real brain.)

  // Step 1: Initial LLM call with tools
  let result = await chat({
    system: systemPrompt,
    messages: messages.slice(-16),
    maxTokens: Math.min(body.max_tokens || 500, 700),
    temperature: 0.5,
    fast: true,
    deadlineMs: Math.max(4000, left() - 7000),
    tools: [...TOOLS, ...OWNER_TOOLS]
  });
  // Telnyx refused the tool list for this turn: her answer can't have DONE anything — never let it sound like it did.
  if(result.ok && result.toolsDropped && !(result.tool_calls && result.tool_calls.length) && /\b(text|send|book|cancel|move|resched|call|remind|block|add|create)\w*/i.test(lastUserTextMsg || '')){
    result = { ...result, text: "I couldn't run that just now — nothing was sent or changed. Say it again and I'll do it." };
  }

  if(!result.ok){
    // The LLM being down or unconfigured must NEVER kill the front desk.
    // Tier 1: the deterministic skills layer. Tier 2: a built-in answer
    // synthesized straight from the tenant's own data.
    try{
      const intent = detectLolaIntent(lastUserTextMsg);
      const fb = deterministicSkillReply({ tenant, intent, channel: 'dashboard', clientName: '' })
        || builtinAnswer(tenant, lastUserTextMsg);
      if(fb){
        await remember(fb);
        return { status: 200, json: { content: [{ type:'text', text: fb }], intent, source: 'skill-fallback' } };
      }
    }catch{}
    return {
      status: 502,
      json: { type: 'error', error: { type: 'upstream_error', message: result.error, provider: result.provider } }
    };
  }

  // Step 2: Handle Tool Calls (Agentic Loop)
  if (result.tool_calls && result.tool_calls.length > 0) {
    const toolCall = result.tool_calls[0]; // Process first tool
    const funcName = toolCall.function.name;
    let funcArgs = {};
    try{ funcArgs = JSON.parse(toolCall.function.arguments || '{}') || {}; }catch{ funcArgs = {}; }

    // Owner tools answer in their own words (previews, confirmations, results).
    if (OWNER_TOOL_NAMES.has(funcName)) {
      const out = await runOwnerTool({ tenant, name: funcName, args: funcArgs, req });
      const say = out.say || 'Done.';
      await remember(say);
      return { status: 200, json: { id: `msg_${Date.now()}`, type: 'message', role: 'assistant',
        content: [{ type: 'text', text: say }], intent: funcName, source: 'owner-tool', orchestration: plan(funcName),
        actions: out.ui ? [out.ui] : undefined, needs_confirmation: !!out.needs_confirmation,
        suggestions: Array.isArray(out.suggestions) ? out.suggestions : undefined,
        model: result.model, provider: result.provider } };
    }

    // Add the assistant's tool request to history
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: [toolCall]   // only the call we answer below — an unanswered tool_call id makes the next request a 400
    });

    let toolResultText = "";
    let skillSpeak = '';
    try {
      if (SKILLS[funcName] && tenant) {
         const skillOutput = await executeSkill(tenant, funcArgs.client_phone, funcName, funcArgs, SKILLS);
         skillSpeak = String(skillOutput?.speak || '');
         toolResultText = JSON.stringify(skillOutput);
      } else {
         toolResultText = JSON.stringify({ error: "Missing tenant or unknown skill" });
      }
    } catch (e) {
      toolResultText = JSON.stringify({ error: String(e) });
    }

    // Append the tool result
    messages.push({
      role: "tool",
      tool_call_id: toolCall.id,
      name: funcName,
      content: toolResultText
    });

    // Step 3: Second LLM call to get spoken response
    // The skill already has words for the owner; only ask the brain again if there's time.
    const secondResult = left() > 5000 ? await chat({
      system: systemPrompt,
      messages: messages.slice(-18),
      maxTokens: Math.min(body.max_tokens || 500, 700),
      temperature: 0.5,
      fast: true,
      deadlineMs: left() - 1500,
    }) : { ok: false };

    if(secondResult.ok && secondResult.text) {
      result = secondResult;
    } else {
      result = { ...result, text: skillSpeak || 'Done.' };
    }
    result.intent = funcName;
  }

  const finalText = String(result?.text || '').trim() ||
    'I am on it. Give me the client name, service, and preferred time, and I will handle the next step.';
  await remember(finalText);

  // Return in the shape the dashboard expects
  return {
    status: 200,
    json: {
      id: `msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: finalText }],
      intent: result.intent || 'conversation',
      source: 'brain',
      orchestration: plan(result.intent || ''),
      model: result.model,
      provider: result.provider
    }
  };
}
