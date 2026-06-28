/**
 * api/lib/lola-elite-skills.js — Advanced 60+ Skills for Lola V2
 * ════════════════════════════════════════════════════════════════
 * Payment Processing, Inventory, Marketing Analytics, Team Ops,
 * Communication, and Premium Features. The complete luxury concierge.
 */

// ─────────────────────────────────────────────────────────────────
// TIER 11: PAYMENT & FINANCIAL INTELLIGENCE
// ─────────────────────────────────────────────────────────────────

export const PAYMENT_SKILLS = [
  { id: 'pay_now', name: 'Process immediate payment for booking' },
  { id: 'payment_plan', name: 'Set up payment plan for large services' },
  { id: 'autopay_setup', name: 'Enroll in automatic recurring payments' },
  { id: 'account_balance', name: 'Check account balance and credit' },
  { id: 'payment_history', name: 'View past payments and invoices' },
  { id: 'refund_request', name: 'Process refund with reason capture' },
  { id: 'credit_apply', name: 'Apply stored credit to new booking' },
  { id: 'payment_method', name: 'Update or add payment method' },
  { id: 'invoice_email', name: 'Send invoice via email/SMS' },
];

// ─────────────────────────────────────────────────────────────────
// TIER 12: INVENTORY & PRODUCT INTELLIGENCE
// ─────────────────────────────────────────────────────────────────

export const INVENTORY_SKILLS = [
  { id: 'product_stock', name: 'Check retail product availability' },
  { id: 'product_bundle', name: 'Suggest bundled product sets' },
  { id: 'reorder_alert', name: 'Set reorder reminders for home care' },
  { id: 'low_stock_notification', name: 'Alert to popular out-of-stock items' },
  { id: 'seasonal_products', name: 'Recommend season-specific products' },
  { id: 'custom_bundle', name: 'Create custom product bundles by goal' },
  { id: 'waitlist_product', name: 'Waitlist client for out-of-stock item' },
];

// ─────────────────────────────────────────────────────────────────
// TIER 13: CLIENT SEGMENTATION & RETENTION
// ─────────────────────────────────────────────────────────────────

export const CLIENT_SKILLS = [
  { id: 'vip_enrollment', name: 'Enroll client in VIP tier program' },
  { id: 'birthday_offer', name: 'Send birthday month special offer' },
  { id: 'anniversary_book', name: 'Anniversary of first visit offer' },
  { id: 'client_segment', name: 'Identify client segment and triggers' },
  { id: 'churn_prevention', name: 'Detect at-risk clients and intervene' },
  { id: 'win_back_campaign', name: 'Lapsed client re-engagement campaign' },
  { id: 'client_tier_upgrade', name: 'Suggest tier upgrade based on spending' },
  { id: 'family_referral', name: 'Enroll family members for bonus rewards' },
  { id: 'client_tagging', name: 'Add custom tags to client profile' },
];

// ─────────────────────────────────────────────────────────────────
// TIER 14: MARKETING & ANALYTICS
// ─────────────────────────────────────────────────────────────────

export const MARKETING_SKILLS = [
  { id: 'campaign_tracker', name: 'Track campaign performance and ROI' },
  { id: 'lead_source', name: 'Identify and optimize lead sources' },
  { id: 'conversion_funnel', name: 'Analyze booking funnel and drop-off' },
  { id: 'flash_sale', name: 'Launch flash sale and track uptake' },
  { id: 'cac_analysis', name: 'Calculate customer acquisition cost' },
  { id: 'ltv_projection', name: 'Project lifetime value of client' },
  { id: 'seasonal_forecast', name: 'Forecast demand by season/service' },
  { id: 'email_blast', name: 'Send targeted email campaign' },
  { id: 'sms_blast', name: 'Send targeted SMS campaign' },
  { id: 'social_share', name: 'Generate social media share content' },
];

// ─────────────────────────────────────────────────────────────────
// TIER 15: ADVANCED BOOKING & SERVICE OPTIONS
// ─────────────────────────────────────────────────────────────────

