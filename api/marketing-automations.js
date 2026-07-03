import { bearer, getUserFromToken } from './lib/auth.js';
import { db, logUsage } from './lib/db.js';
import { resolveTenantForUser } from './lib/tenant-access.js';

function daysSince(ts){
  if(!ts) return 9999;
  return Math.floor((Date.now() - new Date(ts).getTime()) / 86400000);
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  if(req.method === 'OPTIONS') return res.status(200).end();

  try{
    const user = await getUserFromToken(bearer(req));
    if(!user) return res.status(401).json({ error:'not authenticated' });
    const tenant = await resolveTenantForUser(user);
    if(!tenant?.id) return res.status(404).json({ error:'no tenant found for this account' });
    const c = db();
    if(!c) return res.status(503).json({ error:'database not configured' });

    const { data: clients=[] } = await c.from('clients').select('id,name,last_visit,is_vip,lifetime_value,phone_number').eq('tenant_id', tenant.id).limit(300);
    const since30 = new Date(Date.now() - 30 * 86400000).toISOString();
    const { data: usage=[] } = await c.from('usage_events').select('kind,units,metadata,created_at').eq('tenant_id', tenant.id).gte('created_at', since30).limit(1000);

    const winback = clients.filter(x => daysSince(x.last_visit) >= 60);
    const vip = clients.filter(x => !!x.is_vip || Number(x.lifetime_value || 0) >= 1200);
    const recent = clients.filter(x => daysSince(x.last_visit) <= 21);
    const booked = usage.filter(u => u.kind === 'booking').length;
    const campaignRuns = usage.filter(u => u.kind === 'campaign_run');
    const campaignRevenue = campaignRuns.reduce((s, u) => s + Number(u.metadata?.estimated_revenue || 0), 0);

    if(req.method === 'POST'){
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const campaign = body.campaign || 'winback';
      let target = [];
      let est = 0;
      if(campaign === 'vip-retention'){
        target = vip.slice(0, 40);
        est = target.length * 220;
      }else if(campaign === 'post-visit'){
        target = recent.slice(0, 60);
        est = target.length * 90;
      }else{
        target = winback.slice(0, 80);
        est = target.length * 160;
      }
      await logUsage(tenant.id, 'campaign_run', target.length, {
        campaign,
        estimated_revenue: est,
        target_count: target.length
      });
      return res.status(200).json({
        ok: true,
        campaign,
        targeted: target.length,
        estimated_revenue: est,
        speak: `Done. I launched the ${campaign} campaign to ${target.length} contacts. Estimated upside is $${est.toLocaleString()}.`
      });
    }

    return res.status(200).json({
      tenant: tenant.name,
      segments: [
        { id:'winback', name:'Win-back', count:winback.length, desc:'No visit in 60+ days' },
        { id:'vip-retention', name:'VIP Retention', count:vip.length, desc:'High-value recurring clients' },
        { id:'post-visit', name:'Post-visit Follow-up', count:recent.length, desc:'Visited in last 21 days' }
      ],
      kpis: {
        bookings_30d: booked,
        campaign_runs_30d: campaignRuns.length,
        campaign_revenue_estimate_30d: campaignRevenue
      },
      recommendations: [
        { campaign:'winback', why:`${winback.length} clients are lapsed and ready for reactivation.` },
        { campaign:'vip-retention', why:`${vip.length} VIP clients can drive premium repeat revenue.` },
        { campaign:'post-visit', why:`${recent.length} recent visits can be converted to add-ons and rebooks.` }
      ]
    });
  }catch(e){
    return res.status(500).json({ error:String(e && e.message || e) });
  }
}

