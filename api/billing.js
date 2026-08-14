/**
 * api/billing.js — SaaS subscription billing via Stripe
 *
 * GET  ?action=status          current subscription + usage
 * GET  ?action=plans           available plans
 * POST {action:'checkout'}     start subscription -> Stripe Checkout URL
 * POST {action:'portal'}       manage billing -> Stripe Portal URL
 * POST {action:'cancel'}       cancel at period end
 *
 * ENV: STRIPE_SECRET_KEY, APP_URL
 */
import { bearer, getUserFromToken } from './lib/auth.js';
import { resolveTenantForUser } from './lib/tenant-access.js';
import { db } from './lib/db.js';

const STRIPE='https://api.stripe.com/v1';

export const PLANS={
  starter:{ name:'Starter', price:9700, interval:'month',
    features:['Lola answers every call','Unlimited bookings','SMS confirmations','1 phone number','Up to 3 staff'] },
  pro:{ name:'Pro', price:19700, interval:'month',
    features:['Everything in Starter','SMS marketing campaigns','Client CRM + history','Unlimited staff','Booking platform sync','Priority support'] },
  scale:{ name:'Scale', price:39700, interval:'month',
    features:['Everything in Pro','Multiple locations','Custom Lola voice','Advanced analytics','Dedicated onboarding','API access'] }
};

function sk(){ return process.env.STRIPE_SECRET_KEY; }
function appUrl(){ return process.env.APP_URL||'https://www.loladesk.com'; }

async function stripe(path, method='GET', params=null){
  const key=sk();
  if(!key) throw new Error('Stripe not configured — set STRIPE_SECRET_KEY in Vercel');
  const opts={ method, headers:{ Authorization:'Bearer '+key, 'Content-Type':'application/x-www-form-urlencoded' } };
  if(params){
    const enc=(obj,prefix='')=>Object.entries(obj).flatMap(([k,v])=>{
      const key=prefix?prefix+'['+k+']':k;
      if(v==null) return [];
      if(typeof v==='object'&&!Array.isArray(v)) return enc(v,key);
      if(Array.isArray(v)) return v.flatMap((x,i)=>typeof x==='object'?enc(x,key+'['+i+']'):[key+'['+i+']='+encodeURIComponent(x)]);
      return [key+'='+encodeURIComponent(v)];
    });
    opts.body=enc(params).join('&');
  }
  const r=await fetch(STRIPE+path,opts);
  const j=await r.json();
  if(!r.ok) throw new Error(j?.error?.message||'Stripe error');
  return j;
}

async function ensureCustomer(c,tenant,email){
  if(tenant.stripe_customer_id) return tenant.stripe_customer_id;
  const cust=await stripe('/customers','POST',{
    email: email||tenant.owner_email,
    name: tenant.name,
    metadata:{ tenant_id:tenant.id, slug:tenant.slug||'' }
  });
  await c.from('tenants').update({stripe_customer_id:cust.id}).eq('id',tenant.id);
  return cust.id;
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
      return res.json({ok:true,plans:Object.entries(PLANS).map(([id,p])=>({id,...p,price_display:'$'+(p.price/100)}))});
    }

    const user=await getUserFromToken(bearer(req));
    if(!user) return res.status(401).json({ok:false,error:'Not authenticated'});
    const tenant=await resolveTenantForUser(user);
    if(!tenant?.id) return res.status(404).json({ok:false,error:'No tenant found'});

    // ── STATUS ──
    if(action==='status'){
      const period=new Date();period.setDate(1);
      const periodStart=period.toISOString().slice(0,10);
      const {data:usage}=await c.from('usage_meters').select('*')
        .eq('tenant_id',tenant.id).eq('period_start',periodStart).maybeSingle();

      const trialEnd=tenant.trial_ends_at?new Date(tenant.trial_ends_at):null;
      const daysLeft=trialEnd?Math.max(0,Math.ceil((trialEnd-Date.now())/86400000)):0;

      let sub=null;
      if(tenant.stripe_subscription_id&&sk()){
        try{ sub=await stripe('/subscriptions/'+tenant.stripe_subscription_id); }catch(e){}
      }

      return res.json({ok:true,
        plan:tenant.plan||'starter',
        plan_details:PLANS[tenant.plan||'starter'],
        status:tenant.subscription_status||'trialing',
        trial_days_left:daysLeft,
        trial_ends_at:tenant.trial_ends_at,
        current_period_end:sub?.current_period_end?new Date(sub.current_period_end*1000).toISOString():tenant.current_period_end,
        cancel_at_period_end:sub?.cancel_at_period_end||false,
        has_payment_method:!!tenant.stripe_subscription_id,
        usage:usage||{calls_handled:0,sms_sent:0,bookings_made:0,minutes_used:0},
        stripe_configured:!!sk()
      });
    }

    // ── CHECKOUT ──
    if(action==='checkout'){
      const planId=body.plan||'starter';
      const plan=PLANS[planId];
      if(!plan) return res.status(400).json({ok:false,error:'Unknown plan'});

      const customerId=await ensureCustomer(c,tenant,user.email);

      const session=await stripe('/checkout/sessions','POST',{
        customer:customerId,
        mode:'subscription',
        success_url:appUrl()+'/subscription.html?success=1',
        cancel_url:appUrl()+'/subscription.html?canceled=1',
        line_items:[{
          price_data:{
            currency:'usd',
            unit_amount:plan.price,
            recurring:{interval:plan.interval},
            product_data:{ name:'LolaDesk '+plan.name, description:plan.features.slice(0,3).join(' • ') }
          },
          quantity:1
        }],
        subscription_data:{ metadata:{ tenant_id:tenant.id, plan:planId } },
        metadata:{ tenant_id:tenant.id, plan:planId },
        allow_promotion_codes:true
      });

      return res.json({ok:true,url:session.url,session_id:session.id});
    }

    // ── BILLING PORTAL ──
    if(action==='portal'){
      if(!tenant.stripe_customer_id) return res.status(400).json({ok:false,error:'No billing account yet — subscribe first'});
      const portal=await stripe('/billing_portal/sessions','POST',{
        customer:tenant.stripe_customer_id,
        return_url:appUrl()+'/subscription.html'
      });
      return res.json({ok:true,url:portal.url});
    }

    // ── CANCEL ──
    if(action==='cancel'){
      if(!tenant.stripe_subscription_id) return res.status(400).json({ok:false,error:'No active subscription'});
      await stripe('/subscriptions/'+tenant.stripe_subscription_id,'POST',{cancel_at_period_end:true});
      await c.from('tenants').update({subscription_status:'canceling'}).eq('id',tenant.id);
      return res.json({ok:true,message:'Subscription will end at the current period close'});
    }

    // ── RESUME ──
    if(action==='resume'){
      if(!tenant.stripe_subscription_id) return res.status(400).json({ok:false,error:'No subscription'});
      await stripe('/subscriptions/'+tenant.stripe_subscription_id,'POST',{cancel_at_period_end:false});
      await c.from('tenants').update({subscription_status:'active'}).eq('id',tenant.id);
      return res.json({ok:true,message:'Subscription resumed'});
    }

    return res.status(400).json({ok:false,error:'Unknown action: '+action});
  }catch(e){
    console.error('[billing]',e.message);
    return res.status(500).json({ok:false,error:String(e?.message||e)});
  }
}
