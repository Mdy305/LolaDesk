/**
 * /api/lola-tools — The orchestral skill layer for Lola
 * ════════════════════════════════════════════════════════════════
 * ONE endpoint, MANY skills. Telnyx's Lola assistant calls this for
 * every action. The `tool` field selects the skill. Every call is
 * multi-tenant: we resolve the salon from the called number (or an
 * explicit tenant slug) so the same Lola serves every salon.
 *
 * SKILLS (the orchestra):
 *   check_availability   — open times for a service/day
 *   book_appointment     — write a confirmed booking
 *   capture_lead         — save contact when booking can't complete
 *   get_pricing          — price + duration for a service
 *   recommend_service    — suggest the right service from a goal
 *   list_services        — everything the salon offers
 *   handle_recovery      — win-back logic for lapsed clients
 *   escalate             — take a message / flag for human follow-up
 *
 * Telnyx Tool setup: POST https://www.loladesk.com/api/lola-tools
 *   body: { tool: "check_availability", to: "+1...", service: "...", date: "..." }
 *
 * Returns concise JSON Lola can speak back. Designed to never throw at
 * the caller — failures degrade to a graceful spoken fallback.
 */

import {
  getTenantByPhone, getTenantBySlug, upsertClient, getClientByPhone,
  createBooking, logUsage, getOrStartConversation, getTenantIntegrations
} from './lib/db.js';
import { listAllAppointments, writeAppointment } from './lib/aggregator.js';
import { executeSkill, injectCallerMemory } from './lib/orchestrator.js';

// Resolve which salon this call is for
async function resolveTenant(body){
  if(body.tenant) return getTenantBySlug(body.tenant);
  const to = body.to || body.To || body.called_number || '';
  return getTenantByPhone(to);
}

function findService(tenant, query){
  if(!query) return null;
  const q = String(query).toLowerCase();
  return (tenant.services||[]).find(s =>
    s.name.toLowerCase().includes(q) || q.includes(s.name.toLowerCase())
  );
}

// ── SKILL: list everything offered ──
function list_services(tenant){
  const svc = (tenant.services||[]);
  if(!svc.length) return { speak: "Let me grab our service list for you — one moment.", services: [] };
  const spoken = svc.map(s => `${s.name}${s.price?` at $${s.price}`:''}`).join(', ');
  return { speak: `We offer ${spoken}.`, services: svc };
}

// ── SKILL: pricing for a service ──
function get_pricing(tenant, { service }){
  const s = findService(tenant, service);
  if(!s) return { speak: `I want to quote you exactly right — let me check on ${service||'that'} and confirm.`, found:false };
  return {
    speak: `${s.name} is ${s.price?`$${s.price}`:'priced at consultation'}${s.duration?`, about ${s.duration}`:''}.`,
    found:true, name:s.name, price:s.price, duration:s.duration
  };
}

// ── SKILL: recommend a service from a goal ──
function recommend_service(tenant, { goal }){
  const g = (goal||'').toLowerCase();
  const svc = (tenant.services||[]);
  let pick = null;
  if(/blonde|light|bright|sun|beach/.test(g)) pick = svc.find(s=>/balayage|highlight|blond/i.test(s.name));
  else if(/damage|repair|frizz|smooth/.test(g)) pick = svc.find(s=>/botox|keratin|treatment/i.test(s.name));
  else if(/length|fuller|volume/.test(g)) pick = svc.find(s=>/extension/i.test(s.name));
  else if(/trim|cut|shape/.test(g)) pick = svc.find(s=>/cut/i.test(s.name));
  else if(/event|quick|fresh/.test(g)) pick = svc.find(s=>/blowout|gloss/i.test(s.name));
  pick = pick || svc[0];
  if(!pick) return { speak: "Tell me a bit about what you're hoping for and I'll point you to the perfect service." };
  return {
    speak: `For that, I'd suggest ${pick.name}${pick.price?` — $${pick.price}`:''}. Want me to find you a time?`,
    recommended: pick.name
  };
}

// ── SKILL: check availability ──
async function check_availability(tenant, { service, date }){
  // Pull connected integrations for this tenant (tokens decrypted in-memory here only)
  let appointments = [];
  try{
    const integrations = await getTenantIntegrations(tenant.id);
    if(integrations.length){
      const from = date ? new Date(date).toISOString() : new Date().toISOString();
      const to = new Date(new Date(from).getTime()+7*24*3600*1000).toISOString();
      appointments = await listAllAppointments(integrations, { from, to });
    }
  }catch(e){ /* fall through to generic */ }

  // Without a connected calendar we offer to confirm and call back.
  if(!appointments.length){
    return {
      speak: `Let me find the best ${service||'appointment'} time for you${date?` around ${date}`:''}. I can text you our next openings — what number should I use?`,
      slots: [], needs_callback: true
    };
  }
  // Naive open-slot logic: suggest a few gaps (real version inspects schedule).
  return {
    speak: `I have a few openings${date?` on ${date}`:''} for ${service||'that'}. Would morning or afternoon suit you better?`,
    slots: ['10:00 AM','1:30 PM','4:00 PM']
  };
}

