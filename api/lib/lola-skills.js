import { tenantKnowledgePrompt } from './db.js';
import { 
  PAYMENT_SKILLS, INVENTORY_SKILLS, CLIENT_SKILLS, MARKETING_SKILLS,
  ADVANCED_BOOKING_SKILLS, TEAM_SKILLS, COMMUNICATION_SKILLS, QUALITY_SKILLS,
  CONCIERGE_SKILLS, INTEGRATION_SKILLS, ALL_ELITE_SKILLS,
  detectEliteIntent, deterministicEliteSkillReply 
} from './lola-elite-skills.js';

const SKILLS = [
  // TIER 1: CORE BOOKING (Foundation)
  { id: 'booking_new', name: 'Book appointments' },
  { id: 'booking_change', name: 'Reschedule or cancel appointments' },
  { id: 'booking_confirm', name: 'Confirm upcoming appointments' },
  { id: 'booking_multi', name: 'Book multiple services in single visit' },
  { id: 'booking_package', name: 'Suggest and book service packages' },
  
  // TIER 2: AVAILABILITY & INTELLIGENCE (Smart Scheduling)
  { id: 'waitlist', name: 'Add to waitlist for fully booked times' },
  { id: 'urgent_slot', name: 'Find emergency/same-day slots' },
  { id: 'stylist_match', name: 'Match client to best-fit stylist' },
  
  // TIER 3: PRICING & VALUE (Revenue)
  { id: 'pricing', name: 'Quote services with clear pricing' },
  { id: 'upsell', name: 'Suggest complementary services to maximize visit value' },
  { id: 'loyalty', name: 'Explain loyalty program and rewards' },
  { id: 'first_time_discount', name: 'Apply first-time client promotions' },
  
  // TIER 4: PERSONALIZATION (CRM Intelligence)
  { id: 'recommendation', name: 'Recommend best service for client goals' },
  { id: 'product_retail', name: 'Recommend take-home products and care routines' },
  { id: 'preference_capture', name: 'Understand and save client preferences (length, color, etc.)' },
  { id: 'service_history', name: 'Reference client service history for consistency' },
  
  // TIER 5: POLICY & COMPLIANCE (Rules Engine)
  { id: 'policy', name: 'Explain deposit, cancellation, lateness policies' },
  { id: 'deposit_payment', name: 'Collect deposits online with secure payment' },
  { id: 'no_show_policy', name: 'Handle no-show charges and rescheduling' },
  
  // TIER 6: FEEDBACK & RECOVERY (Quality)
  { id: 'feedback', name: 'Capture feedback to personalize future visits' },
  { id: 'complaint_recovery', name: 'Handle service issues with premium recovery' },
  { id: 'satisfaction_survey', name: 'Conduct post-appointment satisfaction check' },
  
  // TIER 7: LEAD CONVERSION (Growth)
  { id: 'lead_capture', name: 'Convert undecided leads to booked follow-up' },
  { id: 'follow_up_schedule', name: 'Recommend optimal follow-up timing' },
  { id: 'referral_incentive', name: 'Activate referral rewards' },
  
  // TIER 8: BUSINESS OPERATIONS (Owner Tools)
  { id: 'owner_no_shows', name: 'Detect and recover from no-show patterns' },
  { id: 'owner_retention', name: 'Identify at-risk clients and trigger re-engagement' },
  { id: 'owner_gaps', name: 'Fill schedule gaps with targeted outreach' },
  { id: 'owner_calendar', name: 'Manage stylist calendars and cross-utilization' },
  
  // TIER 9: SPECIAL REQUESTS (Premium)
  { id: 'hours', name: 'Answer business hours and availability' },
  { id: 'location', name: 'Answer location, parking, and directions' },
  { id: 'event_package', name: 'Handle group bookings and event services' },
  { id: 'gift_card', name: 'Sell and redeem gift cards' },
  
  // TIER 10: ESCALATION (Safety)
  { id: 'complaint_escalation', name: 'Escalate serious issues to management' },
  { id: 'human_handoff', name: 'Escalate to owner/stylist on request' },
  { id: 'callback_schedule', name: 'Schedule human callback at preferred time' },
  
  // TIER 11: PAYMENT & FINANCIAL (NEW)
  ...PAYMENT_SKILLS,
  
  // TIER 12: INVENTORY & PRODUCTS (NEW)
  ...INVENTORY_SKILLS,
  
  // TIER 13: CLIENT SEGMENTATION (NEW)
  ...CLIENT_SKILLS,
  
  // TIER 14: MARKETING & ANALYTICS (NEW)
  ...MARKETING_SKILLS,
  
  // TIER 15: ADVANCED BOOKING (NEW)
  ...ADVANCED_BOOKING_SKILLS,
  
  // TIER 16: TEAM OPERATIONS (NEW)
  ...TEAM_SKILLS,
  
  // TIER 17: COMMUNICATION & CHANNELS (NEW)
  ...COMMUNICATION_SKILLS,
  
  // TIER 18: QUALITY & FEEDBACK (NEW)
  ...QUALITY_SKILLS,
  
  // TIER 19: CONCIERGE SERVICES (NEW)
  ...CONCIERGE_SKILLS,
  
  // TIER 20: INTEGRATIONS & STATUS (NEW)
  ...INTEGRATION_SKILLS,
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
  
  // BOOKING INTENTS (expanded)
  if(hasAny(t, ['confirm my appointment','am i booked','do i have an appointment','confirm booking'])) return 'booking_confirm';
  if(hasAny(t, ['cancel','reschedule','move my appointment','change my appointment'])) return 'booking_change';
  if(hasAny(t, ['book','appointment','availability','opening','schedule me','slot','two appointments','two services','combo','package'])) return 'booking_new';
  if(hasAny(t, ['same day','emergency','today','asap','urgent','right now','fit me in'])) return 'urgent_slot';
  if(hasAny(t, ['waitlist','wait list','if someone cancels','backup','standby'])) return 'waitlist';
  
  // AVAILABILITY & MATCHING
  if(hasAny(t, ['which stylist','who is best','recommend a stylist','whoever is','specific person','work with'])) return 'stylist_match';
  
  // PRICING & VALUE
  // 'refer' is specific; check before generic pricing words like 'discount'
  if(hasAny(t, ['refer','bring a friend','tell my friend','recommend you to'])) return 'referral_incentive';
  if(hasAny(t, ['price','cost','how much','quote','expensive','discount','cheap','promo','deal'])) return 'pricing';
  if(hasAny(t, ['loyalty','reward','points','member','frequent','vip'])) return 'loyalty';
  if(hasAny(t, ['first time','new client','first visit','never been'])) return 'first_time_discount';
  if(hasAny(t, ['two','both','also get','add on','throw in','more'])) return 'upsell';
  
  // POLICIES
  if(hasAny(t, ['deposit','policy','cancellation policy','late policy','refund','no show'])) return 'policy';
  
  // PERSONALIZATION & HISTORY
  if(hasAny(t, ['i have','remember','last time','same as','like before','prefer','length','color','layers','bangs','thick'])) return 'service_history';
  if(hasAny(t, ['product','shampoo','conditioner','aftercare','home care','care routine','mask','serum'])) return 'product_retail';
  if(hasAny(t, ['not happy','complaint','issue','problem','fix my hair','redo','bad','disappointed'])) return 'complaint_recovery';
  if(hasAny(t, ['feedback','thanks','thank you','amazing','perfect','loved it','love the result','so happy'])) return 'feedback';
  if(hasAny(t, ['recommend','suggest','what should i get','best for','what do you think','which'])) return 'recommendation';
  if(hasAny(t, ['my allergy','sensitive to','allergic','don\'t use','no chemicals','sulfate free'])) return 'preference_capture';
  
  // LEAD & CONVERSION
  if(hasAny(t, ['just browsing','not ready','thinking about it','maybe later','not sure yet','interested but'])) return 'lead_capture';
  if(hasAny(t, ['gift card','someone gave me','gift','birthday gift'])) return 'gift_card';
  
  // GROUP/EVENT BOOKINGS
  if(hasAny(t, ['group','wedding','getting married','bridesmaids','event','party','bridal','quincea','prom','photoshoot'])) return 'event_package';
  
  // OWNER/OPERATIONS
  if(hasAny(t, ['no show','rebook','follow up','follow-up','fill gaps','retention','owner','stylist dashboard','schedule gaps'])) return 'owner_assistant';
  if(hasAny(t, ['when should i','best time to','how often','schedule next','book ahead'])) return 'follow_up_schedule';
  
  // GENERAL INFO
  if(hasAny(t, ['hours','open','close','today','tomorrow','sunday','monday'])) return 'hours';
  if(hasAny(t, ['address','located','where are you','location','parking','directions','google'])) return 'location';
  if(hasAny(t, ['call me back','someone from the salon','speak to','talk to'])) return 'callback_schedule';
  
  // Try elite intent detection for new 60+ skills
  const eliteIntent = detectEliteIntent(text);
  if(eliteIntent !== 'general') return eliteIntent;
  
  return 'general';
}

