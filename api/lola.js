/**
 * /api/lola — proxy used by dashboard front-end Voice Control
 * ════════════════════════════════════════════════════════════════
 * This handles the web UI voice orb commands. It supports tool
 * calling by defining Lola's core skills as OpenAI tools. If Lola
 * decides to execute a skill, it is safely routed through the 
 * Supabase Orchestrator in a multi-turn agentic loop.
 */

import { chat } from './lib/llm.js';
import { executeSkill } from './lib/orchestrator.js';
import { SKILLS } from './lola-tools.js';
import { getUserFromToken, bearer } from './lib/auth.js';
import { resolveTenantForUser } from './lib/tenant-access.js';
import { detectEliteIntent, deterministicEliteSkillReply } from './lib/lola-elite-skills.js';
import { resolveDate } from './lib/operator-db.js';

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
// Telnyx can't do tool-calls, so we pull the booking details out of the
// owner's sentence ourselves and run the real book_appointment skill.
function fmtDate(d){ return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }

function extractBooking(text, tenant){
  if(!text) return null;
  const t = text.toLowerCase();
  if(!/\b(book|schedule|rebook|pencil(?:\s+in)?|set\s+up)\b/.test(t)) return null;

  let service = null;
  const svcList = Array.isArray(tenant?.services) ? tenant.services.map(s => (s && (s.name || s))).filter(Boolean) : [];
  for(const s of svcList){ if(t.includes(String(s).toLowerCase())){ service = s; break; } }
  if(!service){
    const kw = ['balayage','colour','color','haircut','cut','styling','blowout','ombre','highlights','keratin','extensions','extension','treatment','facial','manicure','pedicure','wax','massage'];
    for(const k of kw){ if(t.includes(k)){ service = k; break; } }
  }

  let client_name = null;
  const m = text.match(/\bfor\s+([A-Z][a-zA-Z]+)/) || text.match(/\bbook\s+([A-Z][a-zA-Z]+)/);
  if(m && !['a','an','the','me','my'].includes(m[1].toLowerCase())) client_name = m[1];

  let time = null;
  const tm = text.match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i) || text.match(/\b(\d{1,2}:\d{2})\b/);
  if(tm) time = tm[1].replace(/\s+/g,'');

  let date = null;
  if(/\btomorrow\b/.test(t)) date = fmtDate(resolveDate('tomorrow'));
  else if(/\bday after tomorrow\b/.test(t)) date = fmtDate(resolveDate('day after tomorrow'));
  else if(/\btoday\b/.test(t)) date = fmtDate(resolveDate('today'));
  else {
    const wd = t.match(/\b(this|next|coming)?\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
    const inN = t.match(/\bin\s+(\d+)\s+days?\b/);
    if(wd) date = fmtDate(resolveDate(((wd[1] ? wd[1] + ' ' : '') + wd[2]).trim()));
    else if(inN) date = fmtDate(resolveDate('in ' + inN[1] + ' days'));
    else if(/\bnext week\b/.test(t)) date = fmtDate(resolveDate('next week'));
  }

  if(!service && !time && !client_name) return null;
  return { service: service || 'appointment', date, time, client_name };
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if(req.method === 'OPTIONS') return res.status(200).end();
  if(req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try{
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});

    // Owner-scoped: dashboard voice control may only act on the authenticated
    // owner's own tenant. The client-supplied x-tenant-id is ignored — it
    // previously let anyone act on any salon just by passing a slug.
    let tenant = null;
    try{
      const user = await getUserFromToken(bearer(req));
      if(user) tenant = await resolveTenantForUser(user);
    }catch{}
    if (!tenant?.id) return res.status(401).json({ error: 'Not authenticated' });

    let messages = body.messages || [];

    // ── Booking fast-path: write a real appointment from the sentence ──────
    try{
      const lastUserB = [...messages].reverse().find(m => m && m.role === 'user');
      const bText = (lastUserB && (typeof lastUserB.content === 'string' ? lastUserB.content : '')) || '';
      const booking = extractBooking(bText, tenant);
      if(booking){
        const result = await executeSkill(tenant, booking.client_phone || null, 'book_appointment', booking, SKILLS);
        if(result && (result.speak || result.booked !== undefined)){
          return res.status(200).json({
            content: [{ type:'text', text: result.speak || 'Done.' }],
            intent: 'book_appointment', booked: !!result.booked, source: 'skill'
          });
        }
      }
    }catch(e){ /* fall through to skill/conversation */ }

    // ── Skill fast-path (orchestrator) ─────────────────────────────────────
    // Telnyx's inference endpoint rejects tool-calls, so instead of relying on
    // the model to call tools, we detect intent from the user's words and
    // answer straight from the skills layer — instant, on-brand, tenant-aware.
    // No match → fall through to normal conversation below.
    try{
      const lastUser = [...messages].reverse().find(m => m && m.role === 'user');
      const userText = (lastUser && (typeof lastUser.content === 'string' ? lastUser.content : '')) || '';
      if(userText){
        const intent = detectEliteIntent(userText);
        if(intent){
          const reply = deterministicEliteSkillReply({ tenant, intent, channel:'voice' });
          if(reply){
            return res.status(200).json({ content: [{ type:'text', text: reply }], intent, source:'skill' });
          }
        }
      }
    }catch(e){ /* fall through to conversation */ }

    // Step 1: Initial LLM call with tools
    let result = await chat({
      system: body.system,
      messages: messages,
      maxTokens: Math.min(body.max_tokens || 500, 1000),
      temperature: body.temperature ?? 0.7,
      // NOTE: ignore body.model — the dashboard hardcodes an Anthropic model
      // name that the Telnyx provider rejects. Let chat() pick a valid default.
      tools: TOOLS
    });

    if(!result.ok){
      return res.status(502).json({
        type: 'error',
        error: { type: 'upstream_error', message: result.error, provider: result.provider }
      });
    }

    // Step 2: Handle Tool Calls (Agentic Loop)
    if (result.tool_calls && result.tool_calls.length > 0) {
      const toolCall = result.tool_calls[0]; // Process first tool
      const funcName = toolCall.function.name;
      const funcArgs = JSON.parse(toolCall.function.arguments || '{}');
      
      // Add the assistant's tool request to history
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: result.tool_calls
      });

      let toolResultText = "";
      try {
        if (SKILLS[funcName] && tenant) {
           // Execute securely via orchestrator
           const skillOutput = await executeSkill(tenant, funcArgs.client_phone, funcName, funcArgs, SKILLS);
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
      const secondResult = await chat({
        system: body.system,
        messages: messages,
        maxTokens: Math.min(body.max_tokens || 500, 1000),
        temperature: body.temperature ?? 0.7,
        tools: TOOLS
      });

      if(secondResult.ok) {
        result = secondResult;
      }
    }

    const finalText = String(result?.text || '').trim() ||
      'I am on it. Give me the client name, service, and preferred time, and I will handle the next step.';

    // Return in the shape the dashboard expects
    return res.status(200).json({
      id: `msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: finalText }],
      model: result.model,
      provider: result.provider
    });
  }catch(e){
    return res.status(500).json({ type:'error', error:{ type:'server_error', message: String(e) } });
  }
}
