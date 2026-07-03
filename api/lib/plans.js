/**
 * api/lib/plans.js — Plan definitions: prices, quotas, and limits
 * ════════════════════════════════════════════════════════════════
 * Single source of truth for what each plan costs and includes.
 * Keep this in sync with:
 *   - index.html (marketing homepage pricing section)
 *   - pricing.html (full pricing page)
 *   - onboarding.html (plan picker — data-plan attributes must match these slugs)
 *   - Stripe dashboard (the actual price_xxx IDs live there, referenced
 *     via STRIPE_PRICE_STARTER / STRIPE_PRICE_PRO / STRIPE_PRICE_MEDSPA
 *     in lib/stripe.js — this file only has dollar amounts for display
 *     and quota math, not the source of truth for what Stripe charges)
 *
 * Quotas are intentionally generous estimates, not hard technical
 * limits — going over doesn't cut off service mid-call, it triggers
 * an upgrade prompt (see lib/usage.js). Calibrate these against real
 * usage data once there's enough call volume to know actual costs.
 */

export const PLANS = {
  starter: {
    name: 'Solo',
    priceMonthly: 99,
    quotas: {
      voice_call: 150,     // calls/month — Solo has no phone voice per the marketing copy, but keep a quota in case a salon adds a number later
      sms_sent: 500,       // matches "500 messages/mo" on the homepage
      ai_token: 2000        // AI brain calls (chat/text turns)
    }
  },
  pro: {
    name: 'Pro',
    priceMonthly: 399,
    quotas: {
      voice_call: 600,
      sms_sent: 2500,
      ai_token: 8000
    }
  },
  medspa: {
    name: 'Med Spa',
    priceMonthly: 599,
    quotas: {
      voice_call: 1200,
      sms_sent: 5000,
      ai_token: 16000
    }
  },
  enterprise: {
    name: 'Enterprise',
    priceMonthly: null, // custom/negotiated — never soft-capped
    quotas: null
  }
};

export function planFor(slug){
  return PLANS[slug] || PLANS.starter;
}

// Human label for a usage kind, for display in the dashboard banner.
export const USAGE_LABELS = {
  voice_call: 'phone calls',
  sms_sent: 'texts sent',
  ai_token: 'AI conversations'
};
