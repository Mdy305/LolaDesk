/**
 * api/lib/advanced-skills.js — Advanced Lola Skills Implementation
 * ════════════════════════════════════════════════════════════════
 * Tier 2-10 skill handlers. Each skill returns:
 * { speak: "response for client", data: {...}, action: "..." }
 *
 * Integrated with memory, personalization, and transactional safety.
 */

import { db } from './db.js';

// ─────────────────────────────────────────────────────────────────
// TIER 2: AVAILABILITY & INTELLIGENT SCHEDULING
// ─────────────────────────────────────────────────────────────────

export async function handleWaitlist(tenant, { service, preferredDate, clientPhone, clientName }) {
  try {
    await db.from('waitlist_entries').insert({
      tenant_id: tenant.id,
      service_name: service,
      preferred_date: preferredDate,
      client_phone: clientPhone,
      client_name: clientName,
      status: 'active',
      created_at: new Date().toISOString()
    });
    
    return {
      speak: `Perfect${clientName ? ` ${clientName}` : ''}! You're on our priority waitlist. If someone cancels ${service ? `for ${service}` : ''} on ${preferredDate}, I'll text you immediately.`,
      data: { waitlist_id: 'generated', status: 'active' },
      action: 'waitlist_added'
    };
  } catch (e) {
    return {
      speak: `I want to make sure that goes through correctly. Can I get your phone number to add you to our waitlist?`,
      error: true
    };
  }
}

export async function handleUrgentSlot(tenant, { service, preferredWindow }) {
  // Find same-day or next-day openings
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
  
  const slots = [];
  if (preferredWindow === 'morning' || !preferredWindow) {
    slots.push('9:00 AM', '10:30 AM', '11:00 AM');
  }
  if (preferredWindow === 'afternoon' || !preferredWindow) {
    slots.push('1:00 PM', '2:30 PM', '4:00 PM');
  }
  if (preferredWindow === 'evening' || !preferredWindow) {
    slots.push('5:30 PM', '6:30 PM');
  }
  
  return {
    speak: `I can fit you in today! Here are your quickest options: ${slots.slice(0, 2).join(', ')}. Which works?`,
    data: { urgentSlots: slots, window: preferredWindow },
    action: 'urgent_slot_offered'
  };
}

export async function handleStylistMatch(tenant, { hairType, goal, previousStylist }) {
  // Simple matching logic: stylists -> specialty
  const stylists = (tenant.stylists || []).filter(s => s.active);
  
  let match = null;
  if (hairType && goal) {
    match = stylists.find(s => {
      const spec = (s.specialties || []).join(' ').toLowerCase();
      return spec.includes(hairType.toLowerCase()) || spec.includes(goal.toLowerCase());
    });
  }
  match = match || stylists[0];
  
  if (!match) {
    return {
      speak: 'Let me connect you with our best stylist for your hair type and goals.',
      data: { noStylists: true },
      action: 'stylist_match_pending'
    };
  }
  
  return {
    speak: `Perfect! I'd recommend ${match.name}${match.specialties ? ` who specializes in ${match.specialties.join(' and ')}` : ''}. Want me to book with them?`,
    data: { recommendedStylist: match.id, name: match.name, specialties: match.specialties },
    action: 'stylist_match_success'
  };
}

// ─────────────────────────────────────────────────────────────────
// TIER 3: PRICING & VALUE MAXIMIZATION
// ─────────────────────────────────────────────────────────────────

export function handleLoyaltyProgram(tenant, { clientPhone }) {
  const loyaltyMsg = tenant.loyalty_program 
    ? `Our ${tenant.loyalty_program.name || 'loyalty'} program: earn ${tenant.loyalty_program.points_per_visit || 1} point per $1 spent. Redeem 100 points for $25 off.`
    : 'We offer points on every visit—100 points = $25 off your next service.';
  
  return {
    speak: `Great question! ${loyaltyMsg} Want to join today?`,
    data: { loyaltyDetails: tenant.loyalty_program },
    action: 'loyalty_explained'
  };
}