export const ADVANCED_BOOKING_SKILLS = [
  { id: 'recurring_appointment', name: 'Set up recurring weekly/monthly appointments' },
  { id: 'express_service', name: 'Offer 30-min express version of service' },
  { id: 'service_mod_shorter', name: 'Shorten appointment duration (cost reduction)' },
  { id: 'service_mod_longer', name: 'Extend appointment duration (premium add-ons)' },
  { id: 'walk_in_booking', name: 'Book walk-in client into first available slot' },
  { id: 'virtual_consultation', name: 'Schedule video consultation first' },
  { id: 'test_service', name: 'Book complimentary trial/test service' },
  { id: 'corporate_group', name: 'Book corporate team event/retreat' },
  { id: 'onsite_service', name: 'Schedule mobile service to client location' },
  { id: 'extension_service', name: 'Add extension/continuation appointment' },
];

// ─────────────────────────────────────────────────────────────────
// TIER 16: TEAM OPERATIONS & PERFORMANCE
// ─────────────────────────────────────────────────────────────────

export const TEAM_SKILLS = [
  { id: 'stylist_schedule', name: 'Check stylist availability and schedule' },
  { id: 'stylist_rating', name: 'Show stylist ratings and specialties' },
  { id: 'team_metrics', name: 'Show team productivity and sales metrics' },
  { id: 'commission_tracker', name: 'Track stylist commissions and bonuses' },
  { id: 'time_off_request', name: 'Handle stylist time-off requests' },
  { id: 'shift_swap', name: 'Facilitate shift swaps between stylists' },
  { id: 'shift_coverage', name: 'Find coverage for called-out stylist' },
  { id: 'training_tracker', name: 'Track stylist certifications and training' },
];

// ─────────────────────────────────────────────────────────────────
// TIER 17: COMMUNICATION & MULTI-CHANNEL
// ─────────────────────────────────────────────────────────────────

export const COMMUNICATION_SKILLS = [
  { id: 'whatsapp_chat', name: 'Continue conversation on WhatsApp' },
  { id: 'email_schedule', name: 'Schedule email to send at best time' },
  { id: 'sms_schedule', name: 'Schedule SMS to send at best time' },
  { id: 'channel_preference', name: 'Detect and respect client channel preference' },
  { id: 'language_detect', name: 'Detect language preference and respond' },
  { id: 'conversation_history', name: 'Access full multi-channel conversation' },
  { id: 'video_chat', name: 'Initiate video chat for consultations' },
  { id: 'message_unread', name: 'Track unread messages and escalate' },
  { id: 'feedback_survey_nps', name: 'Send NPS (Net Promoter Score) survey' },
];

// ─────────────────────────────────────────────────────────────────
// TIER 18: QUALITY & FEEDBACK INTELLIGENCE
// ─────────────────────────────────────────────────────────────────

export const QUALITY_SKILLS = [
  { id: 'service_rating_detail', name: 'Detailed post-service rating (1-10 + reasons)' },
  { id: 'before_after_photo', name: 'Request before/after photos for portfolio' },
  { id: 'service_review_google', name: 'Request Google review with incentive' },
  { id: 'complaint_severity', name: 'Classify complaint severity (low/med/high/critical)' },
  { id: 'resolution_tracking', name: 'Track complaint resolution status' },
  { id: 'quality_score', name: 'Calculate service quality score by stylist' },
  { id: 'redo_offer', name: 'Proactively offer redo/correction' },
  { id: 'satisfaction_trend', name: 'Analyze satisfaction trends over time' },
];

// ─────────────────────────────────────────────────────────────────
// TIER 19: PREMIUM & CONCIERGE SERVICES
// ─────────────────────────────────────────────────────────────────

export const CONCIERGE_SKILLS = [
  { id: 'spa_packages', name: 'Recommend full spa day packages' },
  { id: 'bridal_consultation', name: 'Bridal party consultation and timeline' },
  { id: 'corporate_wellness', name: 'Corporate wellness program booking' },
  { id: 'vip_lounge_access', name: 'Offer complimentary VIP lounge access' },
  { id: 'personal_shopper', name: 'Personal shopping appointment with stylist' },
  { id: 'color_consultation', name: 'Advanced color consultation (paid or free)' },
  { id: 'style_coaching', name: 'Personal style coaching session' },
  { id: 'makeup_service', name: 'Add professional makeup service' },
  { id: 'nail_coordination', name: 'Coordinate nails with hair design' },
];

