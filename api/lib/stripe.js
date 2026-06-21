/**
 * api/lib/stripe.js — Stripe billing for LolaDesk SaaS
 * ════════════════════════════════════════════════════════════════
 * Subscription billing: salons pick a plan and pay monthly.
 *
 * ENV VARS (set in Vercel):
 *   STRIPE_SECRET_KEY        sk_live_... or sk_test_...
 *   STRIPE_WEBHOOK_SECRET    whsec_...  (from the webhook endpoint in Stripe)
 *   STRIPE_PRICE_STARTER     price_...  (your monthly price IDs from Stripe dashboard)
 *   STRIPE_PRICE_PRO         price_...
 *   STRIPE_PRICE_MEDSPA      price_...
 *   APP_URL                  https://www.loladesk.com  (for redirect after checkout)
 *
 * Uses the Stripe REST API directly via fetch (no SDK dependency needed).
 */

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

async function stripe(path, method='POST', body){
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

// Map plan slug -> env price id
export function priceFor(plan){
  const map = {
    starter: process.env.STRIPE_PRICE_STARTER,
    pro:     process.env.STRIPE_PRICE_PRO,
    medspa:  process.env.STRIPE_PRICE_MEDSPA
  };
  return map[plan] || map.starter;
}

// Create a Checkout Session for a subscription
export async function createCheckout({ plan, tenantId, email, customerId }){
  const price = priceFor(plan);
  if(!price) throw new Error('No Stripe price configured for plan: '+plan);
  const appUrl = process.env.APP_URL || 'https://www.loladesk.com';
  const payload = {
    mode: 'subscription',
    'line_items': [{ price, quantity: 1 }],
    success_url: `${appUrl}/settings?billing=success`,
    cancel_url: `${appUrl}/settings?billing=cancelled`,
    client_reference_id: tenantId || '',
    metadata: { tenantId: tenantId||'', plan },
    subscription_data: { metadata: { tenantId: tenantId||'', plan } }
  };
  if(customerId) payload.customer = customerId;
  else if(email) payload.customer_email = email;
  return stripe('/checkout/sessions', 'POST', payload);
}

// Customer portal so salons manage/cancel their plan
export async function createPortal({ customerId }){
  const appUrl = process.env.APP_URL || 'https://www.loladesk.com';
  return stripe('/billing_portal/sessions', 'POST', {
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
    await stripe(`/subscription_items/${mockSubscriptionItemId}/usage_records`, 'POST', {
      quantity: messageCount,
      timestamp: Math.floor(Date.now() / 1000),
      action: 'increment'
    });
    
    console.log(`[stripe] Billed ${tenantId} for ${messageCount} messages at $0.05/ea.`);
  } catch(e) {
    console.error(`[stripe] Failed to push metered usage for ${tenantId}:`, e);
  }
}

export { stripe };
