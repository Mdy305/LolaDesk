// Stripe client factory scoped to a tenant's Connect account.
// The platform key (STRIPE_SECRET_KEY) is the same for every request;
// the connected account id comes from the stripe_connect_accounts table.
import Stripe from 'stripe';
import { db } from './db.js';

let _stripe = null;
function client() {
  if (_stripe) return _stripe;
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY missing');
  _stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
  return _stripe;
}

// Load the tenant's Connect record. Returns null if not connected yet.
export async function connectAccount(tenant_id) {
  const c = db();
  const { data } = await c.from('stripe_connect_accounts').select('*').eq('tenant_id', tenant_id).maybeSingle();
  return data || null;
}

// Platform-level operations (no stripeAccount header).
export function stripePlatform() {
  const s = client();
  return {
    createExpressAccount: (opts) => s.accounts.create({
      type: 'express',
      email: opts.email,
      country: opts.country || 'US',
      business_type: opts.business_type || 'individual',
      capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
      metadata: opts.metadata || {}
    }),
    retrieveAccount: (account_id) => s.accounts.retrieve(account_id),
    createAccountLink: (opts) => s.accountLinks.create(opts),
    createDashboardLink: (account_id) => s.accounts.createLoginLink(account_id),
    raw: s
  };
}

// Convenience: call any Stripe API against the tenant's connected account.
export function stripeFor(tenant_id, account_id) {
  const s = client();
  return {
    balance:   () => s.balance.retrieve({ stripeAccount: account_id }),
    payouts:   (limit=10) => s.payouts.list({ limit }, { stripeAccount: account_id }),
    updateSchedule: (schedule) => s.accounts.update(account_id, { settings: { payouts: { schedule } } }),
    createOnboardingLink: (returnUrl, refreshUrl) => s.accountLinks.create({
      account: account_id, type: 'account_onboarding',
      refresh_url: refreshUrl, return_url: returnUrl
    }),
    createDashboardLink: () => s.accounts.createLoginLink(account_id),
    payoutNow: (amount, currency='usd') => s.payouts.create({ amount, currency }, { stripeAccount: account_id }),
    refund: (payment_intent_id, opts={}) => s.refunds.create({ payment_intent: payment_intent_id, ...opts }, { stripeAccount: account_id }),
    paymentLink: (line_items, opts={}) => s.paymentLinks.create({ line_items, ...opts }, { stripeAccount: account_id }),
    createPaymentIntent: (opts) => s.paymentIntents.create({
      amount: opts.amount,
      currency: opts.currency || 'usd',
      description: opts.description,
      metadata: opts.metadata || {},
      confirm: !!opts.confirm,
      off_session: !!opts.off_session,
      automatic_payment_methods: opts.confirm ? undefined : { enabled: true },
      application_fee_amount: opts.application_fee_amount
    }, { stripeAccount: account_id }),
    retrievePaymentIntent: (id) => s.paymentIntents.retrieve(id, { stripeAccount: account_id }),
    raw: s
  };
}

export function stripe() { return client(); }

// Create a fresh Connect account for a tenant if none exists.
export async function ensureConnectAccount(tenant, ownerEmail) {
  const existing = await connectAccount(tenant.id);
  if (existing) return existing;
  const s = client();
  const acct = await s.accounts.create({
    type: 'express',
    email: ownerEmail,
    metadata: { tenant_id: tenant.id, tenant_slug: tenant.slug || '' },
    capabilities: { card_payments: { requested: true }, transfers: { requested: true } }
  });
  const c = db();
  const { data } = await c.from('stripe_connect_accounts').insert({
    tenant_id: tenant.id,
    stripe_account_id: acct.id,
    sub_state: 'pending'
  }).select().single();
  return data;
}

// Verify Stripe webhook signature — required for POST /api/stripe-webhook.
export function verifyStripeSig(rawBody, signature) {
  try {
    const s = client();
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET missing');
    return s.webhooks.constructEvent(rawBody, signature, secret);
  } catch (e) {
    console.error('verifyStripeSig failed', e?.message);
    return null;
  }
}