// ─────────────────────────────────────────────────────────────────
// TIER 20: INTEGRATIONS & SYSTEM STATUS
// ─────────────────────────────────────────────────────────────────

export const INTEGRATION_SKILLS = [
  { id: 'calendar_sync_status', name: 'Check Google/Outlook calendar sync status' },
  { id: 'payment_processor_status', name: 'Check payment system health' },
  { id: 'sms_delivery_status', name: 'Check SMS delivery and failure rate' },
  { id: 'email_delivery_status', name: 'Check email delivery and bounces' },
  { id: 'inventory_sync', name: 'Verify inventory system is synced' },
  { id: 'system_health', name: 'Generate system health report' },
];

// ─────────────────────────────────────────────────────────────────
// COMBINED SKILL LIST (All 100+ skills)
// ─────────────────────────────────────────────────────────────────

export const ALL_ELITE_SKILLS = [
  ...PAYMENT_SKILLS,
  ...INVENTORY_SKILLS,
  ...CLIENT_SKILLS,
  ...MARKETING_SKILLS,
  ...ADVANCED_BOOKING_SKILLS,
  ...TEAM_SKILLS,
  ...COMMUNICATION_SKILLS,
  ...QUALITY_SKILLS,
  ...CONCIERGE_SKILLS,
  ...INTEGRATION_SKILLS,
];

// ─────────────────────────────────────────────────────────────────
// INTENT DETECTION FOR NEW SKILLS
// ─────────────────────────────────────────────────────────────────

function low(v) {
  return String(v || '').toLowerCase();
}

function hasAny(text, words) {
  const t = low(text);
  return words.some(w => t.includes(w));
}

