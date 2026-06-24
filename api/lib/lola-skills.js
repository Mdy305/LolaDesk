import { tenantKnowledgePrompt } from './db.js';

const SKILLS = [
  { id: 'booking_new', name: 'Book appointments' },
  { id: 'booking_change', name: 'Reschedule or cancel appointments' },
  { id: 'booking_confirm', name: 'Confirm upcoming appointments' },
  { id: 'pricing', name: 'Quote services with clear pricing' },
  { id: 'hours', name: 'Answer business hours questions' },
  { id: 'location', name: 'Answer location and directions questions' },
  { id: 'recommendation', name: 'Recommend the best service path for client goals' },
  { id: 'product_retail', name: 'Recommend take-home products and care routines' },
  { id: 'policy', name: 'Explain salon policies (deposit, cancellation, lateness)' },
  { id: 'feedback', name: 'Capture and learn from client feedback to personalize future service' },
  { id: 'complaint_recovery', name: 'Handle service issues with premium recovery language' },
  { id: 'lead_capture', name: 'Capture undecided leads and convert to booked follow-up' },
  { id: 'human_handoff', name: 'Escalate to owner/stylist on request' },
  { id: 'owner_assistant', name: 'Support owner/stylists with no-shows, rebooking, follow-up actions' }
];

function low(v){
  return String(v || '').toLowerCase();
}

function hasAny(text, words){
  const t = low(text);
  return words.some(w => t.includes(w));
}

function serviceList(tenant){
  const services = Array.isArray(tenant?.services) ? tenant.services : [];
  return services
    .slice(0, 4)
    .map(s => `${s.name}${s.price ? ` ($${s.price})` : ''}`)
    .join(', ');
}

export function detectLolaIntent(text){
  const t = low(text);
  if(!t.trim()) return 'greeting';
  if(hasAny(t, ['human','person','agent','manager','owner','stylist','representative'])) return 'human_handoff';
  if(hasAny(t, ['hold on','one second','wait','give me a sec','hang on'])) return 'interruption';
  if(hasAny(t, ['confirm my appointment','am i booked','do i have an appointment','confirm booking'])) return 'booking_confirm';
  if(hasAny(t, ['cancel','reschedule','move my appointment','change my appointment'])) return 'booking_change';
  if(hasAny(t, ['book','appointment','availability','opening','schedule me','slot'])) return 'booking_new';
  if(hasAny(t, ['price','cost','how much','quote'])) return 'pricing';
  if(hasAny(t, ['deposit','policy','cancellation policy','late policy','refund'])) return 'policy';
  if(hasAny(t, ['hours','open','close','today','tomorrow'])) return 'hours';
  if(hasAny(t, ['address','located','where are you','location','parking'])) return 'location';
  if(hasAny(t, ['product','shampoo','conditioner','aftercare','home care','care routine'])) return 'product_retail';
  if(hasAny(t, ['not happy','complaint','issue','problem','fix my hair','redo'])) return 'complaint_recovery';
  if(hasAny(t, ['feedback','thanks','thank you','amazing','perfect','loved it','love the result'])) return 'feedback';
  if(hasAny(t, ['just browsing','not ready','thinking about it','maybe later','not sure yet'])) return 'lead_capture';
  if(hasAny(t, ['recommend','suggest','what should i get','best for'])) return 'recommendation';
  if(hasAny(t, ['no show','rebook','follow up','follow-up','fill gaps','retention','owner','stylist dashboard'])) return 'owner_assistant';
  return 'general';
}

