/**
 * api/lola-brain.js — Unified AI Brain Orchestrator
 * ════════════════════════════════════════════════════════════════════
 * This is the central nerve center for Lola's decision-making. It 
 * routes every interaction (voice, SMS, chat, tools) through a unified
 * pipeline:
 * 
 * 1. SKILL LAYER — deterministic, instant answers (no LLM needed)
 * 2. LLM LAYER — contextual, personalized responses
 * 3. FALLBACK — built-in answers from tenant data, always works
 * 
 * Every channel (voice, SMS, dashboard) uses this same orchestrator.
 * Environment-aware: works offline with skill layer only, resilient
 * when LLM providers are down.
 */

import { buildLolaSystemPrompt, deterministicSkillReply } from './lib/lola-skills.js';
import { chat } from './lib/llm.js';

/* ─────────────────────────────────────────────────────────────
   UNIFIED BRAIN ORCHESTRATOR
   ───────────────────────────────────────────────────────────── */

export const handleToolCall = async (toolName, args) => {
  // Deprecated: this was the old signature. Routes through lola-tools now.
  if (toolName === 'clear_desk') {
    return { status: "success", message: "Workspace is reset, Jerome. What's next?" };
  }
  return { status: "error", message: "Unknown command" };
};

/**
 * Main entry point: route a user message through all layers
 * ─────────────────────────────────────────────────────────────
 * @param {Object} context — {tenant, channel, userText, clientProfile, conversationHistory}
 * @returns {Object} — {ok, reply, source, intent, metadata}
 * 
 * source = 'skill' | 'llm' | 'builtin' | 'fallback'
 * intent = 'book_appointment' | 'check_availability' | etc.
 */
export async function orchestrateLolaBrain(context = {}) {
  const {
    tenant = null,
    channel = 'voice',        // 'voice' | 'sms' | 'dashboard'
    userText = '',
    clientProfile = null,
    conversationHistory = [],
    options = {}
  } = context;

  const reply = { ok: false, reply: '', source: null, intent: null, metadata: {} };

  if (!userText || !userText.trim()) {
    reply.reply = defaultGreeting(tenant, channel);
    reply.source = 'fallback';
    return reply;
  }

  const text = userText.trim().toLowerCase();

  // ─────────────────────────────────────────────────────────
  // LAYER 1: SKILL LAYER (instant, deterministic)
  // ─────────────────────────────────────────────────────────
  try {
    const { reply: skillReply, intent } = await skillLayerRoute({
      tenant,
      userText,
      channel,
      clientProfile
    });

    if (skillReply) {
      reply.ok = true;
      reply.reply = skillReply;
      reply.source = 'skill';
      reply.intent = intent;
      return reply;
    }
  } catch (e) {
    console.error('[BRAIN] Skill layer error:', e.message);
    // Fall through to LLM
  }

  // ─────────────────────────────────────────────────────────
  // LAYER 2: LLM LAYER (contextual, personalized)
  // ─────────────────────────────────────────────────────────
  try {
    const systemPrompt = buildLolaSystemPrompt({
      tenant,
      channel,
      clientProfile,
      memoryBlock: clientProfile?.memoryBlock || ''
    });

    const messages = [
      ...conversationHistory,
      { role: 'user', content: userText }
    ];

    const llmResult = await chat({
      system: systemPrompt,
      messages,
      maxTokens: channel === 'voice' ? 220 : 500,
      temperature: 0.6,
      source: channel
    });

    if (llmResult.ok && llmResult.text) {
      reply.ok = true;
      reply.reply = llmResult.text.trim();
      reply.source = 'llm';
      reply.metadata.model = llmResult.model;
      reply.metadata.provider = llmResult.provider;
      return reply;
    }
  } catch (e) {
    console.error('[BRAIN] LLM layer error:', e.message);
    // Fall through to builtin
  }

  // ─────────────────────────────────────────────────────────
  // LAYER 3: BUILTIN LAYER (tenant data synthesis)
  // ─────────────────────────────────────────────────────────
  try {
    const builtinReply = synthesizeBuiltinAnswer(tenant, userText);
    if (builtinReply) {
      reply.ok = true;
      reply.reply = builtinReply;
      reply.source = 'builtin';
      return reply;
    }
  } catch (e) {
    console.error('[BRAIN] Builtin layer error:', e.message);
  }

  // ─────────────────────────────────────────────────────────
  // LAYER 4: FALLBACK (always works, minimal)
  // ─────────────────────────────────────────────────────────
  reply.ok = true;
  reply.reply = defaultFallback(channel);
  reply.source = 'fallback';
  return reply;
}

/* ─────────────────────────────────────────────────────────────
   LAYER 1: SKILL LAYER ROUTING
   Deterministic, instant answers — zero LLM cost.
   ───────────────────────────────────────────────────────────── */