// ── SKILL: book an appointment ──
async function book_appointment(tenant, body){
  const { service, date, time, client_name, client_phone, stylist } = body;
  const s = findService(tenant, service);
  try{
    // upsert the client
    let client = null;
    if(tenant.id && client_phone){
      client = await upsertClient(tenant.id, { phone: client_phone, name: client_name });
    }
    const startsAt = date && time ? new Date(`${date}T${to24(time)}`).toISOString() : null;

    // Try writing to a connected booking platform first
    let external = null;
    try{
      const integrations = await getTenantIntegrations(tenant.id);
      if(integrations.length){
        external = await writeAppointment(integrations, {
          starts_at: startsAt, duration_min: s?.durationMin || 60,
          service: s?.name || service, client: { name: client_name, phone: client_phone }
        });
      }
    }catch(e){ /* fall back to internal booking */ }

    // Always record internally too
    if(tenant.id){
      await createBooking(tenant.id, {
        clientId: client?.id, service: s?.name || service, stylist,
        startsAt, durationMin: s?.durationMin || 60, price: s?.price
      });
      await logUsage(tenant.id, 'booking', 1, { service: s?.name || service });
    }

    let speakStr = `You're all set${client_name?`, ${String(client_name).split(' ')[0]}`:''} — ${s?.name||service}${date?` on ${date}`:''}${time?` at ${time}`:''}${stylist?` with ${stylist}`:''}. `;
    if(tenant.knowledge?.require_deposit) {
      const dep = tenant.knowledge.deposit_amount || '50';
      speakStr += `I'll text you a link to secure your spot with a $${dep} deposit. Anything else?`;
    } else {
      speakStr += `I'll text you a confirmation. Anything else?`;
    }

    return {
      speak: speakStr,
      booked: true, external: !!external, deposit_required: !!tenant.knowledge?.require_deposit
    };
  }catch(e){
    return {
      speak: `I've got your request for ${service||'that'}. Let me confirm it and text you right back — what's the best number?`,
      booked: false, needs_callback: true
    };
  }
}

// ── SKILL: capture a lead ──
async function capture_lead(tenant, { client_name, client_phone, service_requested }){
  try{
    if(tenant.id && client_phone){
      const client = await upsertClient(tenant.id, { phone: client_phone, name: client_name });
      await logUsage(tenant.id, 'lead', 1, { service: service_requested, name: client_name });
    }
    return {
      speak: `Got it${client_name?`, ${String(client_name).split(' ')[0]}`:''} — I've noted you're interested in ${service_requested||'a visit'} and the team will reach out shortly. Thank you for calling!`,
      captured: true
    };
  }catch(e){
    return { speak: `Thank you — I've passed your details to the team and they'll be in touch soon.`, captured:false };
  }
}

// ── SKILL: recovery (win-back) ──
function handle_recovery(tenant, { client_name }){
  return {
    speak: `It's lovely to hear from you again${client_name?`, ${client_name}`:''}! We'd love to have you back. Should I find you a time this week?`
  };
}

// ── SKILL: escalate / take a message ──
async function escalate(tenant, { message, client_phone, client_name }){
  try{ if(tenant.id) await logUsage(tenant.id, 'escalation', 1, { message, client_name, client_phone }); }catch{}
  return { speak: `I've made a note for the team and they'll follow up with you personally. Is there anything else I can help with right now?` };
}

function to24(t){
  // accepts "2:00 PM" or "14:00" -> "14:00:00"
  if(/^\d{1,2}:\d{2}$/.test(t)) return t+':00';
  const m = String(t).match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if(!m) return '10:00:00';
  let h = +m[1]; const min = m[2]; const ap = (m[3]||'').toUpperCase();
  if(ap==='PM' && h<12) h+=12; if(ap==='AM' && h===12) h=0;
  return `${String(h).padStart(2,'0')}:${min}:00`;
}

const SKILLS = {
  list_services, get_pricing, recommend_service,
  check_availability, book_appointment, capture_lead,
  handle_recovery, escalate
};

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method === 'OPTIONS') return res.status(200).end();
  if(req.method !== 'POST') return res.status(405).json({ speak:'Method not allowed' });

  try{
    const body = typeof req.body === 'string' ? JSON.parse(req.body||'{}') : (req.body||{});
    const tool = body.tool || body.function || body.skill;
    
    // Special Memory Injection Skill requested by Telnyx to start a call
    if (tool === 'inject_memory') {
      const tenant = await resolveTenant(body);
      const clientPhone = body.from || body.client_phone;
      const memoryPrompt = await injectCallerMemory(tenant?.id, clientPhone);
      return res.status(200).json({ speak: "Memory loaded.", memory: memoryPrompt });
    }

    if(!tool || !SKILLS[tool]){
      return res.status(200).json({ speak: "I can help with booking, pricing, or recommendations — what would you like?", available_tools: Object.keys(SKILLS) });
    }
    
    const tenant = await resolveTenant(body);
    const clientPhone = body.client_phone || body.from;
    
    // Execute the skill safely via Orchestrator
    const result = await executeSkill(tenant, clientPhone, tool, body, SKILLS);
    
    return res.status(200).json(result);
  }catch(e){
    console.error('[lola-tools] Error:', e);
    return res.status(200).json({ speak: "I'm having a quick technical moment — let me take your number and have someone call you right back.", _error: String(e) });
  }
}