export function deterministicSkillReply({ tenant, intent, channel='voice', clientName='' }){
  const name = clientName ? ` ${clientName}` : '';
  const bookingUrl = tenant?.booking_url || '';
  const services = serviceList(tenant);
  switch(intent){
    case 'hours':
      return tenant?.hours
        ? `We are open ${tenant.hours}. Do you want me to help you book the best time?`
        : 'I can help you book right now. What day works best for you?';
    case 'location':
      return tenant?.location
        ? `We are located in ${tenant.location}. Want me to set your appointment now?`
        : 'I can help you schedule now. What day and time are best for you?';
    case 'pricing':
      if(services) return `Our most requested services are ${services}. Tell me your goal and I will recommend the best option.`;
      return 'Tell me what result you want and I will recommend the right service and price range.';
    case 'booking_new':
      if(channel === 'sms' && bookingUrl){
        return `Perfect${name}. I can book this now or you can use ${bookingUrl}. What service, day, and time do you prefer?`;
      }
      return `Perfect${name}. I can help you book now. What service, day, and preferred time should I lock in?`;
    case 'booking_change':
      return 'Absolutely. I can help change or cancel your appointment. Share your full name and current appointment day/time.';
    case 'booking_confirm':
      return 'Absolutely. I can confirm that for you now. Please share your full name and the best phone number on the booking.';
    case 'interruption':
      return channel === 'voice'
        ? 'Of course, take your time. I am here when you are ready.'
        : 'Of course - take your time. I am here when you are ready.';
    case 'human_handoff':
      return 'Absolutely. I will route this to the team now. What is the best callback number and your name?';
    case 'policy':
      return 'Great question. I can explain our deposit, cancellation, and late-arrival policy clearly—what part should I confirm first?';
    case 'product_retail':
      return 'Absolutely. I can recommend the best home-care routine for your hair goals and service history. What result do you want most?';
    case 'complaint_recovery':
      return 'I am so sorry this happened. We will make this right right away—please share your name, service date, and the fastest callback number.';
    case 'feedback':
      return 'Thank you for the feedback—I just saved it to personalize your next visit. Want me to recommend your best next service based on that?';
    case 'lead_capture':
      return channel === 'sms'
        ? 'Totally fine. I can hold a priority consult spot and text you two ideal times—what day works best?'
        : 'Totally fine. I can hold a priority consult slot and give you two best options. What day works best?';
    case 'owner_assistant':
      return 'Yes. I can help with no-show recovery, rebooking, follow-up campaigns, and schedule-gap filling. Which one should we run first?';
    default:
      return '';
  }
}

export function detectConversationMood(text){
  const t = low(text);
  if(hasAny(t, ['not happy','upset','angry','problem','issue','complaint','disappointed','frustrated'])) return 'recovery';
  if(hasAny(t, ['love','amazing','perfect','thank you','thanks'])) return 'delighted';
  if(hasAny(t, ['urgent','asap','right now','immediately'])) return 'urgent';
  return 'neutral';
}

export function evaluateInteractionQuality({ intent='general', mood='neutral', personalized=false, reply='', userText='', channel='voice' }){
  let score = 65;
  if(intent !== 'general') score += 10;
  if(intent === 'booking_new' || intent === 'booking_change' || intent === 'booking_confirm') score += 6;
  if(personalized) score += 10;
  if(mood === 'recovery' && /sorry|make this right|right away/i.test(reply)) score += 7;
  if(mood === 'urgent' && /now|right away|immediately|priority/i.test(reply)) score += 5;
  if(channel === 'voice' && reply.length < 180) score += 4;
  if(channel !== 'voice' && reply.length < 260) score += 4;
  if(String(userText || '').length > 0 && String(reply || '').length < 12) score -= 12;
  score = Math.max(0, Math.min(100, score));
  const level = score >= 86 ? 'elite' : score >= 72 ? 'strong' : 'needs_tuning';
  return { score, level };
}

function uniq(items){
  return [...new Set((items || []).map(v => String(v || '').trim()).filter(Boolean))];
}