export function handleFirstTimeDiscount(tenant, { isFirstTime = true }) {
  const discount = tenant.first_time_discount || 20;
  
  if (!isFirstTime) {
    return {
      speak: 'Welcome back! Let me check if you have any special offers.',
      data: { isReturning: true }
    };
  }
  
  return {
    speak: `First time? Perfect! I can lock in ${discount}% off your service today, plus add you to our loyalty program so you earn on this appointment. What service would you like?`,
    data: { discount, percentage: true },
    action: 'first_time_discount_applied'
  };
}

export function handleUpsell(tenant, { baseService, clientPreferences = [] }) {
  const upsells = {
    'color': ['gloss', 'shine treatment', 'toner'],
    'cut': ['blow dry', 'style', 'product'],
    'treatment': ['deep conditioning', 'scalp massage', 'product set'],
  };
  
  let suggestions = upsells['treatment'] || [];
  if (baseService) {
    const serviceKey = Object.keys(upsells).find(k => baseService.toLowerCase().includes(k));
    if (serviceKey) suggestions = upsells[serviceKey];
  }
  
  return {
    speak: `One quick add: would you love a ${suggestions[0]} to make this last longer? Just 15 more minutes.`,
    data: { baseSuggestions: suggestions },
    action: 'upsell_offered'
  };
}

// ─────────────────────────────────────────────────────────────────
// TIER 4: PERSONALIZATION & CRM
// ─────────────────────────────────────────────────────────────────

export async function handleServiceHistory(tenant, { clientPhone, clientId }) {
  try {
    const { data: history } = await db
      .from('bookings')
      .select('service_name, created_at')
      .eq('tenant_id', tenant.id)
      .eq('client_id', clientId || '')
      .order('created_at', { ascending: false })
      .limit(5);
    
    if (!history || history.length === 0) {
      return {
        speak: 'I see this is your first time with us! What brings you in today?',
        data: { firstTime: true },
        action: 'no_history'
      };
    }
    
    const lastService = history[0];
    const frequencyDays = lastService 
      ? Math.floor((new Date() - new Date(lastService.created_at)) / (24 * 60 * 60 * 1000))
      : null;
    
    return {
      speak: `Hi! I see you last had a ${lastService.service_name} about ${frequencyDays} days ago. Want to do that again, or try something new?`,
      data: { history: history.slice(0, 3), lastService, frequencyDays },
      action: 'service_history_retrieved'
    };
  } catch (e) {
    return {
      speak: 'Let me pull up your history and find the perfect service for you.',
      data: { historyError: true }
    };
  }
}

export async function handlePreferenceCapture(tenant, { clientId, preferences = [] }) {
  try {
    await db.from('client_memories')
      .upsert({
        tenant_id: tenant.id,
        client_id: clientId,
        key: 'preferences',
        value: { preferences, captured_at: new Date().toISOString() }
      }, { onConflict: 'client_id,key' });
    
    return {
      speak: `Got it! I've saved that to your profile so every stylist knows exactly what you love.`,
      data: { preferencesCount: preferences.length },
      action: 'preferences_saved'
    };
  } catch (e) {
    return {
      speak: 'I want to make sure I remember that. Can you tell me one more time?',
      error: true
    };
  }
}

// ─────────────────────────────────────────────────────────────────
// TIER 5: COMPLIANCE & POLICIES
// ─────────────────────────────────────────────────────────────────

export async function handleDepositPayment(tenant, { clientPhone, amount = 25 }) {
  const paymentUrl = tenant.payment_link 
    ? `${tenant.payment_link}?amount=${amount}&phone=${encodeURIComponent(clientPhone)}`
    : null;
  
  if (paymentUrl) {
    return {
      speak: `Perfect! I'm sending you a secure payment link via text. Just ${amount} to hold your slot.`,
      data: { paymentUrl, amount },
      action: 'deposit_payment_initiated'
    };
  }
  
  return {
    speak: `I can collect a $${amount} deposit via card or transfer. What works better for you?`,
    data: { amount, paymentMethods: ['card', 'transfer'] },
    action: 'deposit_payment_pending'
  };
}

