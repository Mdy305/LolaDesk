/**
 * /api/admin — PLATFORM-OWNER dashboard data (cross-tenant).
 * Aggregates customers (salons), membership/billing, and service analytics
 * across ALL tenants. Reads with the service key, so access is locked hard:
 *
 *   Gate: the authenticated user's email must be in ADMIN_EMAILS (comma list).
 *         If ADMIN_EMAILS is unset, EVERYONE is denied (fail closed).
 *
 * This endpoint exposes every tenant's business data — never loosen the gate.
 */
import { getUserFromToken, bearer } from './lib/auth.js';
import { db } from './lib/db.js';

const PLAN_PRICE = { starter: 99, solo: 99, pro: 399, medspa: 599, enterprise: 0 };

function isAdmin(user){
  const list = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if(!list.length) return false;                         // fail closed
  return list.includes(String(user?.email || '').toLowerCase());
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  if(req.method === 'OPTIONS') return res.status(200).end();

  try{
    const user = await getUserFromToken(bearer(req));
    if(!user) return res.status(401).json({ error:'not authenticated' });
    if(!isAdmin(user)) return res.status(403).json({ error:'not authorized (admin only)' });

    const c = db();
    if(!c) return res.status(503).json({ error:'database not configured' });

    const since = new Date(Date.now() - 30*86400000).toISOString();

    const [tenantsR, callsR, bookingsR, usageR] = await Promise.all([
      c.from('tenants').select('id,slug,name,owner_name,owner_email,phone_number,plan,billing_status,stripe_customer_id,trial_ends_at,created_at').order('created_at',{ ascending:false }).limit(2000),
      c.from('calls').select('tenant_id,outcome,created_at').gte('created_at', since).limit(50000),
      c.from('bookings').select('tenant_id,price,status,starts_at').gte('starts_at', since).limit(50000),
      c.from('usage_events').select('tenant_id,kind,units,created_at').gte('created_at', since).limit(100000)
    ]);

    const tenants = tenantsR.data || [];
    const calls = callsR.data || [];
    const bookings = bookingsR.data || [];
    const usage = usageR.data || [];

    // per-tenant rollups
    const byTenant = {};
    const bucket = id => (byTenant[id] = byTenant[id] || { calls:0, booked:0, bookings:0, revenue:0, sms:0 });
    for(const x of calls){ const b=bucket(x.tenant_id); b.calls++; if(x.outcome==='booked') b.booked++; }
    for(const x of bookings){ const b=bucket(x.tenant_id); b.bookings++; b.revenue += Number(x.price||0); }
    for(const x of usage){ const k=String(x.kind||''); if(k.includes('sms')||k.includes('whatsapp')){ bucket(x.tenant_id).sms += Number(x.units||1); } }

    const now = Date.now();
    const customers = tenants.map(t => {
      const b = byTenant[t.id] || { calls:0, booked:0, bookings:0, revenue:0, sms:0 };
      const status = t.billing_status || (t.trial_ends_at && new Date(t.trial_ends_at) > now ? 'trial' : 'trial');
      return {
        id:t.id, name:t.name, slug:t.slug, owner:t.owner_name||'', email:t.owner_email||'',
        phone:t.phone_number||'', plan:t.plan||'starter', status,
        createdAt:t.created_at, trialEndsAt:t.trial_ends_at||null,
        calls30:b.calls, sms30:b.sms, bookings30:b.bookings, revenue30:Math.round(b.revenue)
      };
    });

    // membership / billing
    const planCounts = {}, statusCounts = {};
    let mrr = 0;
    for(const cu of customers){
      planCounts[cu.plan] = (planCounts[cu.plan]||0) + 1;
      statusCounts[cu.status] = (statusCounts[cu.status]||0) + 1;
      if(cu.status === 'active') mrr += (PLAN_PRICE[cu.plan] || 0);
    }
    const trialsEndingSoon = customers.filter(cu =>
      cu.status === 'trial' && cu.trialEndsAt && new Date(cu.trialEndsAt) - now < 5*86400000 && new Date(cu.trialEndsAt) - now > 0
    ).length;

    // app-wide service analytics (last 30d)
    const smsTotal = customers.reduce((s,c)=>s+c.sms30,0);
    const qualityRows = usage.filter(u => u.kind === 'interaction_quality');
    const qualityAvg = qualityRows.length ? Math.round(qualityRows.reduce((s,u)=>s+Number(u.units||0),0)/qualityRows.length) : null;

    const analytics = {
      calls30: calls.length,
      booked30: calls.filter(x=>x.outcome==='booked').length,
      sms30: smsTotal,
      bookings30: bookings.length,
      revenue30: Math.round(bookings.reduce((s,x)=>s+Number(x.price||0),0)),
      qualityAvg,
      topTenants: [...customers].sort((a,b)=>(b.calls30+b.sms30)-(a.calls30+a.sms30)).slice(0,5)
        .map(c=>({ name:c.name, activity:c.calls30+c.sms30, calls30:c.calls30, sms30:c.sms30 }))
    };

    return res.status(200).json({
      generatedAt: new Date().toISOString(),
      totals: { customers: customers.length, mrr, mrrMoney: '$'+mrr.toLocaleString() },
      membership: { planCounts, statusCounts, trialsEndingSoon },
      analytics,
      customers
    });
  }catch(e){
    return res.status(500).json({ error:String(e&&e.message||e) });
  }
}

