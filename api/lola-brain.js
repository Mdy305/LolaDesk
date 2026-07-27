import { buildLolaSystemPrompt } from './lib/lola-skills.js';
import { chat } from './lib/llm.js';

export const handleToolCall = async (toolName) => {
  if (toolName === 'clear_desk') {
    return { status: 'success', message: "Workspace is reset. What's next?" };
  }
  return { status: 'error', message: 'Unknown command' };
};

function getTenantServices(tenant) {
  if (!tenant) return [];
  try {
    const services = Array.isArray(tenant.services)
      ? tenant.services
      : JSON.parse(tenant.services || '[]');
    return services
      .filter(service => service && (service.name || service))
      .map(service => ({
        name: service.name || service,
        price: Number(service.price) || 0,
        duration: service.duration || null
      }));
  } catch {
    return [];
  }
}

function extractDate(text) {
  const value = String(text || '').toLowerCase();
  if (value.includes('tomorrow')) return 'tomorrow';
  if (value.includes('today')) return 'today';
  const match = value.match(/\b(?:next|this)?\s*(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
  return match?.[1] || null;
}

function extractTime(text) {
  return String(text || '').match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i)?.[1] || null;
}

async function skillLayerRoute({ tenant, userText }) {
  const text = String(userText || '').toLowerCase();
  const services = getTenantServices(tenant);
  const service = services.find(item => text.includes(item.name.toLowerCase()));

  if (/\b(book|schedule|rebook|appointment|pencil\s+in|set\s+up)\b/.test(text)) {
    const date = extractDate(text);
    const time = extractTime(text);
    if (service || date || time) {
      return {
        reply: `Perfect — I'm helping with ${service?.name || 'that appointment'}${date ? ` on ${date}` : ''}${time ? ` at ${time}` : ''}. One moment to confirm.`,
        intent: 'book_appointment'
      };
    }
  }

  if (/\b(available|openings?|free|slots?|when can|what times?|do you have)\b/.test(text)) {
    return {
      reply: `Let me check the schedule for ${service?.name || 'that service'} ${extractDate(text) || 'this week'}. What time works best?`,
      intent: 'check_availability'
    };
  }

  if (/\b(service|offer|menu|pricing|prices|cost|how much)\b/.test(text) && services.length) {
    const list = services.slice(0, 5).map(item => `${item.name} ($${item.price.toLocaleString('en-US')})`).join(', ');
    return { reply: `Our services include ${list}. Which one are you considering?`, intent: 'list_services' };
  }

  if (/\b(hour|open|close|location|address|where are you|find you)\b/.test(text)) {
    const facts = [];
    if (tenant?.hours) facts.push(`We're open ${tenant.hours}`);
    if (tenant?.location) facts.push(`You'll find us at ${tenant.location}`);
    if (facts.length) return { reply: facts.join('. '), intent: 'tenant_info' };
  }

  return { reply: null, intent: null };
}

function synthesizeBuiltinAnswer(tenant, userText) {
  if (!tenant) return null;
  const text = String(userText || '').toLowerCase();
  const services = getTenantServices(tenant);
  if (/\b(service|offer|menu|list)\b/.test(text) && services.length) {
    return `Here's our menu: ${services.map(item => `${item.name} — $${item.price.toLocaleString('en-US')}`).join(', ')}.`;
  }
  if (/\b(hour|open|close|schedule|when)\b/.test(text) && tenant.hours) return `We're open ${tenant.hours}.`;
  if (/\b(location|address|where|find)\b/.test(text) && tenant.location) return `You'll find us at ${tenant.location}.`;
  return null;
}

function defaultGreeting(tenant, channel) {
  const name = tenant?.persona?.name || 'Lola';
  const tenantName = tenant?.name || 'the salon';
  return channel === 'voice'
    ? `Hi, this is ${name} at ${tenantName}. How can I help you today?`
    : `Hey, I'm ${name}. What can I do for you?`;
}

function defaultFallback(channel) {
  if (channel === 'voice') return 'I can help with booking appointments, pricing, availability, and more. What do you need?';
  if (channel === 'sms') return 'Got it. Reply with what you need — booking, prices, hours, or anything else.';
  return "I'm here to help. Tell me what you need.";
}

export async function orchestrateLolaBrain(context = {}) {
  const {
    tenant = null,
    channel = 'voice',
    userText = '',
    clientProfile = null,
    conversationHistory = []
  } = context;

  if (!String(userText || '').trim()) {
    return { ok: true, reply: defaultGreeting(tenant, channel), source: 'fallback', intent: null, metadata: {} };
  }

  try {
    const skill = await skillLayerRoute({ tenant, userText, channel, clientProfile });
    if (skill.reply) return { ok: true, reply: skill.reply, source: 'skill', intent: skill.intent, metadata: {} };
  } catch (error) {
    console.error('[BRAIN] Skill layer error:', error?.message || error);
  }

  try {
    const result = await chat({
      system: buildLolaSystemPrompt({ tenant, channel, clientProfile, memoryBlock: clientProfile?.memoryBlock || '' }),
      messages: [...conversationHistory, { role: 'user', content: userText }],
      maxTokens: channel === 'voice' ? 220 : 500,
      temperature: 0.6,
      source: channel
    });
    if (result?.ok && result.text) {
      return {
        ok: true,
        reply: result.text.trim(),
        source: 'llm',
        intent: null,
        metadata: { model: result.model, provider: result.provider }
      };
    }
  } catch (error) {
    console.error('[BRAIN] LLM layer error:', error?.message || error);
  }

  const builtin = synthesizeBuiltinAnswer(tenant, userText);
  return {
    ok: true,
    reply: builtin || defaultFallback(channel),
    source: builtin ? 'builtin' : 'fallback',
    intent: null,
    metadata: {}
  };
}

export default orchestrateLolaBrain;