async function skillLayerRoute({ tenant, userText, channel, clientProfile }) {
  const text = String(userText || '').toLowerCase();

  // Parse booking intent
  if (/\b(book|schedule|rebook|appointment|pencil\s+in|set\s+up)\b/.test(text)) {
    const booking = extractBookingIntent(text, tenant);
    if (booking && booking.service) {
      return {
        reply: `Perfect — I'm booking you for ${booking.service}${booking.date ? ` on ${booking.date}` : ''}${booking.time ? ` at ${booking.time}` : ''}. One moment to confirm.`,
        intent: 'book_appointment'
      };
    }
  }

  // Parse availability check
  if (/\b(available|openings?|free|slots?|when can|what times?|do you have|is .* (free|open))\b/.test(text)) {
    const availability = extractAvailabilityIntent(text, tenant);
    if (availability) {
      return {
        reply: `Let me check our schedule — we have openings for ${availability.service || 'services'} ${availability.date || 'this week'}. What time works best?`,
        intent: 'check_availability'
      };
    }
  }

  // Parse services/menu query
  if (/\b(service|offer|menu|what do you|pricing|prices|cost|how much)\b/.test(text)) {
    const services = getTenantServices(tenant);
    if (services && services.length > 0) {
      const list = services.slice(0, 3).map(s => `${s.name} ($${s.price})`).join(', ');
      return {
        reply: `Our most popular services: ${list}. Want to book one of these?`,
        intent: 'list_services'
      };
    }
  }

  // Parse hours/location query
  if (/\b(hour|open|close|when are you|location|address|where are you|find you)\b/.test(text)) {
    const info = [];
    if (tenant?.hours) info.push(`We're open ${tenant.hours}`);
    if (tenant?.location) info.push(`You'll find us at ${tenant.location}`);
    if (info.length > 0) {
      return {
        reply: info.join('. '),
        intent: 'tenant_info'
      };
    }
  }

  // No skill match
  return { reply: null, intent: null };
}

/* ─────────────────────────────────────────────────────────────
   LAYER 3: BUILTIN SYNTHESIS
   Answer from tenant data when LLM is unavailable
   ───────────────────────────────────────────────────────────── */

function synthesizeBuiltinAnswer(tenant, userText) {
  if (!tenant) return null;

  const t = String(userText || '').toLowerCase();
  const services = getTenantServices(tenant);
  const name = tenant?.name || 'our salon';

  // Services
  if (/\b(service|offer|menu|list|what do you have)\b/.test(t) && services.length > 0) {
    const list = services.map(s => `${s.name} — $${s.price}`).join(', ');
    return `Here's our menu: ${list}.`;
  }

  // Hours
  if (/\b(hour|open|close|schedule|when)\b/.test(t) && tenant?.hours) {
    return `We're open ${tenant.hours}.`;
  }

  // Location
  if (/\b(location|address|where|find)\b/.test(t) && tenant?.location) {
    return `You'll find us at ${tenant.location}.`;
  }

  // Generic fallback
  return `I'm here to help with ${name}. Ask about booking, services, hours, or anything else!`;
}

/* ─────────────────────────────────────────────────────────────
   INTENT EXTRACTION HELPERS
   ───────────────────────────────────────────────────────────── */

function extractBookingIntent(text, tenant) {
  const t = text.toLowerCase();

  // Service name
  let service = null;
  const services = getTenantServices(tenant);
  for (const s of services) {
    if (t.includes(s.name.toLowerCase())) {
      service = s.name;
      break;
    }
  }

  // Client name (pattern: "for NAME" or "book NAME")
  let clientName = null;
  const nameMatch = text.match(/\bfor\s+([A-Z][a-zA-Z]+)\b/) || text.match(/\bbook\s+([A-Z][a-zA-Z]+)/);
  if (nameMatch && !['a', 'an', 'the', 'me', 'my'].includes(nameMatch[1].toLowerCase())) {
    clientName = nameMatch[1];
  }

  // Date (tomorrow, next Friday, etc.)
  let date = null;
  if (t.includes('tomorrow')) date = 'tomorrow';
  else if (t.match(/\b(next|this)?\s*(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i)) {
    const m = t.match(/\b(?:next|this)?\s*(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
    date = m ? m[1] : null;
  }

  // Time (HH:MM AM/PM or just HH AM/PM)
  let time = null;
  const timeMatch = text.match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i);
  if (timeMatch) time = timeMatch[1];

  return service || date || time || clientName
    ? { service: service || 'appointment', date, time, clientName }
    : null;
}

function extractAvailabilityIntent(text, tenant) {
  const t = text.toLowerCase();

  // Service
  let service = null;
  const services = getTenantServices(tenant);
  for (const s of services) {
    if (t.includes(s.name.toLowerCase())) {
      service = s.name;
      break;
    }
  }

  // Date
  let date = null;
  if (t.includes('tomorrow')) date = 'tomorrow';
  else if (t.includes('today')) date = 'today';
  else if (t.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i)) {
    const m = t.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
    date = m ? m[1] : null;
  }

  return service || date ? { service, date } : null;
}

function getTenantServices(tenant) {
  if (!tenant) return [];
  try {
    const svcs = Array.isArray(tenant.services) ? tenant.services : JSON.parse(tenant.services || '[]');
    return svcs.filter(s => s && (s.name || s)).map(s => ({
      name: s.name || s,
      price: s.price || 0,
      duration: s.duration || null
    }));
  } catch {
    return [];
  }
}

/* ─────────────────────────────────────────────────────────────
   DEFAULT RESPONSES
   ───────────────────────────────────────────────────────────── */

function defaultGreeting(tenant, channel) {
  const name = tenant?.persona?.name || 'Lola';
  const tenantName = tenant?.name || 'the salon';
  if (channel === 'voice') {
    return `Hi, this is ${name} at ${tenantName}. How can I help you today?`;
  }
  return `Hey, I'm ${name}. What can I do for you?`;
}

function defaultFallback(channel) {
  if (channel === 'voice') {
    return 'I can help with booking appointments, pricing, availability, and more. What do you need?';
  }
  if (channel === 'sms') {
    return 'Got it. Reply with what you need — booking, prices, hours, etc.';
  }
  return 'I'm here to help. Tell me what you need.';
}

/* ─────────────────────────────────────────────────────────────
   EXPORT FOR SERVERLESS FUNCTIONS
   ───────────────────────────────────────────────────────────── */

export default orchestrateLolaBrain;