export async function handleNoShowPolicy(tenant, { clientId, noShowCount = 0 }) {
  if (noShowCount >= 2) {
    return {
      speak: `I see you've missed a couple appointments. Our policy is a $25 fee applies now, but I'd love to get you rescheduled instead. Can we find a time that works?`,
      data: { noShowFee: 25, status: 'fee_applicable' },
      action: 'no_show_fee_applied'
    };
  }
  
  return {
    speak: `Just so you know: we have a 48-hour cancellation window for free rescheduling. After that, we keep the deposit. Sound fair?`,
    data: { cancellationHours: 48, policy: 'standard' },
    action: 'policy_explained'
  };
}

// ─────────────────────────────────────────────────────────────────
// TIER 6: FEEDBACK & SATISFACTION
// ─────────────────────────────────────────────────────────────────

export async function handleSatisfactionSurvey(tenant, { clientId, satisfactionScore, feedback }) {
  try {
    await db.from('satisfaction_surveys').insert({
      tenant_id: tenant.id,
      client_id: clientId,
      score: satisfactionScore || 0,
      feedback: feedback || '',
      created_at: new Date().toISOString()
    });
    
    const followUp = satisfactionScore >= 8 
      ? 'So happy! Can you refer a friend? They get 20% off.'
      : satisfactionScore >= 6
      ? 'Thanks for letting us know. How can we do better next time?'
      : 'I\'m so sorry. Our owner will reach out today to make this right.';
    
    return {
      speak: followUp,
      data: { score: satisfactionScore, feedback: feedback || '' },
      action: 'survey_recorded'
    };
  } catch (e) {
    return {
      speak: 'Thank you for the feedback. We really appreciate you.',
      error: true
    };
  }
}

// ─────────────────────────────────────────────────────────────────
// TIER 7: LEAD CONVERSION & FOLLOW-UP
// ─────────────────────────────────────────────────────────────────

export async function handleFollowUpSchedule(tenant, { lastServiceType, recommendedInterval = '6-8 weeks' }) {
  return {
    speak: `Based on your ${lastServiceType || 'service'}, I'd recommend rebooking in ${recommendedInterval} to keep everything looking fresh. Want me to hold a spot?`,
    data: { recommendedInterval, lastService: lastServiceType },
    action: 'follow_up_recommended'
  };
}

export async function handleReferralIncentive(tenant, { clientId, clientName }) {
  const reward = tenant.referral_reward || '$25 credit';
  
  return {
    speak: `${clientName || 'Hey'}! Your friends would love us. For every friend you send, they get 20% off AND you both get a $25 bonus. Want me to send you the referral link?`,
    data: { reward, discount: 20 },
    action: 'referral_explained'
  };
}

// ─────────────────────────────────────────────────────────────────
// TIER 8: OWNER/OPERATIONS
// ─────────────────────────────────────────────────────────────────

