/**
 * api/lib/plans.js — Plans: prices, included usage, overage, channel entitlements.
 * ════════════════════════════════════════════════════════════════
 * SINGLE SOURCE OF TRUTH. Keep in sync with pricing.html, onboarding.html,
 * and the Stripe price IDs (referenced by STRIPE_PRICE_* env vars).
 *
 * Model (Option A — seductive to salons, lucrative to us):
 *  - Pro is the hero tier (phone + text + WhatsApp + website).
 *  - Generous included usage; going over never blocks service, it meters
 *    overage (see usage.js). Only non-payment suspends (billing_status).
 *  - Annual = 2 months free.
 *  - Channel access is gated per plan, with per-tenant admin overrides
 *    (tenant.features[channel] === true unlocks a channel regardless of plan).
 *
 * `quotas` are kept for the existing dashboard usage meter and must match the
 * `kind` values written by logUsage (voice_call, sms_sent, ai_token).
 */

export const PLANS = {
  starter: {
    name: 'Solo', slug: 'starter',
    priceMonthly: 99, priceAnnual: 990,            // 2 months free
    tagline: 'Text + website chat for solo owners',
    channels: { web: true, sms: true, voice: false, whatsapp: false },
    includedMinutes: 0, includedTexts: 500,
    overage: { perMinute: null, perText: 0.05 },
    perks: { campaigns: false, consult: false },
    quotas: { voice_call: 150, sms_sent: 500, ai_token: 2000 }
  },
  pro: {
    name: 'Pro', slug: 'pro', popular: true,
    priceMonthly: 399, priceAnnual: 3990,
    tagline: 'The whole front desk — phone, text, WhatsApp & web',
    channels: { web: true, sms: true, voice: true, whatsapp: true },
    includedMinutes: 750, includedTexts: 2500,
    overage: { perMinute: 0.20, perText: 0.03 },
    perks: { campaigns: true, consult: false },
    quotas: { voice_call: 600, sms_sent: 2500, ai_token: 8000 }
  },
  medspa: {
    name: 'Med Spa', slug: 'medspa',
    priceMonthly: 599, priceAnnual: 5990,
    tagline: 'Everything, higher limits, consultation flow',
    channels: { web: true, sms: true, voice: true, whatsapp: true },
    includedMinutes: 1500, includedTexts: 5000,
    overage: { perMinute: 0.15, perText: 0.02 },
    perks: { campaigns: true, consult: true },
    quotas: { voice_call: 1200, sms_sent: 5000, ai_token: 16000 }
  },
  enterprise: {
    name: 'Enterprise', slug: 'enterprise',
    priceMonthly: null, priceAnnual: null,
    tagline: 'Custom volume & multi-location',
    channels: { web: true, sms: true, voice: true, whatsapp: true },
    includedMinutes: null, includedTexts: null,
    overage: { perMinute: null, perText: null },
    perks: { campaigns: true, consult: true },
    quotas: null
  }
};

export function planFor(slug){
  return PLANS[slug] || PLANS.starter;
}

// Which channels a tenant may use. Plan grants the base set; an admin can
// unlock any channel for a specific tenant via features.{channel} = true.
// Fail-open on unknown/enterprise plans so a paying salon is never wrongly cut off.
export function channelAllowed(tenant, channel){
  try{
    const slug = tenant?.plan;
    const plan = PLANS[slug];
    const flags = tenant?.features || {};
    if(flags[channel] === true) return true;   // admin override unlocks
    if(flags[channel] === false) return false; // admin override disables
    if(!plan || slug === 'enterprise') return true; // unknown/custom → allow
    return plan.channels?.[channel] !== false;
  }catch{ return true; }
}

export const USAGE_LABELS = {
  voice_call: 'phone calls',
  sms_sent: 'texts sent',
  ai_token: 'AI conversations'
};

// Monthly-equivalent revenue for a plan+interval (used by admin MRR math).
export function monthlyValue(slug, interval){
  const p = PLANS[slug];
  if(!p || p.priceMonthly == null) return 0;
  return interval === 'annual' && p.priceAnnual ? Math.round(p.priceAnnual / 12) : p.priceMonthly;
}