export function deterministicSkillReply({ tenant, intent, channel='voice', clientName='', isFirstTime=false }){
  const name = clientName ? ` ${clientName}` : '';
  const bookingUrl = tenant?.booking_url || '';
  const services = serviceList(tenant);
  const company = tenant?.name || 'our salon';
  
  switch(intent){
    // TIER 1: CORE BOOKING
    case 'booking_new':
      if(channel === 'sms' && bookingUrl){
        return `Perfect${name}! This is Lola at ${company}. I can book you now or send the link. What service, day, and time do you prefer?`;
      }
      return `Perfect${name}! This is Lola at ${company}. What service, day, and preferred time should I lock in?`;
    
    case 'booking_change':
      return `Hi${name}! It's Lola at ${company}. I can change your appointment—share your full name and current booking details.`;
    
    case 'booking_confirm':
      return `Hi${name}! It's Lola at ${company}. I'll confirm your appointment. Full name and phone number on the booking, please.`;
    
    case 'booking_multi':
      return `Love it${name}—multitasking at ${company}! What two services together, and when?`;
    
    case 'booking_package':
      return `Great${name}! At ${company}, we have package deals that save you time and money. Color + cut, maintenance boost, or full pampering day?`;
    
    // TIER 2: AVAILABILITY & INTELLIGENCE
    case 'urgent_slot':
      return `This is Lola at ${company}. I can find you something today or tomorrow${name}. What service and time window works best?`;
    
    case 'waitlist':
      return `Smart move${name}! I'll add you to ${company}'s priority waitlist. When do you want to be on standby for?`;
    
    case 'stylist_match':
      return `Hi${name}, Lola here at ${company}. I'll match you with the perfect stylist. What's your hair type and what result do you want?`;
    
    // TIER 3: PRICING & VALUE
    case 'pricing':
      if(services) return `At ${company}, we offer ${services}. Tell me your goal and I'll recommend the best option and price.`;
      return `At ${company}, I can recommend the perfect service for your goal. What result are you hoping for?`;
    
    case 'loyalty':
      return `Great question! At ${company}, every appointment earns points for free services and exclusive perks. Want to join our VIP club today?`;
    
    case 'first_time_discount':
      return `New here? Perfect! I can lock in your first-time discount at ${company} right now, plus loyalty rewards. What service sounds best?`;
    
    case 'upsell':
      return `Smart combo${name}! Adding a gloss or shine at ${company} takes 15 more minutes—want me to add it on?`;
    
    // TIER 4: PERSONALIZATION
    case 'recommendation':
      return `Hi${name}! I'm Lola at ${company}. Tell me what result you're hoping for and I'll find the perfect service.`;
    
    case 'product_retail':
      return `Absolutely${name}! Lola at ${company} here. Based on your service, I'll recommend home-care products that keep everything looking salon-fresh.`;
    
    case 'preference_capture':
      return `Got it${name}—Lola is saving that to your ${company} profile so every stylist knows exactly what you love.`;
    
    case 'service_history':
      return `Hi${name}! Lola at ${company} here. I see your last service was amazing. Want that same magic, or ready to switch it up?`;
    
    // TIER 5: POLICIES
    case 'policy':
      return `At ${company}, we have a simple policy: deposit holds your slot, 48-hour cancellation is free, and we guarantee 100% redo if you're not thrilled.`;
    
    case 'no_show_policy':
      return `I get it${name}—life happens. At ${company}, miss two and a $25 fee applies, unless you give us 24 hours notice. Can I rebook you now?`;
    
    case 'deposit_payment':
      return `Perfect${name}! I can collect your $25-50 deposit securely via text link right now. Sound good?`;
    
    // TIER 6: FEEDBACK & QUALITY
    case 'feedback':
      return `Thank you so much${name}! Lola at ${company} just saved that to personalize your next visit. Want to book your next appointment now?`;
    
    case 'complaint_recovery':
      return `I'm so sorry${name}. Lola at ${company} here. We will make this right—please share your name, service date, and fastest callback number. Flagging our team now.`;
    
    case 'satisfaction_survey':
      return `Hi${name}, quick question: on a scale of 1-10, how happy are you with your ${company} appointment? Anything we could do better?`;
    
    // TIER 7: LEAD CONVERSION
    case 'lead_capture':
      return channel === 'sms'
        ? `Totally fine! Lola at ${company} here. I can hold a priority spot and text two ideal times—what day works?`
        : `Totally fine${name}! Lola at ${company} will hold a priority slot. What day works best?`;
    
    case 'follow_up_schedule':
      return `Smart thinking${name}! At ${company}, I'd recommend rebooking in 6-8 weeks to keep everything fresh. Want me to hold that spot?`;
    
    case 'referral_incentive':
      return `Love that you'd refer us${name}! Here's the deal at ${company}: your friend gets 20% off, you both get $25. Sound good?`;
    
    // TIER 8: BUSINESS OPERATIONS
    case 'owner_assistant':
      return `Yes! Lola at ${company} can help with no-shows, rebooking, targeting at-risk clients, and filling schedule gaps. What first?`;
    
    case 'owner_no_shows':
      return `Lola here at ${company}. I see a no-show pattern last month. Want me to send a 15% "we miss you" re-engagement text?`;
    
    case 'owner_gaps':
      return `Lola at ${company}: I found 3 open slots this week. Want me to text past clients to fill them?`;
    
    case 'owner_calendar':
      return `Lola here: I can see your ${company} team calendars. Some stylists are busier than others. Want me to suggest rebooking?`;
    
    // TIER 9: SPECIAL REQUESTS
    case 'hours':
      return tenant?.hours
        ? `At ${company}, we're open ${tenant.hours}. Want me to help you book the best time?`
        : `This is Lola at ${company}. I can help you book right now. What day works best for you?`;
    
    case 'location':
      return tenant?.location
        ? `At ${company}, we're located in ${tenant.location}. Want me to set your appointment now?`
        : `This is Lola at ${company}. I can help you schedule now. What day and time works?`;
    
    case 'event_package':
      return `Congratulations${name}! Lola at ${company} specializes in group bookings. How many people, what's the event, and when?`;
    
    case 'gift_card':
      return `Perfect gift${name}! Gift cards at ${company} start at $25 and never expire. Digital or physical card?`;
    
    // TIER 10: ESCALATION
    case 'callback_schedule':
      return `Absolutely${name}! Lola at ${company} here. What's your best number and best time for our team to call back?`;
    
    case 'complaint_escalation':
      return `I'm taking this seriously${name}. Lola at ${company} is connecting you with management right now. Stay on the line for one second?`;
    
    case 'human_handoff':
      return `Hi${name}! Lola at ${company} here. I'll route this to the team now. Best callback number and your full name?`;
    
    case 'interruption':
      return channel === 'voice'
        ? 'Of course, take your time. I am here when you are ready.'
        : 'Of course - take your time. I am here when you are ready.';
    
    default:
      // Try elite skills (Tiers 11-20: Payment, Inventory, Analytics, etc.)
      const eliteReply = deterministicEliteSkillReply({ tenant, intent, channel, clientName });
      return eliteReply;
  }
}