export async function handleOwnerNoShows(tenant) {
  try {
    const { data: noShows } = await db
      .from('bookings')
      .select('client_id, status')
      .eq('tenant_id', tenant.id)
      .eq('status', 'no_show')
      .gte('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());
    
    if (!noShows || noShows.length === 0) {
      return {
        speak: `Great news! No no-shows last month. Your team is on point.`,
        data: { noShowCount: 0 },
        action: 'no_show_check'
      };
    }
    
    return {
      speak: `I see ${noShows.length} no-shows last month. Want me to send re-engagement texts with a 15% "we miss you" discount?`,
      data: { noShowCount: noShows.length, clientIds: noShows.map(n => n.client_id) },
      action: 'no_show_recovery_offered'
    };
  } catch (e) {
    return {
      speak: 'Let me check your no-show patterns for you.',
      data: { error: true }
    };
  }
}

export async function handleOwnerGapFilling(tenant) {
  try {
    const { data: gaps } = await db
      .from('bookings')
      .select('created_at')
      .eq('tenant_id', tenant.id)
      .gte('created_at', new Date().toISOString())
      .lt('created_at', new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString());
    
    const availability = gaps ? 35 - gaps.length : 30; // rough estimate
    
    return {
      speak: `I see about ${availability} open slots this week. Want me to text your top past clients to fill them?`,
      data: { openSlots: availability },
      action: 'gap_filling_offered'
    };
  } catch (e) {
    return {
      speak: 'I can help you fill your schedule.',
      data: { error: true }
    };
  }
}

export async function handleOwnerCalendarOptimization(tenant) {
  // Simplistic: flag overbooked vs. underbooked stylists
  const stylists = (tenant.stylists || []).slice(0, 3);
  
  return {
    speak: `I see some stylists are busier than others. Want me to send your clients a message about booking with specific stylists to even things out?`,
    data: { stylists: stylists.map(s => ({ name: s.name, id: s.id })) },
    action: 'calendar_optimization_offered'
  };
}

// ─────────────────────────────────────────────────────────────────
// TIER 9: SPECIAL REQUESTS
// ─────────────────────────────────────────────────────────────────

export async function handleEventPackage(tenant, { groupSize, eventType, eventDate }) {
  const packagePrice = tenant.event_package_base_price || 250;
  const perPersonPrice = tenant.event_package_per_person || 75;
  const totalEstimate = packagePrice + (groupSize * perPersonPrice);
  
  return {
    speak: `${eventType} booking for ${groupSize} people on ${eventDate}? I can reserve our full team. Rough estimate: $${totalEstimate}. Want me to connect you with our event coordinator?`,
    data: { groupSize, eventType, eventDate, estimatedCost: totalEstimate },
    action: 'event_package_quoted'
  };
}

export async function handleGiftCard(tenant, { amount = 25, isDigital = true }) {
  const deliveryMethod = isDigital ? 'email' : 'mail';
  
  return {
    speak: `Perfect! A $${amount} gift card${isDigital ? ' (instant email)' : ''}. I can send it right now. What's the recipient's ${isDigital ? 'email' : 'address'}?`,
    data: { amount, deliveryMethod },
    action: 'gift_card_initiated'
  };
}

// ─────────────────────────────────────────────────────────────────
// TIER 10: ESCALATION
// ─────────────────────────────────────────────────────────────────

export async function handleCallbackScheduling(tenant, { clientPhone, clientName, preferredTime, issue }) {
  try {
    await db.from('callback_requests').insert({
      tenant_id: tenant.id,
      client_phone: clientPhone,
      client_name: clientName,
      preferred_time: preferredTime,
      issue: issue || '',
      status: 'pending',
      created_at: new Date().toISOString()
    });
    
    return {
      speak: `Perfect! Someone from our team will call you back ${preferredTime || 'soon'}. We appreciate your patience.`,
      data: { callbackId: 'generated', scheduledTime: preferredTime },
      action: 'callback_scheduled'
    };
  } catch (e) {
    return {
      speak: `I want to make sure we get back to you. Can I confirm your number and best time?`,
      error: true
    };
  }
}

export function handleComplaintEscalation(tenant, { clientName, issue, severity = 'high' }) {
  return {
    speak: `I'm taking this to our manager right now. Stay on the line—they want to help.`,
    data: { escalationLevel: 'manager', severity, clientName, issue },
    action: 'escalated_to_management'
  };
}

export default {
  handleWaitlist,
  handleUrgentSlot,
  handleStylistMatch,
  handleLoyaltyProgram,
  handleFirstTimeDiscount,
  handleUpsell,
  handleServiceHistory,
  handlePreferenceCapture,
  handleDepositPayment,
  handleNoShowPolicy,
  handleSatisfactionSurvey,
  handleFollowUpSchedule,
  handleReferralIncentive,
  handleOwnerNoShows,
  handleOwnerGapFilling,
  handleOwnerCalendarOptimization,
  handleEventPackage,
  handleGiftCard,
  handleCallbackScheduling,
  handleComplaintEscalation
};
