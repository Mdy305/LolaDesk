import { bearer, getUserFromToken } from './lib/auth.js';
import { db, logUsage } from './lib/db.js';
import { resolveTenantForUser } from './lib/tenant-access.js';

const ACTIONS = new Set(['approve_campaign','mark_contacted','dismiss','pause_segment']);
const DAY = 86400000;
const money = n => Math.round((Number(n)||0)*100)/100;
const parseBody = req => typeof req.body === 'string' ? JSON.parse(req.body||'{}') : (req.body||{});

function buildSegments(clients, bookings){
  const now = Date.now();
  const byClient = new Map();
  for(const b of bookings){
    if(!b.client_id) continue;
    const arr = byClient.get(b.client_id)||[]; arr.push(b); byClient.set(b.client_id,arr);
  }
  const segments = { dormant:[], cancelled:[], vip:[], leads:[], retention_due:[] };
  for(const c of clients){
    if(c.opted_out) continue;
    const rows = byClient.get(c.id)||[];
    const completed = rows.filter(b=>String(b.status).toLowerCase()==='completed');
    const future = rows.filter(b=>new Date(b.starts_at||0).getTime()>now && !['cancelled','no_show'].includes(String(b.status).toLowerCase()));
    const cancelled = rows.filter(b=>['cancelled','no_show'].includes(String(b.status).toLowerCase()));
    const spend = completed.reduce((s,b)=>s+(Number(b.price)||0),0);
    const last = completed.sort((a,b)=>new Date(b.starts_at||b.created_at)-new Date(a.starts_at||a.created_at))[0];
    const daysSince = last ? Math.floor((now-new Date(last.starts_at||last.created_at).getTime())/DAY) : null;
    const base = { client_id:c.id,name:c.name||'Client',phone:c.phone||null,email:c.email||null,lifetime_value:money(spend),last_visit_at:last?.starts_at||last?.created_at||null,days_since_visit:daysSince };
    if(!completed.length) segments.leads.push(base);
    if(daysSince!==null && daysSince>=60 && !future.length) segments.dormant.push(base);
    if(cancelled.length && !future.length) segments.cancelled.push({...base,last_cancelled_at:cancelled[0]?.starts_at||cancelled[0]?.created_at});
    if(spend>=1000 || completed.length>=6) segments.vip.push({...base,visits:completed.length});
    if(daysSince!==null && daysSince>=35 && daysSince<60 && !future.length) segments.retention_due.push(base);
  }
  return segments;
}

function campaigns(segments){
  const defs = [
    ['dormant','Win-back','We miss you. Let Lola offer a personalized return visit.',0.16],
    ['cancelled','Cancellation recovery','Recover cancelled and no-show demand with immediate rebooking.',0.28],
    ['vip','VIP concierge','Give top clients priority access and personal follow-up.',0.22],
    ['leads','Lead conversion','Turn inquiries without completed visits into first appointments.',0.12],
    ['retention_due','Rebooking','Reach clients before they lapse beyond their normal cycle.',0.24]
  ];
  return defs.map(([key,title,description,rate])=>{
    const audience=segments[key]||[];
    const value=audience.reduce((s,x)=>s+(x.lifetime_value||0),0);
    const avg=audience.length?value/audience.length:0;
    return {id:key,title,description,audience_size:audience.length,estimated_revenue:money(audience.length*avg*rate),approval_required:true,compliance_note:'Opted-out clients are excluded automatically.'};
  });
}

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');
  if(req.method==='OPTIONS') return res.status(200).end();
  if(!['GET','POST'].includes(req.method)) return res.status(405).json({error:'method not allowed'});
  try{
    const user=await getUserFromToken(bearer(req));
    if(!user) return res.status(401).json({error:'not authenticated'});
    const tenant=await resolveTenantForUser(user);
    if(!tenant) return res.status(404).json({error:'tenant not found'});
    const c=db(); if(!c) return res.status(503).json({error:'database not configured'});
    if(req.method==='POST'){
      const body=parseBody(req), action=String(body.action||'');
      if(!ACTIONS.has(action)) return res.status(400).json({error:'invalid action'});
      const segment=String(body.segment||'').slice(0,40), clientId=body.client_id?String(body.client_id).slice(0,80):null;
      await logUsage(tenant.id,'growth_action',1,{action,segment,client_id:clientId,actor:user.id||user.email||'owner',created_at:new Date().toISOString()});
      return res.status(200).json({ok:true,action,segment,client_id:clientId});
    }
    const since=new Date(Date.now()-365*DAY).toISOString();
    const [{data:clients,error:cErr},{data:bookings,error:bErr},{data:actions}]=await Promise.all([
      c.from('clients').select('id,name,email,phone,opted_out,created_at').eq('tenant_id',tenant.id).limit(1000),
      c.from('bookings').select('id,client_id,status,service,starts_at,created_at,price').eq('tenant_id',tenant.id).gte('created_at',since).limit(3000),
      c.from('usage_events').select('kind,metadata,created_at').eq('tenant_id',tenant.id).eq('kind','growth_action').order('created_at',{ascending:false}).limit(100)
    ]);
    if(cErr) throw new Error(cErr.message); if(bErr) throw new Error(bErr.message);
    const segments=buildSegments(clients||[],bookings||[]), campaignList=campaigns(segments);
    const totalOpportunity=campaignList.reduce((s,x)=>s+x.estimated_revenue,0);
    const optedOut=(clients||[]).filter(x=>x.opted_out).length;
    return res.status(200).json({ok:true,tenant:{name:tenant.name},summary:{active_clients:(clients||[]).length-optedOut,opted_out:optedOut,opportunity_count:Object.values(segments).reduce((s,x)=>s+x.length,0),estimated_recoverable_revenue:money(totalOpportunity)},segments,campaigns:campaignList,recent_actions:actions||[],generated_at:new Date().toISOString()});
  }catch(e){ return res.status(500).json({error:String(e?.message||e)}); }
}
