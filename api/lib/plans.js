/**
 * api/lib/plans.js — THE single source of truth for what each plan costs.
 * ════════════════════════════════════════════════════════════════
 * Matches the public site (pricing.html, index.html):
 *   Starter  $99/mo   · annual $79/mo  (billed $948/yr)
 *   Pro      $399/mo  · annual $319/mo (billed $3,828/yr)
 *   Med-Spa  $599/mo  · annual $479/mo (billed $5,748/yr)
 *   "2 months free" on annual · 14-day free trial, no card.
 *
 * Everything is included (number, texting registration, channels). LolaDesk
 * also earns a per-booking fee (lib/booking-fees.js).
 *
 * Stripe: checkout uses a Stripe Price id from env when one is set —
 *   STRIPE_PRICE_<STARTER|PRO|MEDSPA>_<MONTHLY|ANNUAL>
 *   (legacy names STRIPE_PRICE_<PLAN> = monthly, STRIPE_PRICE_<PLAN>_ANNUAL also read)
 * — otherwise inline price_data built from the cents below, so what Stripe
 * charges can never drift from what the site shows.
 *
 * Quotas are soft (lib/usage.js shows a banner; nothing is cut off).
 */

export const TRIAL_DAYS = 14;

export const PLANS = {
  starter: {
    id: 'starter',
    name: 'Starter',
    priceMonthly: 99,
    monthlyCents: 9900,
    annualMonthlyCents: 7900,        // shown per month on the annual toggle
    annualCents: 7900 * 12,          // what Stripe charges once a year
    numbers: 1,                      // phone numbers included
    features: ['Lola answers & books 24/7', 'Your custom voice', 'Pricing, services & recommendations', 'Lead capture — never lose a caller', '1 phone number included'],
    quotas: { voice_call: 150, sms_sent: 500, ai_token: 2000 },
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    priceMonthly: 399,
    monthlyCents: 39900,
    annualMonthlyCents: 31900,
    annualCents: 31900 * 12,
    numbers: 1,
    features: ['Everything in Starter', 'Multi-stylist resource calendar', 'Win-back & rebooking campaigns', 'Booking platform sync (Square, Google)', 'Live activity & smart insights', 'Priority call handling'],
    quotas: { voice_call: 600, sms_sent: 2500, ai_token: 8000 },
  },
  medspa: {
    id: 'medspa',
    name: 'Med-Spa',
    priceMonthly: 599,
    monthlyCents: 59900,
    annualMonthlyCents: 47900,
    annualCents: 47900 * 12,
    numbers: 2,
    features: ['Everything in Pro', 'Highest call capacity', 'Consultation & intake flows', 'Compliance-ready call handling', 'Dedicated onboarding', 'All marketplace integrations'],
    quotas: { voice_call: 1200, sms_sent: 5000, ai_token: 16000 },
  },
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    priceMonthly: null, // custom/negotiated — never soft-capped, never sold through checkout
    monthlyCents: null,
    annualMonthlyCents: null,
    annualCents: null,
    numbers: 5,
    features: [],
    quotas: null,
  },
};

export const SELLABLE = ['starter', 'pro', 'medspa'];

// Every name a plan has ever had (marketing slugs, the old billing.js keys, Stripe nicknames).
const ALIAS = {
  starter: 'starter', solo: 'starter', basic: 'starter', essential: 'starter', essentials: 'starter',
  pro: 'pro', professional: 'pro', growth: 'pro',
  medspa: 'medspa', 'med-spa': 'medspa', med_spa: 'medspa', 'med spa': 'medspa', scale: 'medspa', premium: 'medspa', spa: 'medspa',
  enterprise: 'enterprise',
};

/** Canonical plan id for any legacy/marketing name. Unknown → null. */
export function normalizePlan(slug) {
  const k = String(slug || '').trim().toLowerCase();
  return ALIAS[k] || null;
}

export function planFor(slug) {
  return PLANS[normalizePlan(slug)] || PLANS.starter;
}

export function normalizeInterval(interval) {
  const k = String(interval || '').trim().toLowerCase();
  return ['annual', 'annually', 'year', 'yearly', 'y'].includes(k) ? 'annual' : 'monthly';
}