export function extractPersonalizationSignals(text){
  const t = String(text || '').trim();
  const l = low(t);
  const out = {
    preferences: [],
    dislikes: [],
    allergies: [],
    goals: [],
    feedback: null,
    hasSignal: false
  };

  const prefMatch = t.match(/(?:i prefer|i like|please use|i want)\s+([^.!?\n]{3,120})/i);
  if(prefMatch) out.preferences.push(prefMatch[1].trim());
  const dislikeMatch = t.match(/(?:i don't like|i do not like|avoid|no)\s+([^.!?\n]{2,120})/i);
  if(dislikeMatch) out.dislikes.push(dislikeMatch[1].trim());
  const allergyMatch = t.match(/(?:allergic to|allergy to|sensitive to)\s+([^.!?\n]{2,120})/i);
  if(allergyMatch) out.allergies.push(allergyMatch[1].trim());
  const goalMatch = t.match(/(?:i want|goal is|trying to|get me)\s+([^.!?\n]{3,120})/i);
  if(goalMatch) out.goals.push(goalMatch[1].trim());

  if(hasAny(l, ['not happy','problem','issue','bad','disappointed','redo'])){
    out.feedback = { sentiment: 'negative', note: t.slice(0, 220) };
  }else if(hasAny(l, ['love','loved','amazing','great','perfect','thank you','thanks'])){
    out.feedback = { sentiment: 'positive', note: t.slice(0, 220) };
  }

  out.preferences = uniq(out.preferences);
  out.dislikes = uniq(out.dislikes);
  out.allergies = uniq(out.allergies);
  out.goals = uniq(out.goals);
  out.hasSignal = !!(out.preferences.length || out.dislikes.length || out.allergies.length || out.goals.length || out.feedback);
  return out;
}

export function profileFromMemoryRows(rows){
  const profile = { preferences: [], dislikes: [], allergies: [], goals: [], recent_feedback: [] };
  for(const row of (rows || [])){
    if(row?.key !== 'profile') continue;
    const v = row.value && typeof row.value === 'object' ? row.value : {};
    profile.preferences = uniq([...(profile.preferences || []), ...((v.preferences) || [])]);
    profile.dislikes = uniq([...(profile.dislikes || []), ...((v.dislikes) || [])]);
    profile.allergies = uniq([...(profile.allergies || []), ...((v.allergies) || [])]);
    profile.goals = uniq([...(profile.goals || []), ...((v.goals) || [])]);
    profile.recent_feedback = (v.recent_feedback || []).slice(-6);
  }
  return profile;
}

export function mergeClientProfile(profile, signals){
  const base = profile && typeof profile === 'object' ? profile : {};
  const merged = {
    preferences: uniq([...(base.preferences || []), ...(signals.preferences || [])]).slice(-10),
    dislikes: uniq([...(base.dislikes || []), ...(signals.dislikes || [])]).slice(-10),
    allergies: uniq([...(base.allergies || []), ...(signals.allergies || [])]).slice(-8),
    goals: uniq([...(base.goals || []), ...(signals.goals || [])]).slice(-10),
    recent_feedback: [...(base.recent_feedback || [])]
  };
  if(signals.feedback){
    merged.recent_feedback.push({
      sentiment: signals.feedback.sentiment,
      note: signals.feedback.note,
      at: new Date().toISOString()
    });
    merged.recent_feedback = merged.recent_feedback.slice(-8);
  }
  return merged;
}

export function buildClientMemoryBlock(profile){
  if(!profile) return '';
  const lines = [];
  if(profile.preferences?.length) lines.push(`Client preferences: ${profile.preferences.join('; ')}`);
  if(profile.dislikes?.length) lines.push(`Avoid / dislikes: ${profile.dislikes.join('; ')}`);
  if(profile.allergies?.length) lines.push(`Allergies / sensitivities: ${profile.allergies.join('; ')}`);
  if(profile.goals?.length) lines.push(`Client goals: ${profile.goals.join('; ')}`);
  const fb = (profile.recent_feedback || []).slice(-3);
  if(fb.length){
    lines.push(`Recent feedback:\n${fb.map(f => `- (${f.sentiment}) ${f.note}`).join('\n')}`);
  }
  return lines.join('\n');
}

export function buildLolaSystemPrompt({ tenant, channel='voice', intent='general', mood='neutral', memoryBlock='' }){
  const kb = tenantKnowledgePrompt(tenant);
  const skills = SKILLS.map(s => `- ${s.id}: ${s.name}`).join('\n');
  return `You are Lola, the world-class AI front desk manager and salon assistant.
You sound human, fast, warm, and precise. Keep replies concise and actionable.

CHANNEL: ${channel}
DETECTED_INTENT: ${intent}
MOOD: ${mood}

BUSINESS KNOWLEDGE:
${kb}

ACTIVE SKILLS:
${skills}

CLIENT MEMORY:
${memoryBlock || 'No saved client memory yet.'}

OPERATING RULES:
- Move every conversation to a clear next step (book, rebook, confirm details, or handoff).
- Ask only one clarifying question at a time.
- Never invent business facts, pricing, or availability.
- If asked for a person, acknowledge and capture callback details.
- For booking requests, collect service + day + time and propose the next best action immediately.
- Use stored feedback and preferences to personalize recommendations and language.
- Sound like a real luxury concierge, not a bot: natural phrasing, calm confidence, no robotic disclaimers.
- If MOOD is recovery, lead with empathy and ownership before logistics.
- If MOOD is urgent, acknowledge urgency and offer the fastest next action.
- Keep SMS replies to 1-3 sentences; keep voice replies to 1-2 short sentences.`;
}
