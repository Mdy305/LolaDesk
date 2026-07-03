/**
 * POST /api/billing/webhook — Stripe events
 * Activates/suspends tenants on payment success/failure.
 * Set this URL in Stripe Dashboard -> Developers -> Webhooks:
 *   https://www.loladesk.com/api/billing/webhook
 * Subscribe to: checkout.session.completed, customer.subscription.updated,
 *   customer.subscription.deleted, invoice.payment_failed
 *
 * IMPORTANT: needs the raw request body for signature verification.
 */
import { verifyWebhook } from '../lib/stripe.js';
import { db } from '../lib/db.js';

export const config = { api: { bodyParser: false } };

function readRaw(req){
  return new Promise((resolve)=>{ let d=''; req.on('data',c=>d+=c); req.on('end',()=>resolve(d)); });
}

async function setTenantBilling({ tenantId, customerId, plan, status }){
  const c = db(); if(!c || !tenantId) return;
  const patch = {};
  if(customerId) patch.stripe_customer_id = customerId;
  if(plan) patch.plan = plan;
  if(status) patch.billing_status = status;
  try{ await c.from('tenants').update(patch).eq('id', tenantId); }catch(e){}
}

export default async function handler(req, res){
  if(req.method!=='POST') return res.status(405).end();
  try{
    const raw = await readRaw(req);
    const sig = req.headers['stripe-signature'];
    const event = await verifyWebhook(raw, sig);
    const o = event.data?.object || {};
    const tenantId = o.metadata?.tenantId || o.client_reference_id;

    switch(event.type){
      case 'checkout.session.completed':
        await setTenantBilling({ tenantId, customerId:o.customer, plan:o.metadata?.plan, status:'active' });
        break;
      case 'customer.subscription.updated':
        await setTenantBilling({ tenantId:o.metadata?.tenantId, customerId:o.customer, status:o.status });
        break;
      case 'customer.subscription.deleted':
        await setTenantBilling({ tenantId:o.metadata?.tenantId, customerId:o.customer, status:'cancelled' });
        break;
      case 'invoice.payment_failed':
        await setTenantBilling({ tenantId:o.subscription_details?.metadata?.tenantId, customerId:o.customer, status:'past_due' });
        break;
    }
    return res.status(200).json({ received:true });
  }catch(e){
    return res.status(400).json({ error:String(e&&e.message||e) });
  }
}