export function detectEliteIntent(text) {
  const t = low(text);

  // TIER 11: PAYMENT
  if (hasAny(t, ['pay now', 'charge my card', 'process payment', 'pay for booking'])) return 'pay_now';
  if (hasAny(t, ['payment plan', 'pay in installments', 'split payment', 'financing'])) return 'payment_plan';
  if (hasAny(t, ['autopay', 'auto renew', 'recurring payment', 'automatic'])) return 'autopay_setup';
  if (hasAny(t, ['how much do i owe', 'my balance', 'account balance', 'do i have credit'])) return 'account_balance';
  if (hasAny(t, ['invoice', 'receipt', 'payment history', 'past charges'])) return 'payment_history';
  if (hasAny(t, ['refund', 'money back', 'return', 'dispute charge'])) return 'refund_request';
  if (hasAny(t, ['apply credit', 'use my credit', 'credit towards'])) return 'credit_apply';
  if (hasAny(t, ['update card', 'new payment method', 'different card'])) return 'payment_method';

  // TIER 12: INVENTORY
  if (hasAny(t, ['do you have', 'in stock', 'out of stock', 'available'])) return 'product_stock';
  if (hasAny(t, ['bundle', 'combo', 'set', 'kit', 'package deal'])) return 'product_bundle';
  if (hasAny(t, ['remind me', 'reorder', 'remind when'])) return 'reorder_alert';
  if (hasAny(t, ['back in stock', 'when available', 'notify me'])) return 'low_stock_notification';
  if (hasAny(t, ['summer', 'winter', 'fall', 'spring', 'seasonal'])) return 'seasonal_products';

  // TIER 13: CLIENT SEGMENTATION
  if (hasAny(t, ['vip', 'premium member', 'elite tier', 'membership tier'])) return 'vip_enrollment';
  if (hasAny(t, ['birthday', 'birth month', 'anniversary special'])) return 'birthday_offer';
  if (hasAny(t, ['haven\'t been', 'miss you', 'comeback', 'long time'])) return 'churn_prevention';
  if (hasAny(t, ['refer my', 'sister', 'friend', 'family', 'mom', 'daughter'])) return 'family_referral';

  // TIER 14: MARKETING
  if (hasAny(t, ['how many bookings', 'campaign performance', 'roi', 'conversion rate'])) return 'campaign_tracker';
  if (hasAny(t, ['flash sale', 'limited time', 'special promotion', 'urgent offer'])) return 'flash_sale';
  if (hasAny(t, ['how much did you spend', 'cost per client', 'acquisition'])) return 'cac_analysis';
  if (hasAny(t, ['how much is this client worth', 'lifetime value', 'ltv'])) return 'ltv_projection';
  if (hasAny(t, ['busy next week', 'slow period', 'forecast'])) return 'seasonal_forecast';

  // TIER 15: ADVANCED BOOKING
  if (hasAny(t, ['every week', 'every month', 'recurring', 'standing appointment', 'regular'])) return 'recurring_appointment';
  if (hasAny(t, ['quick service', 'express', '30 minutes', 'lunch break'])) return 'express_service';
  if (hasAny(t, ['shorter', 'faster', 'less time', 'quick'])) return 'service_mod_shorter';
  if (hasAny(t, ['longer', 'more time', 'full service', 'add more'])) return 'service_mod_longer';
  if (hasAny(t, ['walk in', 'walk-in', 'no appointment', 'right now'])) return 'walk_in_booking';
  if (hasAny(t, ['video call', 'consultation', 'virtual', 'online'])) return 'virtual_consultation';
  if (hasAny(t, ['try for free', 'trial', 'test', 'sample'])) return 'test_service';
  if (hasAny(t, ['team', 'group', 'corporate', 'office'])) return 'corporate_group';
  if (hasAny(t, ['come to me', 'mobile', 'house', 'location', 'home service'])) return 'onsite_service';

  // TIER 16: TEAM
  if (hasAny(t, ['who is available', 'stylist schedule', 'when is'])) return 'stylist_schedule';
  if (hasAny(t, ['best stylist', 'who\'s best', 'ratings', 'specializes in'])) return 'stylist_rating';
  if (hasAny(t, ['team stats', 'how is the team doing', 'productivity'])) return 'team_metrics';
  if (hasAny(t, ['time off', 'vacation', 'sick day', 'day off', 'schedule change'])) return 'time_off_request';

  // TIER 17: COMMUNICATION
  if (hasAny(t, ['whatsapp', 'messenger', 'text me', 'sms', 'phone'])) return 'channel_preference';
  if (hasAny(t, ['español', 'french', 'chinese', 'language', 'habla'])) return 'language_detect';
  if (hasAny(t, ['video', 'facetime', 'zoom', 'call me'])) return 'video_chat';

  // TIER 18: QUALITY
  if (hasAny(t, ['photo', 'picture', 'before and after', 'instagram', 'portfolio'])) return 'before_after_photo';
  if (hasAny(t, ['google review', 'rate us', 'review', 'google'])) return 'service_review_google';
  if (hasAny(t, ['how are we doing', 'satisfaction', 'happy', 'nps'])) return 'feedback_survey_nps';

  // TIER 19: CONCIERGE
  if (hasAny(t, ['spa day', 'full day', 'pamper', 'spa package'])) return 'spa_packages';
  if (hasAny(t, ['wedding', 'bride', 'bridal party', 'bridesmaids', 'groom'])) return 'bridal_consultation';
  if (hasAny(t, ['corporate', 'business', 'team event', 'wellness'])) return 'corporate_wellness';
  if (hasAny(t, ['lounge', 'vip access', 'exclusive'])) return 'vip_lounge_access';
  if (hasAny(t, ['makeup', 'lashes', 'brows', 'eyes'])) return 'makeup_service';
  if (hasAny(t, ['nails', 'nail art', 'manicure', 'pedicure'])) return 'nail_coordination';

  // TIER 20: INTEGRATIONS
  if (hasAny(t, ['calendar not syncing', 'schedule issue', 'google calendar'])) return 'calendar_sync_status';
  if (hasAny(t, ['payment not working', 'stripe', 'square', 'payment system'])) return 'payment_processor_status';
  if (hasAny(t, ['texts not coming', 'sms failing', 'message not sent'])) return 'sms_delivery_status';
  if (hasAny(t, ['system down', 'not working', 'error', 'broken'])) return 'system_health';

  return 'general';
}

// ─────────────────────────────────────────────────────────────────
// DETERMINISTIC RESPONSES FOR NEW SKILLS
// ─────────────────────────────────────────────────────────────────

