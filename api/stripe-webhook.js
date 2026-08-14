/**
 * api/stripe-webhook.js — Stripe event handler
 * Set in Stripe Dashboard → Developers → Webhooks:
 *   URL: https://www.loladesk.com/api/stripe-webhook
 *   Events: checkout.session.completed, customer.subscription.updated,
 *           customer.subscription.deleted, invoice.payment_succeeded,
 *           invoice.payment_failed
 * ENV: STRIPE_WEBHOOK_SECRET
 */
import { db } from './lib/db.js';
import crypto from 'crypto';

export const config = { api: { bodyParser: false } };

async function rawBody(req){
  const chunks=[];
  for await(const chunk of req) chunks.push(typeof chunk==='string'?Buffer.from(chunk):chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function verify(payload, sig, secret){
  if(!secret) return true;
  try{
    const parts=Object.fromEntries(String(sig).split(',').map(p=>p.split('=')));
    const expected=crypto.createHmac('sha256',secret).update(parts.t+'.'+payload).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(parts.v1));
  }catch(e){ return false; }
}

export default async function handler(req,res){
  if(req.method!=='POST') return res.status(405).json({error:'POST only'});

  const c=db();
  if(!c) return res.status(503).json({error:'Database not configured'});

  try{
    const payload=await rawBody(req);
    const sig=req.headers['stripe-signature'];
    if(!verify(payload,sig,process.env.STRIPE_WEBHOOK_SECRET)){
      return res.status(400).json({error:'Invalid signature'});
    }

    const event=JSON.parse(payload);
    const obj=event.data?.object||{};
    const tenantId=obj.metadata?.tenant_id||obj.subscription_details?.metadata?.tenant_id;

    // Idempotency
    const {data:existing}=await c.from('billing_events').select('id').eq('stripe_event_id',event.id).maybeSingle();
    if(existing) return res.json({received:true,duplicate:true});

    switch(event.type){
      case 'checkout.session.completed': {
        const tid=obj.metadata?.tenant_id;
        if(tid){
          await c.from('tenants').update({
            stripe_customer_id:obj.customer,
            stripe_subscription_id:obj.subscription,
            subscription_status:'active',
            plan:obj.metadata?.plan||'starter'
          }).eq('id',tid);
        }
        break;
      }
      case 'customer.subscription.updated': {
        const {data:t}=await c.from('tenants').select('id').eq('stripe_subscription_id',obj.id).maybeSingle();
        if(t){
          await c.from('tenants').update({
            subscription_status:obj.cancel_at_period_end?'canceling':obj.status,
            current_period_end:obj.current_period_end?new Date(obj.current_period_end*1000).toISOString():null,
            plan:obj.metadata?.plan||undefined
          }).eq('id',t.id);
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const {data:t}=await c.from('tenants').select('id').eq('stripe_subscription_id',obj.id).maybeSingle();
        if(t){
          await c.from('tenants').update({
            subscription_status:'canceled',
            stripe_subscription_id:null
          }).eq('id',t.id);
        }
        break;
      }
      case 'invoice.payment_succeeded': {
        const {data:t}=await c.from('tenants').select('id').eq('stripe_customer_id',obj.customer).maybeSingle();
        if(t) await c.from('tenants').update({subscription_status:'active'}).eq('id',t.id);
        break;
      }
      case 'invoice.payment_failed': {
        const {data:t}=await c.from('tenants').select('id').eq('stripe_customer_id',obj.customer).maybeSingle();
        if(t) await c.from('tenants').update({subscription_status:'past_due'}).eq('id',t.id);
        break;
      }
    }

    // Log every event
    let logTenant=tenantId;
    if(!logTenant&&obj.customer){
      const {data:t}=await c.from('tenants').select('id').eq('stripe_customer_id',obj.customer).maybeSingle();
      logTenant=t?.id;
    }
    await c.from('billing_events').insert({
      tenant_id:logTenant||null,
      stripe_event_id:event.id,
      type:event.type,
      amount:obj.amount_total||obj.amount_paid||obj.amount||null,
      currency:obj.currency||'usd',
      status:obj.status||null,
      data:{ customer:obj.customer, subscription:obj.subscription }
    }).catch(()=>{});

    return res.json({received:true});
  }catch(e){
    console.error('[stripe-webhook]',e.message);
    return res.status(500).json({error:String(e?.message||e)});
  }
}