/** Cents Stripe charges per billing interval (annual = 12 × the annual monthly price). */
export function chargeCents(plan, interval = 'monthly') {
  const p = PLANS[normalizePlan(plan)];
  if (!p || p.monthlyCents == null) return null;
  return normalizeInterval(interval) === 'annual' ? p.annualCents : p.monthlyCents;
}

/** Monthly recurring revenue (cents) a subscription on this plan/interval brings in. */
export function mrrCents(plan, interval = 'monthly') {
  const p = PLANS[normalizePlan(plan)];
  if (!p || p.monthlyCents == null) return 0;
  return normalizeInterval(interval) === 'annual' ? p.annualMonthlyCents : p.monthlyCents;
}

/** Stripe Price id from env, if configured. */
export function envPriceId(plan, interval = 'monthly', env = process.env) {
  const id = normalizePlan(plan);
  if (!id || !SELLABLE.includes(id)) return null;
  const P = id.toUpperCase();
  if (normalizeInterval(interval) === 'annual') return env[`STRIPE_PRICE_${P}_ANNUAL`] || null;
  return env[`STRIPE_PRICE_${P}_MONTHLY`] || env[`STRIPE_PRICE_${P}`] || null;
}

/**
 * The Checkout line item for a plan: { price } when an env price id exists,
 * else { price_data } at the advertised amount. null for unknown/unsellable.
 */
export function lineItemFor(plan, interval = 'monthly', env = process.env) {
  const id = normalizePlan(plan);
  if (!id || !SELLABLE.includes(id)) return null;
  const iv = normalizeInterval(interval);
  const price = envPriceId(id, iv, env);
  if (price) return { price, quantity: 1 };
  const p = PLANS[id];
  return {
    price_data: {
      currency: 'usd',
      unit_amount: chargeCents(id, iv),
      recurring: { interval: iv === 'annual' ? 'year' : 'month' },
      product_data: { name: `LolaDesk ${p.name}${iv === 'annual' ? ' (annual)' : ''}` },
    },
    quantity: 1,
  };
}

/**
 * Which plan a Stripe price belongs to: env price ids first, then the amount
 * + interval (inline price_data prices have random ids). → { plan, interval } | null
 */
export function planFromPrice(price, env = process.env) {
  if (!price) return null;
  const pid = typeof price === 'string' ? price : price.id;
  for (const id of SELLABLE) {
    for (const iv of ['monthly', 'annual']) {
      const e = envPriceId(id, iv, env);
      if (e && pid && e === pid) return { plan: id, interval: iv };
    }
  }
  if (typeof price !== 'object') return null;
  const nick = normalizePlan(price.nickname || price.metadata?.plan || price.lookup_key);
  const ivRaw = price.recurring?.interval;
  const interval = ivRaw === 'year' ? 'annual' : 'monthly';
  if (nick && PLANS[nick]) return { plan: nick, interval };
  const amt = Number(price.unit_amount);
  if (Number.isFinite(amt)) {
    for (const id of SELLABLE) {
      const p = PLANS[id];
      if (interval === 'annual' && amt === p.annualCents) return { plan: id, interval };
      if (interval === 'monthly' && amt === p.monthlyCents) return { plan: id, interval };
    }
    // The old checkout charged $97 / $197 / $397 — still map those subscriptions.
    const legacy = { 9700: 'starter', 19700: 'pro', 39700: 'medspa' };
    if (interval === 'monthly' && legacy[amt]) return { plan: legacy[amt], interval, legacy: true };
  }
  return null;
}

/** Phone numbers a salon may hold on its plan (trial = the plan it picked). */
export function numberLimit(plan) {
  return planFor(plan).numbers || 1;
}

/** Public, display-ready plan list (billing.js ?action=plans, subscription.html). */
export function publicPlans() {
  return SELLABLE.map((id) => {
    const p = PLANS[id];
    return {
      id, name: p.name, features: p.features, numbers: p.numbers,
      monthly_cents: p.monthlyCents, annual_monthly_cents: p.annualMonthlyCents, annual_cents: p.annualCents,
      price: p.monthlyCents, interval: 'month',
      price_display: '$' + p.monthlyCents / 100, annual_display: '$' + p.annualMonthlyCents / 100,
    };
  });
}

// Human label for a usage kind, for display in the dashboard banner.
export const USAGE_LABELS = {
  voice_call: 'phone calls',
  sms_sent: 'texts sent',
  ai_token: 'AI conversations',
};
