/**
 * api/stripe-webhook.js — canonical Stripe production webhook
 * ════════════════════════════════════════════════════════════════════
 * The ONE handler for the billing pipeline (api/billing/webhook.js
 * re-exports this, so both URLs run identical logic).
 *
 * Set in Stripe Dashboard → Developers → Webhooks:
 *   URL: https://www.loladesk.com/api/stripe-webhook
 *   Events: checkout.session.completed, customer.subscription.updated,
 *           customer.subscription.deleted, invoice.payment_succeeded,
 *           invoice.payment_failed
 * ENV: STRIPE_WEBHOOK_SECRET, STRIPE_SECRET_KEY, TELNYX_API_KEY,
 *      TELNYX_MESSAGING_PROFILE_ID (optional), TELNYX_LOLA_BRAIN_ID (optional)
 *
 * checkout.session.completed AUTOMATICALLY PROVISIONS the tenant's dedicated
 * Telnyx number (search → order → TeXML connection → SMS profile) and then
 * activates the tenant. If Telnyx fails, the tenant is flagged
 * provisioning_pending instead of silently staying unprovisioned.
 */
import { db } from './lib/db.js';
import { provisionNumberForTenant } from './lib/telnyx-provision.js';
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

// Checkout sets metadata.tenantId (camelCase); accept every spelling so a
// mismatch can never silently drop the activation.
function tenantIdFrom(obj){
  const md = obj.metadata || {};
  const sd = obj.subscription_details?.metadata || {};
  return md.tenant_id || md.tenantId || obj.client_reference_id || sd.tenant_id || sd.tenantId || null;
}

async function findTenantByStripeId(c, key, value){
  if(!value) return null;
  const { data } = await c.from('tenants').select('*').eq(key, value).maybeSingle();
  return data || null;
}

async function provisionAndActivate(c, tenant, obj){
  const areaCode = obj.metadata?.preferred_area_code || obj.metadata?.areaCode || '305';
  try{
    const result = await provisionNumberForTenant(tenant, { areaCode, persist: true });
    await c.from('tenants').update({
      stripe_customer_id: obj.customer || tenant.stripe_customer_id,
      stripe_subscription_id: obj.subscription || tenant.stripe_subscription_id,
      subscription_status: 'active',
      plan: obj.metadata?.plan || tenant.plan || 'starter',
      provisioning_status: 'active',
      provisioning_error: null
    }).eq('id', tenant.id);
    return { ok: true, phoneNumber: result.phoneNumber };
  }catch(e){
    console.error('[stripe-webhook] Telnyx auto-provision failed:', e.message);
    await c.from('tenants').update({
      stripe_customer_id: obj.customer || tenant.stripe_customer_id,
      stripe_subscription_id: obj.subscription || tenant.stripe_subscription_id,
      subscription_status: 'active',           // paid — never punish the customer
      plan: obj.metadata?.plan || tenant.plan || 'starter',
      provisioning_status: 'provisioning_pending',
      provisioning_error: String(e?.message || e).slice(0, 500)
    }).eq('id', tenant.id);
    return { ok: false, error: e.message };
  }
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
    const tenantId=tenantIdFrom(obj);

    // Idempotency: one event, one effect.
    const {data:existing}=await c.from('billing_events').select('id').eq('stripe_event_id',event.id).maybeSingle();
    if(existing) return res.json({received:true,duplicate:true});

    switch(event.type){
      case 'checkout.session.completed': {
        const tid=tenantIdFrom(obj);
        if(tid){
          const { data: tenant } = await c.from('tenants').select('*').eq('id', tid).maybeSingle();
          if(tenant) await provisionAndActivate(c, tenant, obj);
          else console.error('[stripe-webhook] checkout for unknown tenant:', tid);
        }
        break;
      }
      case 'customer.subscription.updated': {
        const t=await findTenantByStripeId(c,'stripe_subscription_id',obj.id);
        if(t){
          await c.from('tenants').update({
            subscription_status: obj.cancel_at_period_end ? 'canceling' : (obj.status || t.subscription_status),
            current_period_end: obj.current_period_end ? new Date(obj.current_period_end*1000).toISOString() : null,
            plan: obj.metadata?.plan || t.plan
          }).eq('id',t.id);
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const t=await findTenantByStripeId(c,'stripe_subscription_id',obj.id);
        if(t){
          await c.from('tenants').update({
            subscription_status:'canceled',
            current_period_end: obj.current_period_end ? new Date(obj.current_period_end*1000).toISOString() : null
          }).eq('id',t.id);
        }
        break;
      }
      case 'invoice.payment_succeeded': {
        const t=await findTenantByStripeId(c,'stripe_customer_id',obj.customer);
        if(t) await c.from('tenants').update({subscription_status:'active'}).eq('id',t.id);
        break;
      }
      case 'invoice.payment_failed': {
        const t=await findTenantByStripeId(c,'stripe_customer_id',obj.customer);
        if(t) await c.from('tenants').update({subscription_status:'past_due'}).eq('id',t.id);
        break;
      }
    }

    // Log every event (best-effort audit trail).
    let logTenant=tenantId;
    if(!logTenant&&obj.customer){
      const t=await findTenantByStripeId(c,'stripe_customer_id',obj.customer);
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
