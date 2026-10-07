/**
 * api/billing.js — SaaS subscription billing via Stripe
 *
 * GET  ?action=status          current subscription + usage (from usage_events / calls / bookings)
 * GET  ?action=plans           available plans (lib/plans.js — the one price list)
 * POST {action:'checkout', plan, interval}  no subscription yet → Stripe Checkout URL
 *                                           live subscription  → switches it in place (prorated)
 * POST {action:'switch', plan, interval}    switch plan in place (never a second subscription)
 * POST {action:'portal'}       manage billing -> Stripe Portal URL
 * POST {action:'cancel'}       cancel at period end
 * POST {action:'resume'}       undo a pending cancel
 *
 * Prices: lib/plans.js (Starter $99 / Pro $399 / Med-Spa $599 a month; annual
 * $79 / $319 / $479 a month billed yearly). Env price ids optional:
 * STRIPE_PRICE_<PLAN>_<MONTHLY|ANNUAL>.
 *
 * ENV: STRIPE_SECRET_KEY, APP_URL
 */
import { bearer, getUserFromToken } from './lib/auth.js';
import { feeSummary } from './lib/booking-fees.js';
import { resolveTenantForUser } from './lib/tenant-access.js';
import { db } from './lib/db.js';
import { PLANS as PLAN_TABLE, normalizePlan, normalizeInterval, publicPlans, SELLABLE, mrrCents } from './lib/plans.js';
import { stripeApi, createCheckout, changeSubscriptionPlan } from './lib/stripe.js';
import { serviceStatus, pausedBecause } from './lib/service-gate.js';

// Kept for importers: the sellable plans keyed by id, in cents (from lib/plans.js).
export const PLANS = Object.fromEntries(SELLABLE.map((id) => [id, {
  name: PLAN_TABLE[id].name, price: PLAN_TABLE[id].monthlyCents, annual_price: PLAN_TABLE[id].annualCents,
  annual_monthly: PLAN_TABLE[id].annualMonthlyCents, interval: 'month', features: PLAN_TABLE[id].features,
}]));

function sk(){ return process.env.STRIPE_SECRET_KEY; }
function appUrl(){ return String(process.env.APP_URL||'https://www.loladesk.com').replace(/\/+$/,''); }
const LIVE_SUB = ['active','trialing','past_due','canceling','unpaid','incomplete'];

async function ensureCustomer(c,tenant,email){
  if(tenant.stripe_customer_id) return tenant.stripe_customer_id;
  const cust=await stripeApi('/customers','POST',{
    email: email||tenant.owner_email,
    name: tenant.name,
    metadata:{ tenant_id:tenant.id, slug:tenant.slug||'' }
  });
  await c.from('tenants').update({stripe_customer_id:cust.id}).eq('id',tenant.id);
  return cust.id;
}

