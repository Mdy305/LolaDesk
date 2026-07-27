import { bearer, getUserFromToken } from './lib/auth.js';
import { db, logUsage } from './lib/db.js';
import { resolveTenantForUser } from './lib/tenant-access.js';

const ACTIVE_BOOKING = new Set(['pending','confirmed','scheduled']);
const FAILED_CALL = new Set(['missed','failed','error','no_answer','voicemail']);
const ACTIONS = new Set(['acknowledge','escalate','recover','request_review','rebook','dismiss']);

function parseBody(req){
  if(typeof req.body === 'string') return JSON.parse(req.body || '{}');
  return req.body || {};
}
function safeText(value, max=240){ return String(value || '').trim().slice(0,max); }
function hoursAgo(value){ return value ? Math.max(0, Math.round((Date.now()-new Date(value).getTime())/3600000)) : null; }

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
    const c=db();
    if(!c) return res.status(503).json({error:'database not configured'});

    if(req.method==='POST'){
      const body=parseBody(req);
      const action=safeText(body.action,40).toLowerCase();
      const itemType=safeText(body.item_type,40);
      const itemId=safeText(body.item_id,100);
      if(!ACTIONS.has(action)) return res.status(400).json({error:'unsupported action'});
      if(!itemType || !itemId) return res.status(400).json({error:'item_type and item_id are required'});
      const metadata={item_type:itemType,item_id:itemId,note:safeText(body.note,500),actor_user_id:user.id,source:'operations_os'};
      await logUsage(tenant.id,`operations_${action}`,1,metadata);
      return res.status(200).json({ok:true,action,item:{type:itemType,id:itemId},recorded_at:new Date().toISOString()});
    }

    const since7d=new Date(Date.now()-7*86400000).toISOString();
    const since30d=new Date(Date.now()-30*86400000).toISOString();
    const next7d=new Date(Date.now()+7*86400000).toISOString();
    const [callsR,bookingsR,clientsR,usageR]=await Promise.all([
      c.from('calls').select('id,client_id,from_number,outcome,direction,duration_sec,created_at').eq('tenant_id',tenant.id).gte('created_at',since7d).order('created_at',{ascending:false}).limit(200),
      c.from('bookings').select('id,client_id,service,starts_at,status,price,created_at').eq('tenant_id',tenant.id).gte('starts_at',since30d).lte('starts_at',next7d).order('starts_at',{ascending:true}).limit(300),
      c.from('clients').select('id,first_name,last_name,phone,last_visit,status').eq('tenant_id',tenant.id).order('last_visit',{ascending:false}).limit(500),
      c.from('usage_events').select('kind,metadata,created_at').eq('tenant_id',tenant.id).like('kind','operations_%').gte('created_at',since30d).order('created_at',{ascending:false}).limit(500)
    ]);
    for(const r of [callsR,bookingsR,clientsR,usageR]) if(r.error) throw new Error(r.error.message);
    const calls=callsR.data||[], bookings=bookingsR.data||[], clients=(clientsR.data||[]).map(x=>({...x,name:[x.first_name,x.last_name].filter(Boolean).join(' ')||'Client',phone_number:x.phone||'',updated_at:x.last_visit||null})), events=usageR.data||[];
    const clientById=new Map(clients.map(x=>[x.id,x]));
    const handled=new Set(events.filter(e=>['operations_acknowledge','operations_dismiss'].includes(e.kind)).map(e=>`${e.metadata?.item_type}:${e.metadata?.item_id}`));
    const tasks=[];

    for(const call of calls){
      if(!FAILED_CALL.has(String(call.outcome||'').toLowerCase())) continue;
      const key=`missed_call:${call.id}`; if(handled.has(key)) continue;
      const client=clientById.get(call.client_id);
      tasks.push({id:call.id,type:'missed_call',priority:hoursAgo(call.created_at)<=2?'urgent':'high',title:'Recover missed caller',detail:client?.name||call.from_number||'Unknown caller',client,created_at:call.created_at,recommended_action:'recover',value_at_risk:null});
    }
    for(const booking of bookings){
      const status=String(booking.status||'pending').toLowerCase();
      const starts=new Date(booking.starts_at).getTime();
      const client=clientById.get(booking.client_id);
      if(starts>Date.now() && starts<Date.now()+48*3600000 && status==='pending'){
        const key=`unconfirmed_booking:${booking.id}`; if(!handled.has(key)) tasks.push({id:booking.id,type:'unconfirmed_booking',priority:'high',title:'Confirm upcoming appointment',detail:`${booking.service||'Appointment'} · ${new Date(booking.starts_at).toLocaleString('en-US')}`,client,created_at:booking.created_at,recommended_action:'recover',value_at_risk:Number(booking.price)||null});
      }
      if(starts<Date.now() && ['no_show','cancelled'].includes(status)){
        const key=`lost_booking:${booking.id}`; if(!handled.has(key)) tasks.push({id:booking.id,type:'lost_booking',priority:'medium',title:status==='no_show'?'Recover no-show':'Recover cancellation',detail:booking.service||'Appointment',client,created_at:booking.starts_at,recommended_action:'rebook',value_at_risk:Number(booking.price)||null});
      }
      if(starts<Date.now()-24*3600000 && status==='completed'){
        const key=`review_request:${booking.id}`; if(!handled.has(key)) tasks.push({id:booking.id,type:'review_request',priority:'low',title:'Request review and rebooking',detail:booking.service||'Completed visit',client,created_at:booking.starts_at,recommended_action:'request_review',value_at_risk:null});
      }
    }
    const priorityRank={urgent:0,high:1,medium:2,low:3};
    tasks.sort((a,b)=>priorityRank[a.priority]-priorityRank[b.priority] || new Date(b.created_at)-new Date(a.created_at));
    const recoverableRevenue=tasks.reduce((sum,t)=>sum+(t.value_at_risk||0),0);
    const metrics={open_tasks:tasks.length,urgent:tasks.filter(x=>x.priority==='urgent').length,missed_calls:tasks.filter(x=>x.type==='missed_call').length,rebooking_opportunities:tasks.filter(x=>x.type==='lost_booking').length,review_opportunities:tasks.filter(x=>x.type==='review_request').length,recoverable_revenue:recoverableRevenue,actions_30d:events.length};
    const readiness=Math.max(0,100-Math.min(45,metrics.urgent*15)-Math.min(30,metrics.open_tasks*2));
    return res.status(200).json({ok:true,tenant:{name:tenant.name,booking_url:tenant.booking_url},readiness,metrics,tasks:tasks.slice(0,100),recent_actions:events.slice(0,30),checked_at:new Date().toISOString()});
  }catch(error){ return res.status(500).json({error:String(error?.message||error)}); }
}
