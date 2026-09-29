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


// ═══════════════════════════════════════════════════════════════════
// Billing + deposits (REST). Restored: the Sep 22 Connect rewrite of this
// file dropped these exports, and every module importing them failed to
// load — /api/calendar, Lola, voice booking, deposits, checkout, portal.
// ═══════════════════════════════════════════════════════════════════
const STRIPE_API = 'https://api.stripe.com/v1';

function key(){ return process.env.STRIPE_SECRET_KEY; }

// Stripe wants form-encoded bodies; this flattens nested objects.
function form(obj, prefix='', out=[]){
  for(const k in obj){
    const v = obj[k];
    const key = prefix ? `${prefix}[${k}]` : k;
    if(v && typeof v === 'object' && !Array.isArray(v)) form(v, key, out);
    else if(Array.isArray(v)) v.forEach((item,i)=>{
      if(item && typeof item==='object') form(item, `${key}[${i}]`, out);
      else out.push(`${encodeURIComponent(key)}[${i}]=${encodeURIComponent(item)}`);
    });
    else if(v!==undefined && v!==null) out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return out.join('&');
}

async function stripeRest(path, method='POST', body){
  const r = await fetch(`${STRIPE_API}${path}`, {
    method,
    headers:{
      'Authorization': `Bearer ${key()}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: body ? form(body) : undefined
  });
  const data = await r.json();
  if(!r.ok) throw new Error(data?.error?.message || `Stripe ${r.status}`);
  return data;
}

// Normalize the marketing slugs to billing plan keys.
const PLAN_ALIAS = { solo:'starter', starter:'starter', pro:'pro', medspa:'medspa', 'med-spa':'medspa' };

// Map plan slug + billing interval -> env price id
export function priceFor(plan, interval='monthly'){
  const p = PLAN_ALIAS[plan] || 'starter';
  const monthly = {
    starter: process.env.STRIPE_PRICE_STARTER,
    pro:     process.env.STRIPE_PRICE_PRO,
    medspa:  process.env.STRIPE_PRICE_MEDSPA
  };
  const annual = {
    starter: process.env.STRIPE_PRICE_STARTER_ANNUAL,
    pro:     process.env.STRIPE_PRICE_PRO_ANNUAL,
    medspa:  process.env.STRIPE_PRICE_MEDSPA_ANNUAL
  };
  const map = interval === 'annual' ? annual : monthly;
  // Fall back to the monthly price if an annual one isn't configured yet.
  return map[p] || monthly[p] || monthly.starter;
}

// Create a Checkout Session for a subscription
export async function createCheckout({ plan, tenantId, email, customerId, interval='monthly', areaCode }){
  const price = priceFor(plan, interval);
  if(!price) throw new Error('No Stripe price configured for plan: '+plan);
  const appUrl = process.env.APP_URL || 'https://www.loladesk.com';
  // Both spellings are shipped so the webhook can never miss the tenant, and
  // preferred_area_code lets checkout.session.completed auto-provision the
  // salon's own local area-code number (defaults to 305 upstream).
  const md = { tenantId: tenantId||'', tenant_id: tenantId||'', plan, interval, preferred_area_code: areaCode || '' };
  const payload = {
    mode: 'subscription',
    'line_items': [{ price, quantity: 1 }],
    success_url: `${appUrl}/settings?billing=success`,
    cancel_url: `${appUrl}/settings?billing=cancelled`,
    client_reference_id: tenantId || '',
    metadata: md,
    subscription_data: { metadata: md }
  };
  if(customerId) payload.customer = customerId;
  else if(email) payload.customer_email = email;
  return stripeRest('/checkout/sessions', 'POST', payload);
}

// Customer portal so salons manage/cancel their plan
export async function createPortal({ customerId }){
  const appUrl = process.env.APP_URL || 'https://www.loladesk.com';
  return stripeRest('/billing_portal/sessions', 'POST', {
    customer: customerId,
    return_url: `${appUrl}/settings`
  });
}

// Verify a webhook signature (Stripe signs with HMAC-SHA256)
export async function verifyWebhook(rawBody, sig){
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if(!secret) throw new Error('Missing STRIPE_WEBHOOK_SECRET');
  // sig header: t=timestamp,v1=signature
  const parts = Object.fromEntries(sig.split(',').map(p=>p.split('=')));
  const signedPayload = `${parts.t}.${rawBody}`;
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey('raw', enc.encode(secret),
    { name:'HMAC', hash:'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(signedPayload));
  const hex = [...new Uint8Array(mac)].map(b=>b.toString(16).padStart(2,'0')).join('');
  if(hex !== parts.v1) throw new Error('Invalid webhook signature');
  return JSON.parse(rawBody);
}

// ── Automated Metered Billing ──
// Pushes $0.05 per text usage records to Stripe Connect
export async function flushMeteredTextUsageToStripe(tenantId, messageCount = 1){
  try {
    // 1. Fetch the active subscription item for the metered text product
    // In a production database, you would look up the exact subscription_item_id
    // linked to this tenant. We use a mock ID for demonstration.
    const mockSubscriptionItemId = `si_${tenantId}_texts`; 

    // 2. Push the usage record to Stripe
    await stripeRest(`/subscription_items/${mockSubscriptionItemId}/usage_records`, 'POST', {
      quantity: messageCount,
      timestamp: Math.floor(Date.now() / 1000),
      action: 'increment'
    });
    
    console.log(`[stripe] Billed ${tenantId} for ${messageCount} messages at $0.05/ea.`);
  } catch(e) {
    console.error(`[stripe] Failed to push metered usage for ${tenantId}:`, e);
  }
}

// ── Booking deposits ──
// One primitive: a Payment Link with an on-the-fly price. The client pays on
// Stripe's hosted page (no card data ever touches LolaDesk); checkout.session
// .completed on that link flips the deposit row in api/stripe-webhook.js and
// records the PaymentIntent id for later refunds.
export async function createPaymentLink({ amountCents, description, successUrl }){
  if(!Number.isFinite(amountCents) || amountCents <= 0) throw new Error('deposit amount must be positive');
  const body = {
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: Math.round(amountCents),
        product_data: { name: description || 'Booking deposit' }
      }
    }],
    after_completion: { type: 'redirect', redirect: { url: successUrl || `${process.env.APP_URL || 'https://www.loladesk.com'}/paid` } }
  };
  const link = await stripeRest('/payment_links', 'POST', body);
  return { id: link.id, url: link.url };
}

// Refund a deposit's PaymentIntent (in-window cancellations).
export async function stripeRefund(paymentIntentId){
  return stripeRest('/refunds', 'POST', { payment_intent: paymentIntentId });
}