export function detectConversationMood(text){
  const t = low(text);
  if(hasAny(t, ['not happy','upset','angry','problem','issue','complaint','disappointed','frustrated','bad experience','redo'])) return 'recovery';
  if(hasAny(t, ['love','amazing','perfect','thank you','thanks','so happy','obsessed','gorgeous','best','favorite'])) return 'delighted';
  if(hasAny(t, ['urgent','asap','right now','immediately','today','emergency','dying to','can\'t wait'])) return 'urgent';
  if(hasAny(t, ['first time','new client','never been','first visit','heard about you'])) return 'new_customer';
  if(hasAny(t, ['longtime','been coming','years','always','regular','loyal'])) return 'loyal_customer';
  return 'neutral';
}

export function evaluateInteractionQuality({ intent='general', mood='neutral', personalized=false, reply='', userText='', channel='voice', isUrgent=false, isFirstTime=false }){
  let score = 65;
  
  // Intent quality boost
  const highValueIntents = [
    'booking_new', 'booking_change', 'booking_confirm', 'booking_multi', 'booking_package',
    'waitlist', 'urgent_slot', 'stylist_match',
    'upsell', 'loyalty', 'first_time_discount',
    'recommendation', 'service_history', 'preference_capture',
    'complaint_recovery', 'satisfaction_survey',
    'referral_incentive', 'follow_up_schedule',
    'owner_no_shows', 'owner_gaps', 'owner_calendar'
  ];
  
  if(intent !== 'general') score += 10;
  if(highValueIntents.includes(intent)) score += 8;
  if(personalized) score += 15;
  
  // Mood-appropriate responses
  if(mood === 'recovery' && /sorry|make this right|right away|immediately/i.test(reply)) score += 12;
  if(mood === 'delighted' && /thank|love|referr|point|reward/i.test(reply)) score += 8;
  if(mood === 'urgent' && /right now|immediately|today|asap/i.test(reply)) score += 10;
  if(mood === 'new_customer' && /first|welcome|new|loyalty|vip/i.test(reply)) score += 10;
  if(mood === 'loyal_customer' && /great to see you|always|great client|appreciate/i.test(reply)) score += 10;
  
  // Conciseness (varies by channel & intent)
  const targetLength = channel === 'voice' ? 160 : 240;
  if(reply.length < targetLength) score += 5;
  if(reply.length > targetLength * 2) score -= 5;
  
  // Multi-turn engagement
  if(/\?/.test(reply)) score += 3; // question = engagement
  if(/what|how|tell me|share/i.test(reply)) score += 2;
  
  // Zero response = bad
  if(String(userText || '').length > 3 && String(reply || '').length < 8) score -= 15;
  
  // Business metrics
  if(/book|confirm|schedule|deposit|loyalty|referr|event/i.test(intent)) score += 5;
  
  score = Math.max(0, Math.min(100, score));
  const level = score >= 88 ? 'elite' : score >= 75 ? 'strong' : score >= 60 ? 'good' : 'needs_tuning';
  return { score, level, intent, mood };
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
  const companyName = tenant?.name || 'the salon';
  
  return `You are Lola, the world-class AI front desk manager at ${companyName}.
You sound human, fast, warm, and precise. Always mention "${companyName}" naturally in greetings and sign-offs.
Keep replies concise and actionable.

CHANNEL: ${channel}
DETECTED_INTENT: ${intent}
MOOD: ${mood}
COMPANY_NAME: ${companyName}

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
- Keep SMS replies to 1-3 sentences; keep voice replies to 1-2 short sentences.
- FOR VOICE CHANNEL: Speak naturally like you're talking to a friend. Include ${companyName} name. Short pauses make sense.`;
}
