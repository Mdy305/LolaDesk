import { bearer, getUserFromToken } from './lib/auth.js';
import { db, logUsage } from './lib/db.js';
import { resolveTenantAccessForUser } from './lib/tenant-access.js';

const DAY=86400000;
const text=v=>String(v||'').trim();
const priorityRank={critical:0,high:1,medium:2,low:3};

function bodyOf(req){
  if(!req.body)return {};
  if(typeof req.body==='string'){try{return JSON.parse(req.body||'{}');}catch{return {};}}
  return req.body;
}
function actionId(type,id){return `${type}:${text(id).replace(/[^a-zA-Z0-9_-]/g,'').slice(0,80)}`;}
function isMissed(call){return /missed|no.?answer|voicemail|failed|abandon/i.test(text(call.outcome||call.status));}
function isUnconfirmed(booking){return /pending|requested|unconfirmed|hold/i.test(text(booking.status));}

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  if(req.method==='OPTIONS')return res.status(204).end();
  if(!['GET','POST'].includes(req.method))return res.status(405).json({error:'Method not allowed'});
  try{
    const user=await getUserFromToken(bearer(req));
    if(!user)return res.status(401).json({error:'Not authenticated'});
    const access=await resolveTenantAccessForUser(user),tenant=access?.tenant;
    if(!tenant?.id)return res.status(403).json({error:'No tenant mapped'});
    const c=db();
    if(!c)return res.status(200).json({tenant:tenant.name||'Your business',items:[],counts:{open:0,critical:0,high:0},dataUnavailable:true});

    if(req.method==='POST'){
      const body=bodyOf(req),id=text(body.action_id),status=text(body.status||'resolved').toLowerCase();
      if(!id||!['resolved','snoozed','opened'].includes(status))return res.status(400).json({error:'Valid action_id and status are required'});
      await logUsage(tenant.id,'action_state',1,{action_id:id,status,note:text(body.note).slice(0,300),actor_user_id:user.id,actor_role:access.role||'staff',snooze_until:body.snooze_until||null});
      return res.status(200).json({ok:true,action_id:id,status});
    }

    const now=Date.now(),since48=new Date(now-2*DAY).toISOString(),todayStart=new Date();
    todayStart.setHours(0,0,0,0); const todayEnd=new Date(todayStart.getTime()+DAY);
    const [callsQ,bookingsQ,usageQ]=await Promise.all([
      c.from('calls').select('*').eq('tenant_id',tenant.id).gte('created_at',since48).order('created_at',{ascending:false}).limit(100),
      c.from('bookings').select('id,tenant_id,client_id,service_id,staff_id,start_time,end_time,status,total_amount,created_at,updated_at,location_id,source,conversation_id,external_id,external_provider,hold_id,deposit_status,confirmation_code,starts_at:start_time,service:services(name)').eq('tenant_id',tenant.id).gte('start_time',todayStart.toISOString()).lt('start_time',todayEnd.toISOString()).order('start_time',{ascending:true}).limit(150),
      c.from('usage_events').select('kind,metadata,created_at').eq('tenant_id',tenant.id).gte('created_at',new Date(now-30*DAY).toISOString()).order('created_at',{ascending:false}).limit(1500)
    ]);
    if(callsQ.error||bookingsQ.error||usageQ.error)throw callsQ.error||bookingsQ.error||usageQ.error;
    const calls=callsQ.data||[],bookings=(bookingsQ.data||[]).map(b=>({...b,service:b.service?.name||null})),usage=usageQ.data||[];
    const state=new Map();
    for(const e of usage.filter(x=>x.kind==='action_state')){const id=e.metadata?.action_id;if(id&&!state.has(id))state.set(id,{...e.metadata,at:e.created_at});}
    const items=[];

    for(const call of calls.filter(isMissed)){
      const id=actionId('call',call.id||call.call_control_id||call.created_at),phone=call.from_number||call.from||call.caller_phone||'';
      items.push({id,type:'missed_call',priority:'critical',title:'Return missed call',detail:phone?`A client called from ${phone} and did not reach the desk.`:'A client call needs follow-up.',created_at:call.created_at,href:'calls.html',cta:'Open calls'});
    }
    for(const booking of bookings.filter(isUnconfirmed)){
      const id=actionId('booking',booking.id||booking.starts_at);
      const when=new Date(booking.starts_at).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});
      items.push({id,type:'booking',priority:'high',title:'Confirm today’s appointment',detail:`${booking.client_name||'Client'} · ${booking.service||'Appointment'} at ${when}`,created_at:booking.created_at||booking.starts_at,href:'bookings.html',cta:'Review booking'});
    }
    const draftEvents=usage.filter(x=>x.kind==='campaign_draft');
    const sentIds=new Set(usage.filter(x=>x.kind==='campaign_sent').map(x=>x.metadata?.draft_id).filter(Boolean));
    for(const e of draftEvents){
      const draftId=e.metadata?.draft_id;if(!draftId||sentIds.has(draftId))continue;
      items.push({id:actionId('campaign',draftId),type:'campaign',priority:'high',title:'Campaign waiting for approval',detail:`${e.metadata?.campaign||'Marketing'} draft · ${Number(e.metadata?.target_count||0)} recipients`,created_at:e.created_at,href:'marketing.html',cta:'Review draft'});
    }
    const failedCampaigns=usage.filter(x=>x.kind==='campaign_send'&&Number(x.metadata?.failed||0)>0).slice(0,5);
    for(const e of failedCampaigns){
      items.push({id:actionId('delivery',e.metadata?.draft_id||e.created_at),type:'delivery',priority:'medium',title:'Review campaign delivery failures',detail:`${Number(e.metadata?.failed||0)} messages failed and may need retry or correction.`,created_at:e.created_at,href:'marketing.html',cta:'Review delivery'});
    }

    const open=items.filter(item=>{
      const s=state.get(item.id);if(!s)return true;
      if(s.status==='resolved')return false;
      if(s.status==='snoozed'&&s.snooze_until&&new Date(s.snooze_until).getTime()>now)return false;
      return true;
    }).map(item=>({...item,state:state.get(item.id)?.status||'open'}));
    open.sort((a,b)=>(priorityRank[a.priority]??9)-(priorityRank[b.priority]??9)||new Date(a.created_at)-new Date(b.created_at));
    return res.status(200).json({tenant:tenant.name||'Your business,',generated_at:new Date().toISOString(),items:open.slice(0,20),counts:{open:open.length,critical:open.filter(x=>x.priority==='critical').length,high:open.filter(x=>x.priority==='high').length}});
  }catch(error){
    console.error('[action-center]',error);
    return res.status(200).json({tenant:'Your business',items:[],counts:{open:0,critical:0,high:0},dataUnavailable:true});
  }
}
