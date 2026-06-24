import { tenantKnowledgePrompt } from './db.js';

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
  { id: 'callback_schedule', name: 'Schedule human callback at preferred time' }
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
  if(hasAny(t, ['refer','bring a friend','tell my friend','recommend you to'])) return 'referral_incentive';
  if(hasAny(t, ['gift card','someone gave me','gift','birthday gift'])) return 'gift_card';
  
  // GROUP/EVENT BOOKINGS
  if(hasAny(t, ['group','wedding','bridesmaids','event','party','bridal party'])) return 'event_package';
  
  // OWNER/OPERATIONS
  if(hasAny(t, ['no show','rebook','follow up','follow-up','fill gaps','retention','owner','stylist dashboard','schedule gaps'])) return 'owner_assistant';
  if(hasAny(t, ['when should i','best time to','how often','schedule next','book ahead'])) return 'follow_up_schedule';
  
  // GENERAL INFO
  if(hasAny(t, ['hours','open','close','today','tomorrow','sunday','monday'])) return 'hours';
  if(hasAny(t, ['address','located','where are you','location','parking','directions','google'])) return 'location';
  if(hasAny(t, ['call me back','someone from the salon','speak to','talk to'])) return 'callback_schedule';
  
  return 'general';
}

export function deterministicSkillReply({ tenant, intent, channel='voice', clientName='', isFirstTime=false }){
  const name = clientName ? ` ${clientName}` : '';
  const bookingUrl = tenant?.booking_url || '';
  const services = serviceList(tenant);
  
  switch(intent){
    // TIER 1: CORE BOOKING
    case 'booking_new':
      if(channel === 'sms' && bookingUrl){
        return `Perfect${name}. I can book this now or you can use ${bookingUrl}. What service, day, and time do you prefer?`;
      }
      return `Perfect${name}. I can help you book now. What service, day, and preferred time should I lock in?`;
    
    case 'booking_change':
      return 'Absolutely. I can help change or cancel your appointment. Share your full name and current appointment day/time.';
    
    case 'booking_confirm':
      return 'Absolutely. I can confirm that for you now. Please share your full name and the best phone number on the booking.';
    
    case 'booking_multi':
      return `Love it — multitasking appointment. What two services would you like done together? And what day/time works?`;
    
    case 'booking_package':
      return `Great thinking${name}. We offer package deals that save you time and money. What's your main goal: color + cut, maintenance boost, or full pampering day?`;
    
    // TIER 2: AVAILABILITY & INTELLIGENCE
    case 'urgent_slot':
      return `I can absolutely find you something today or tomorrow${name}. What service and what time window works best?`;
    
    case 'waitlist':
      return `Smart move. I'll add you to our priority waitlist for your preferred time — if someone cancels, I'll text you right away. When do you want to be on standby for?`;
    
    case 'stylist_match':
      return `Absolutely${name}. I have stylists who specialize in different techniques. What's your hair type, and what result are you going for? I'll match you with the best fit.`;
    
    // TIER 3: PRICING & VALUE
    case 'pricing':
      if(services) return `Our most requested services are ${services}. Tell me your goal and I will recommend the best option and price.`;
      return 'Tell me what result you want and I will recommend the right service and price range.';
    
    case 'loyalty':
      return `Love that you asked. Every appointment earns you points for free services, exclusive perks, and early access to new treatments. Want to join our VIP club today?`;
    
    case 'first_time_discount':
      return `New here? Perfect — I can lock in your first-time discount right now, plus I'll add you to our loyalty program so you earn on this appointment. What service sounds best?`;
    
    case 'upsell':
      return `Smart combo${name}. Adding a gloss or shine treatment to your service locks in color and takes just 15 more minutes—want me to add it on?`;
    
    // TIER 4: PERSONALIZATION
    case 'recommendation':
      return `I'm here to find the perfect service for you. What result are you hoping for today, and what's your hair been through recently?`;
    
    case 'product_retail':
      return `Absolutely${name}. The right home-care routine is half the battle. Based on your service today, I'll recommend products that keep your style looking salon-fresh. Sound good?`;
    
    case 'preference_capture':
      return `Got it${name} — I'm saving that. We'll make sure your next appointment is exactly how you love it.`;
    
    case 'service_history':
      return `Perfect — I have your history here. Last time you got your favorite style. Want the same magic, or ready to switch it up?`;
    
    // TIER 5: POLICIES
    case 'policy':
      return `Great question. We have a simple policy: small deposit holds your slot, 48-hour cancellation is free, and we offer a 100% redo guarantee if you're not thrilled. Any questions?`;
    
    case 'no_show_policy':
      return `I totally get life happens. Our policy is: miss two appointments and a $25 fee applies to your next one—unless we give you 24 hours notice. Can I reschedule you right now instead?`;
    
    case 'deposit_payment':
      return `Perfect${name}. Your deposit of $25-50 holds your spot. I can collect that securely right now via text. Sound good?`;
    
    // TIER 6: FEEDBACK & QUALITY
    case 'feedback':
      return `Thank you so much for the feedback${name}—I just saved it to personalize your next visit. Want me to go ahead and book your next appointment while I have you?`;
    
    case 'complaint_recovery':
      return `I am so sorry this happened${name}. We will make this right right away—please share your name, service date, and the fastest callback number. I'm flagging this for our team immediately.`;
    
    case 'satisfaction_survey':
      return `Perfect${name}. Quick question: on a scale of 1-10, how happy are you with your appointment today? And is there anything we could have done better?`;
    
    // TIER 7: LEAD CONVERSION
    case 'lead_capture':
      return channel === 'sms'
        ? `Totally fine. I can hold a priority consult spot and text you two ideal times—what day works best?`
        : `Totally fine. I can hold a priority consult slot and give you two perfect options. What day works best?`;
    
    case 'follow_up_schedule':
      return `Smart thinking ahead${name}. Based on your service type, I'd recommend rebooking in 6-8 weeks to keep everything looking fresh. Want me to pencil that in now?`;
    
    case 'referral_incentive':
      return `Love that you'd refer us${name}. Here's the deal: send a friend, they get 20% off, and you both get a free $25 add-on service. Sound good?`;
    
    // TIER 8: BUSINESS OPERATIONS
    case 'owner_assistant':
      return 'Yes. I can help with no-show recovery, rebooking, targeting at-risk clients, and filling schedule gaps. Which should we tackle first?';
    
    case 'owner_no_shows':
      return 'I see you had a no-show pattern last month. Want me to send a re-engagement text with a 15% "we miss you" discount?';
    
    case 'owner_gaps':
      return 'I found 3 open slots this week. Want me to text past clients in your top 5 favorite categories to fill them?';
    
    case 'owner_calendar':
      return 'I can see your team calendars. Stylist A is overbooked, Stylist B has gaps. Want me to suggest rebooking some of A\'s clients to B?';
    
    // TIER 9: SPECIAL REQUESTS
    case 'hours':
      return tenant?.hours
        ? `We are open ${tenant.hours}. Do you want me to help you book the best time?`
        : 'I can help you book right now. What day works best for you?';
    
    case 'location':
      return tenant?.location
        ? `We are located in ${tenant.location}. Want me to set your appointment now?`
        : 'I can help you schedule now. What day and time are best for you?';
    
    case 'event_package':
      return `Congratulations${name}! Group bookings are my specialty. How many people, what's the event, and when do you need us?`;
    
    case 'gift_card':
      return `Perfect gift${name}. Our gift cards start at $25 and never expire. Want me to send a digital one right now, or would you prefer a physical card?`;
    
    // TIER 10: ESCALATION
    case 'callback_schedule':
      return `Absolutely${name}. What's the best number and what time works best for someone from the team to call you back?`;
    
    case 'complaint_escalation':
      return `I'm taking this seriously${name}. I'm connecting you with our owner/manager right now to make this right. Stay on the line for one second?`;
    
    case 'human_handoff':
      return 'Absolutely. I will route this to the team now. What is the best callback number and your name?';
    
    case 'interruption':
      return channel === 'voice'
        ? 'Of course, take your time. I am here when you are ready.'
        : 'Of course - take your time. I am here when you are ready.';
    
    default:
      return '';
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