function periodStart(tenant, sub){
  // The Stripe billing period when we have one; otherwise the calendar month.
  const s = sub?.current_period_start ? new Date(sub.current_period_start*1000) : null;
  if(s && !Number.isNaN(s.getTime())) return s.toISOString();
  const d=new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

/** Real usage this period: usage_events first, the calls/bookings tables as the floor. */
export async function usageThisPeriod(c, tenantId, since){
  const out={ calls_handled:0, sms_sent:0, bookings_made:0, minutes_used:0, period_start:since };
  const safe=(p)=>Promise.resolve(p).then(r=>r||{},()=>({}));
  const [ev, calls, bookings] = await Promise.all([
    safe(c.from('usage_events').select('kind,units').eq('tenant_id',tenantId).in('kind',['voice_call','call_minute','sms_sent','textback_sent','booking_link_sent','booking','operator_sms']).gte('created_at',since).limit(50000)),
    safe(c.from('calls').select('id,duration_seconds,duration',{count:'exact'}).eq('tenant_id',tenantId).gte('created_at',since).limit(5000)),
    safe(c.from('bookings').select('id,status',{count:'exact'}).eq('tenant_id',tenantId).gte('created_at',since).limit(5000)),
  ]);
  let evCalls=0, evMinutes=0, evSms=0, evBookings=0;
  for(const r of ev.data||[]){
    const u=Number(r.units??1)||0;
    if(r.kind==='voice_call') evCalls+=1;
    else if(r.kind==='call_minute') evMinutes+=u;
    else if(r.kind==='booking') evBookings+=1;
    else evSms+=Math.max(1,Math.round(u));
  }
  const callRows=calls.data||[];
  const tableMinutes=callRows.reduce((s,x)=>s+(Number(x.duration_seconds??x.duration)||0),0)/60;
  const bookingRows=(bookings.data||[]).filter(b=>!/^cancel/i.test(String(b.status||'')));
  out.calls_handled=Math.max(evCalls, calls.count ?? callRows.length);
  out.minutes_used=Math.round(Math.max(evMinutes, tableMinutes));
  out.sms_sent=evSms;
  out.bookings_made=Math.max(evBookings, bookingRows.length);
  return out;
}

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization');
  if(req.method==='OPTIONS') return res.status(204).end();

  const c=db();
  if(!c) return res.status(503).json({ok:false,error:'Database not configured'});

  try{
    const body=typeof req.body==='string'?JSON.parse(req.body||'{}'):(req.body||{});
    const action=body.action||req.query?.action||'status';

    if(action==='plans'){
      return res.json({ok:true,plans:publicPlans()});
    }

    const user=await getUserFromToken(bearer(req));
    if(!user) return res.status(401).json({ok:false,error:'Not authenticated'});
    const tenant=await resolveTenantForUser(user);
    if(!tenant?.id) return res.status(404).json({ok:false,error:'No tenant found'});
    const tenantPlan=normalizePlan(tenant.plan)||'starter';

    // ── STATUS ──
    if(action==='status'){
      const trialEnd=tenant.trial_ends_at?new Date(tenant.trial_ends_at):null;
      const daysLeft=trialEnd?Math.max(0,Math.ceil((trialEnd-Date.now())/86400000)):0;

      let sub=null;
      if(tenant.stripe_subscription_id&&sk()){
        try{ sub=await stripeApi('/subscriptions/'+tenant.stripe_subscription_id); }catch(e){}
      }
      const usage=await usageThisPeriod(c,tenant.id,periodStart(tenant,sub)).catch(()=>({calls_handled:0,sms_sent:0,bookings_made:0,minutes_used:0}));
      const service=serviceStatus(tenant);
      const p=PLAN_TABLE[tenantPlan];
      const interval=normalizeInterval(tenant.billing_interval||sub?.items?.data?.[0]?.price?.recurring?.interval);
      const raw=tenant.subscription_status;
      const status=(raw==='trial'||!raw)?'trialing':raw;

      return res.json({ok:true,
        plan:tenantPlan,
        interval,
        plan_details:p?{ name:p.name, price:p.monthlyCents, annual_monthly:p.annualMonthlyCents, features:p.features, numbers:p.numbers }:null,
        mrr_cents:['active','canceling','past_due'].includes(raw)?mrrCents(tenantPlan,interval):0,
        // The database default is 'trial'; the app speaks 'trialing' — so the
        // days-left banner and the paywall actually show.
        status,
        has_subscription:!!tenant.stripe_subscription_id && LIVE_SUB.includes(String(raw||'')),
        trial_days_left:daysLeft,
        trial_ends_at:tenant.trial_ends_at,
        current_period_end:sub?.current_period_end?new Date(sub.current_period_end*1000).toISOString():tenant.current_period_end,
        cancel_at_period_end:sub?.cancel_at_period_end||raw==='canceling'||false,
        has_payment_method:!!tenant.stripe_subscription_id,
        service:{ ok:service.ok, reason:service.reason||null, paused_because:service.ok?null:pausedBecause(service.reason), grace_until:service.grace_until||null },
        usage,
        // What Lola booked for this salon this month, and LolaDesk's per-appointment fee.
        lola_bookings:await feeSummary(c,{tenantId:tenant.id}).catch(()=>null),
        stripe_configured:!!sk()
      });
    }

    // ── CHECKOUT / SWITCH ──
    if(action==='checkout'||action==='switch'){
      const planId=normalizePlan(body.plan||'starter');
      if(!planId||!SELLABLE.includes(planId)) return res.status(400).json({ok:false,error:'Unknown plan'});
      const interval=normalizeInterval(body.interval||body.billing||body.cycle);
      if(!sk()) return res.status(503).json({ok:false,error:'Stripe not configured — set STRIPE_SECRET_KEY in Vercel'});

      // A salon that already pays switches its ONE subscription in place.
      const live=tenant.stripe_subscription_id && LIVE_SUB.includes(String(tenant.subscription_status||''));
      if(live && action==='checkout'){
        // A plain "Upgrade" button (trial banner) never changes a live plan by itself: the Billing page
        // shows the plans and switches only on an explicit choice.
        return res.json({ok:true,switched:false,already_subscribed:true,url:'/subscription',message:'You already have a subscription — choose a plan on the Billing page.'});
      }
      if(live){
        if(planId===tenantPlan && interval===normalizeInterval(tenant.billing_interval) && tenant.subscription_status!=='canceling')
          return res.json({ok:true,switched:false,message:'You are already on this plan.'});
        const updated=await changeSubscriptionPlan({ subscriptionId:tenant.stripe_subscription_id, plan:planId, interval, tenantId:tenant.id });
        const patch={ plan:planId, billing_interval:interval };
        if(tenant.subscription_status==='canceling') patch.subscription_status=updated?.status==='trialing'?'trialing':'active';
        let u=await c.from('tenants').update(patch).eq('id',tenant.id);
        if(u?.error){ delete patch.billing_interval; await c.from('tenants').update(patch).eq('id',tenant.id); }
        return res.json({ok:true,switched:true,plan:planId,interval,message:`Switched to ${PLAN_TABLE[planId].name}${interval==='annual'?' (annual)':''}. Stripe prorates the difference on your next invoice.`});
      }
      if(action==='switch') return res.status(400).json({ok:false,error:'No active subscription — pick a plan to subscribe.'});

      const customerId=await ensureCustomer(c,tenant,user.email);
      const trialLeft=String(tenant.subscription_status||'trial')==='trial' && tenant.trial_ends_at && new Date(tenant.trial_ends_at)>new Date();
      const session=await createCheckout({
        plan:planId, interval, tenantId:tenant.id, customerId,
        successUrl:appUrl()+'/subscription.html?success=1',
        cancelUrl:appUrl()+'/subscription.html?canceled=1',
        trialEnd: trialLeft ? tenant.trial_ends_at : null
      });
      return res.json({ok:true,url:session.url,session_id:session.id});
    }

    // ── BILLING PORTAL ──
    if(action==='portal'){
      if(!tenant.stripe_customer_id) return res.status(400).json({ok:false,error:'No billing account yet — subscribe first'});
      const portal=await stripeApi('/billing_portal/sessions','POST',{
        customer:tenant.stripe_customer_id,
        return_url:appUrl()+'/subscription.html'
      });
      return res.json({ok:true,url:portal.url});
    }

    // ── CANCEL ──
    if(action==='cancel'){
      if(!tenant.stripe_subscription_id) return res.status(400).json({ok:false,error:'No active subscription'});
      await stripeApi('/subscriptions/'+tenant.stripe_subscription_id,'POST',{cancel_at_period_end:true});
      await c.from('tenants').update({subscription_status:'canceling'}).eq('id',tenant.id);
      return res.json({ok:true,message:'Subscription will end at the current period close'});
    }

    // ── RESUME ──
    if(action==='resume'){
      if(!tenant.stripe_subscription_id) return res.status(400).json({ok:false,error:'No subscription'});
      const s=await stripeApi('/subscriptions/'+tenant.stripe_subscription_id,'POST',{cancel_at_period_end:false});
      await c.from('tenants').update({subscription_status:s?.status==='trialing'?'trialing':'active'}).eq('id',tenant.id);
      return res.json({ok:true,message:'Subscription resumed'});
    }

    return res.status(400).json({ok:false,error:'Unknown action: '+action});
  }catch(e){
    console.error('[billing]',e.message);
    return res.status(500).json({ok:false,error:String(e?.message||e)});
  }
}
