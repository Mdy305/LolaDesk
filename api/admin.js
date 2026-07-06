/**
 * /api/admin — PLATFORM-OWNER control panel (cross-tenant).
 * GET  → overview (customers, membership, service analytics).
 * POST → admin actions (status/plan/trial/features/delete, tenant detail, config).
 *
 *   Gate: authenticated user's email must be in ADMIN_EMAILS (comma list).
 *         Unset → EVERYONE denied (fail closed). Never loosen this.
 */
import { getUserFromToken, bearer } from './lib/auth.js';
import { db } from './lib/db.js';

const PLAN_PRICE = { starter: 99, solo: 99, pro: 399, medspa: 599, enterprise: 0 };
const VALID_STATUS = ['active','trial','past_due','cancelled','suspended'];
const VALID_PLAN = ['starter','solo','pro','medspa','enterprise'];

function isAdmin(user){
  const list = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if(!list.length) return false;                         // fail closed
  return list.includes(String(user?.email || '').toLowerCase());
}

async function overview(c, res){
  const since = new Date(Date.now() - 30*86400000).toISOString();
  const [tenantsR, callsR, bookingsR, usageR] = await Promise.all([
    c.from('tenants').select('id,slug,name,owner_name,owner_email,phone_number,plan,billing_status,features,admin_note,stripe_customer_id,trial_ends_at,created_at').order('created_at',{ascending:false}).limit(2000),
    c.from('calls').select('tenant_id,outcome,created_at').gte('created_at',since).limit(50000),
    c.from('bookings').select('tenant_id,price,status,starts_at').gte('starts_at',since).limit(50000),
    c.from('usage_events').select('tenant_id,kind,units,created_at').gte('created_at',since).limit(100000)
  ]);
  const tenants = tenantsR.data||[], calls=callsR.data||[], bookings=bookingsR.data||[], usage=usageR.data||[];
  const byTenant={}; const bucket=id=>(byTenant[id]=byTenant[id]||{calls:0,booked:0,bookings:0,revenue:0,sms:0});
  for(const x of calls){ const b=bucket(x.tenant_id); b.calls++; if(x.outcome==='booked') b.booked++; }
  for(const x of bookings){ const b=bucket(x.tenant_id); b.bookings++; b.revenue+=Number(x.price||0); }
  for(const x of usage){ const k=String(x.kind||''); if(k.includes('sms')||k.includes('whatsapp')) bucket(x.tenant_id).sms+=Number(x.units||1); }
  const now=Date.now();
  const customers = tenants.map(t=>{
    const b=byTenant[t.id]||{calls:0,booked:0,bookings:0,revenue:0,sms:0};
    const status=t.billing_status||'trial';
    return { id:t.id,name:t.name,slug:t.slug,owner:t.owner_name||'',email:t.owner_email||'',phone:t.phone_number||'',
      plan:t.plan||'starter',status,features:t.features||{},note:t.admin_note||'',
      createdAt:t.created_at,trialEndsAt:t.trial_ends_at||null,
      calls30:b.calls,sms30:b.sms,bookings30:b.bookings,revenue30:Math.round(b.revenue) };
  });
  const planCounts={},statusCounts={}; let mrr=0;
  for(const cu of customers){ planCounts[cu.plan]=(planCounts[cu.plan]||0)+1; statusCounts[cu.status]=(statusCounts[cu.status]||0)+1; if(cu.status==='active') mrr+=(PLAN_PRICE[cu.plan]||0); }
  const trialsEndingSoon=customers.filter(cu=>cu.status==='trial'&&cu.trialEndsAt&&new Date(cu.trialEndsAt)-now<5*86400000&&new Date(cu.trialEndsAt)-now>0).length;
  const smsTotal=customers.reduce((s,c)=>s+c.sms30,0);
  const qr=usage.filter(u=>u.kind==='interaction_quality');
  const qualityAvg=qr.length?Math.round(qr.reduce((s,u)=>s+Number(u.units||0),0)/qr.length):null;
  const analytics={ calls30:calls.length, booked30:calls.filter(x=>x.outcome==='booked').length, sms30:smsTotal, bookings30:bookings.length,
    revenue30:Math.round(bookings.reduce((s,x)=>s+Number(x.price||0),0)), qualityAvg,
    topTenants:[...customers].sort((a,b)=>(b.calls30+b.sms30)-(a.calls30+a.sms30)).slice(0,5).map(c=>({name:c.name,activity:c.calls30+c.sms30,calls30:c.calls30,sms30:c.sms30})) };
  let config={}; try{ const { data }=await c.from('platform_config').select('data').eq('id','global').maybeSingle(); config=data?.data||{}; }catch{}
  return res.status(200).json({ generatedAt:new Date().toISOString(),
    totals:{ customers:customers.length, mrr, mrrMoney:'$'+mrr.toLocaleString() },
    membership:{ planCounts, statusCounts, trialsEndingSoon }, analytics, customers, config,
    meta:{ statuses:VALID_STATUS, plans:VALID_PLAN, planPrice:PLAN_PRICE } });
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  if(req.method==='OPTIONS') return res.status(200).end();

  try{
    const user = await getUserFromToken(bearer(req));
    if(!user) return res.status(401).json({ error:'not authenticated' });
    if(!isAdmin(user)) return res.status(403).json({ error:'not authorized (admin only)' });
    const c = db();
    if(!c) return res.status(503).json({ error:'database not configured' });

    if(req.method==='GET') return await overview(c, res);
    if(req.method!=='POST') return res.status(405).json({ error:'method not allowed' });

    const body = typeof req.body==='string' ? JSON.parse(req.body||'{}') : (req.body||{});
    const action = String(body.action||'');
    const tid = body.tenantId;

    switch(action){
      case 'tenant.set_status': {
        if(!tid || !VALID_STATUS.includes(body.status)) return res.status(400).json({ error:'bad status' });
        await c.from('tenants').update({ billing_status: body.status }).eq('id', tid);
        return res.status(200).json({ ok:true });
      }
      case 'tenant.set_plan': {
        if(!tid || !VALID_PLAN.includes(body.plan)) return res.status(400).json({ error:'bad plan' });
        await c.from('tenants').update({ plan: body.plan }).eq('id', tid);
        return res.status(200).json({ ok:true });
      }
      case 'tenant.extend_trial': {
        const days = Math.max(1, Math.min(365, parseInt(body.days)||14));
        const until = new Date(Date.now()+days*86400000).toISOString();
        await c.from('tenants').update({ trial_ends_at: until, billing_status: 'trial' }).eq('id', tid);
        return res.status(200).json({ ok:true, trial_ends_at: until });
      }
      case 'tenant.set_features': {
        if(!tid || typeof body.features!=='object') return res.status(400).json({ error:'bad features' });
        const { data } = await c.from('tenants').select('features').eq('id', tid).maybeSingle();
        const merged = { ...(data?.features||{}), ...body.features };
        await c.from('tenants').update({ features: merged }).eq('id', tid);
        return res.status(200).json({ ok:true, features: merged });
      }
      case 'tenant.set_note': {
        await c.from('tenants').update({ admin_note: String(body.note||'').slice(0,500) }).eq('id', tid);
        return res.status(200).json({ ok:true });
      }
      case 'tenant.delete': {
        if(!tid || body.confirm!==true) return res.status(400).json({ error:'delete requires confirm:true' });
        await c.from('tenants').delete().eq('id', tid);
        return res.status(200).json({ ok:true, deleted: tid });
      }
      case 'tenant.detail': {
        if(!tid) return res.status(400).json({ error:'missing tenantId' });
        const [t, calls, bookings, clients] = await Promise.all([
          c.from('tenants').select('*').eq('id',tid).maybeSingle().then(r=>r.data),
          c.from('calls').select('from_number,outcome,duration_sec,summary,created_at').eq('tenant_id',tid).order('created_at',{ascending:false}).limit(10).then(r=>r.data||[]),
          c.from('bookings').select('service,client_name,price,status,starts_at').eq('tenant_id',tid).order('starts_at',{ascending:false}).limit(10).then(r=>r.data||[]),
          c.from('clients').select('id',{count:'exact',head:true}).eq('tenant_id',tid).then(r=>r.count||0)
        ]);
        if(!t) return res.status(404).json({ error:'not found' });
        return res.status(200).json({ tenant:{ id:t.id,name:t.name,slug:t.slug,owner:t.owner_name,email:t.owner_email,phone:t.phone_number,plan:t.plan,status:t.billing_status,features:t.features||{},note:t.admin_note||'',createdAt:t.created_at,trialEndsAt:t.trial_ends_at }, recentCalls:calls, recentBookings:bookings, clientCount:clients });
      }
      case 'config.set': {
        if(typeof body.config!=='object') return res.status(400).json({ error:'bad config' });
        const { data } = await c.from('platform_config').select('data').eq('id','global').maybeSingle();
        const merged = { ...(data?.data||{}), ...body.config };
        await c.from('platform_config').upsert({ id:'global', data:merged, updated_at:new Date().toISOString() });
        return res.status(200).json({ ok:true, config: merged });
      }
      default:
        return res.status(400).json({ error:'unknown action' });
    }
  }catch(e){
    return res.status(500).json({ error:String(e&&e.message||e) });
  }
}