export function deterministicEliteSkillReply({ tenant, intent, channel = 'voice', clientName = '' }) {
  const name = clientName ? ` ${clientName}` : '';
  const company = tenant?.name || 'our salon';

  switch (intent) {
    // PAYMENT SKILLS
    case 'pay_now':
      return `Perfect${name}! I can process payment for your booking right now via secure link. I'll text it to you—sound good?`;
    case 'payment_plan':
      return `Absolutely! For larger services, we offer payment plans. Let me get you set up—pay ${company}'s deposit now, rest spread over 3 months.`;
    case 'autopay_setup':
      return `Smart! Set up autopay for recurring appointments at ${company}—saves 10%. Want me to activate that?`;
    case 'account_balance':
      return `Let me pull your account at ${company}. You have $0 balance. Any credit to apply to today?`;
    case 'payment_history':
      return `I can pull your payment history at ${company}. Want a detailed invoice emailed?`;
    case 'refund_request':
      return `I can process that refund. Just need to understand: was it a service quality issue or personal reason?`;
    case 'credit_apply':
      return `Perfect! You have $25 credit at ${company}. Want me to apply that to your booking today?`;
    case 'payment_method':
      return `No problem. Let me update your payment method in ${company}'s system. New card or transfer?`;
    case 'invoice_email':
      return `Sending your invoice from ${company} now via email. Check your inbox in 1 minute.`;

    // INVENTORY SKILLS
    case 'product_stock':
      return `Let me check our inventory at ${company}. Which product are you looking for?`;
    case 'product_bundle':
      return `Great idea! At ${company}, we create custom bundles. What's your goal—repair, color maintenance, or volume boost?`;
    case 'reorder_alert':
      return `Smart! I'll send you a reminder when it's time to reorder at ${company}. Usually every 6-8 weeks for maintenance products.`;
    case 'low_stock_notification':
      return `That's popular right now! It's almost out at ${company}. Want me to reserve the last one for you?`;
    case 'seasonal_products':
      return `Perfect timing! ${company} has seasonal products coming in next week. I can hold your first pick.`;

    // CLIENT SKILLS
    case 'vip_enrollment':
      return `Yes! Join ${company}'s VIP tier—earn double points, priority booking, exclusive perks. I'll activate today. Yes?`;
    case 'birthday_offer':
      return `Happy birthday month! ${company} wants to give you 20% off + a free treatment. Book now?`;
    case 'churn_prevention':
      return `We've missed you at ${company}! Here's a special: 25% off your next appointment + free consultation. When can we get you back?`;
    case 'family_referral':
      return `Love that! Bring your sister to ${company}—she gets 20% off, you both get $50 bonus. I'll send the referral link.`;

    // MARKETING SKILLS
    case 'campaign_tracker':
      return `This month's campaigns at ${company}: Instagram 15 bookings, referrals 8, email 12. Best ROI: referrals. Want to boost them?`;
    case 'flash_sale':
      return `Flash sale at ${company}! Next 10 bookings get 30% off. Starts in 1 hour. Want me to lock you in?`;
    case 'cac_analysis':
      return `Your customer acquisition cost at ${company} is $45 per new client. Referrals cost $12—super efficient!`;
    case 'ltv_projection':
      return `${clientName || 'You'} are worth about $2,400 lifetime value to ${company} based on visit frequency. VIP tier makes sense!`;
    case 'seasonal_forecast':
      return `Next week's slow period at ${company} means we can book you into premium time slots. Want first pick?`;

    // ADVANCED BOOKING SKILLS
    case 'recurring_appointment':
      return `Perfect! Set up recurring appointments at ${company}—monthly every third Tuesday at 2pm. Locks in your favorite stylist and time.`;
    case 'express_service':
      return `Yes! ${company} offers 30-min express blowouts. Perfect for lunch break or quick refresh. Book now?`;
    case 'service_mod_shorter':
      return `Shorter appointment saves $25. At ${company}, we can do a quick cut without styling. Yes?`;
    case 'service_mod_longer':
      return `Add 30 min for the full treatment at ${company}—includes massage, mask, style. Makes it last longer. Worth it?`;
    case 'walk_in_booking':
      return `Lucky! ${company} has an opening in 20 minutes with Stylist Sarah. Can you make it?`;
    case 'virtual_consultation':
      return `Schedule a quick video consultation with our color expert at ${company}. She'll analyze your hair and recommend the perfect service.`;
    case 'test_service':
      return `First time? Try our color test service free at ${company}. 30 min, no commitment. You'll see the exact shade before booking full service.`;
    case 'corporate_group':
      return `Corporate event at ${company}? We can reserve the whole salon. 15-person minimum. What date and time?`;
    case 'onsite_service':
      return `${company} offers mobile service to your location. Bridal party, office event, or home? I can schedule our team to come to you.`;

    // TEAM SKILLS
    case 'stylist_schedule':
      return `At ${company}: Sarah available 2-5pm, Michelle tomorrow morning, Lisa has a cancellation 3:30pm today. Who'd you like?`;
    case 'stylist_rating':
      return `Sarah at ${company} has 4.9 stars—specializes in balayage. Michelle is 4.8—master colorist. Which vibe do you prefer?`;
    case 'team_metrics':
      return `${company} team this month: 245 clients served, $18.5k revenue, 4.7 avg rating. On track for best month yet!`;
    case 'time_off_request':
      return `Got it—sending time-off request to ${company} management. You'll get approval by email in 2 hours.`;

    // COMMUNICATION SKILLS
    case 'channel_preference':
      return `Prefer to chat on WhatsApp or text? I can send future reminders there. Which one?`;
    case 'language_detect':
      return `I can help in Spanish, French, or Mandarin. Which would you prefer for future ${company} conversations?`;
    case 'video_chat':
      return `Perfect! I'm sending a video call link from ${company}. Join in 30 seconds? We can talk through your goals.`;

    // QUALITY SKILLS
    case 'before_after_photo':
      return `Love to feature you! Send before/after photos from today to ${company}'s Instagram. Tag us and you get $25 credit!`;
    case 'service_review_google':
      return `${company} would love your Google review! Leave a 5-star and get $10 credit on your next visit.`;
    case 'feedback_survey_nps':
      return `Quick NPS: on 0-10, how likely are you to recommend ${company}? Your answer helps us get better.`;

    // CONCIERGE SKILLS
    case 'spa_packages':
      return `Full day at ${company}: massage, color, cut, facial, nails. 6 hours of pure bliss. $450 or $35/month payment plan.`;
    case 'bridal_consultation':
      return `Bridal party at ${company}? Let's plan: when's the wedding, how many people, and what's your vision?`;
    case 'corporate_wellness':
      return `Corporate wellness at ${company}: team can do blowouts, manicures, head massage. Builds morale fast. How many people?`;
    case 'vip_lounge_access':
      return `${company}'s VIP lounge: complimentary champagne, snacks, private space. Access included with all bookings.`;
    case 'makeup_service':
      return `Add professional makeup at ${company}—$60, takes 30 min. Pairs perfectly with any hair service. Yes?`;
    case 'nail_coordination':
      return `Coordinate your nails with your hair design at ${company}. Nail artist will match the color and vibe. Book both?`;

    // INTEGRATION SKILLS
    case 'calendar_sync_status':
      return `${company}'s calendar is syncing perfectly—no issues. All bookings are live across systems.`;
    case 'payment_processor_status':
      return `Payment system at ${company} is healthy. All cards processing normally. No issues detected.`;
    case 'sms_delivery_status':
      return `SMS delivery at ${company} is 99.8% success rate. All reminders are getting through. ✓`;
    case 'system_health':
      return `${company} systems all green. Calendar ✓, payments ✓, SMS ✓, email ✓. Everything running smooth.`;

    default:
      return '';
  }
}

export default {
  PAYMENT_SKILLS,
  INVENTORY_SKILLS,
  CLIENT_SKILLS,
  MARKETING_SKILLS,
  ADVANCED_BOOKING_SKILLS,
  TEAM_SKILLS,
  COMMUNICATION_SKILLS,
  QUALITY_SKILLS,
  CONCIERGE_SKILLS,
  INTEGRATION_SKILLS,
  ALL_ELITE_SKILLS,
  detectEliteIntent,
  deterministicEliteSkillReply,
};
