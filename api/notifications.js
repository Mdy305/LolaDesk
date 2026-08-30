/**
 * /api/notifications — authenticated tenant activity feed.
 * Returns only the current user's tenant activity. Never emits demo business records.
 */
import { db } from './lib/db.js';
import { getUserFromToken, bearer } from './lib/auth.js';
import { resolveTenantForUser } from './lib/tenant-access.js';

function timeAgo(ts){
  if(!ts) return '';
  const s=Math.floor((Date.now()-new Date(ts).getTime())/1000);
  if(s<60)return 'just now'; if(s<3600)return Math.floor(s/60)+'m ago';
  if(s<86400)return Math.floor(s/3600)+'h ago'; return Math.floor(s/86400)+'d ago';
}
function empty(tenant='Your business',extra={}){return {tenant,counts:{bookings:0,leads:0,calls:0},events:[],insights:[],...extra};}

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  if(req.method==='OPTIONS') return res.status(200).end();
  try{
    const user=await getUserFromToken(bearer(req));
    if(!user) return res.status(401).json({error:'Not authenticated'});
    const tenant=await resolveTenantForUser(user);
    if(!tenant?.id) return res.status(403).json({error:'No tenant mapped to this account'});
    const c=db();
    if(!c) return res.status(200).json(empty(tenant.name||'Your business',{dataUnavailable:true}));
    const tid=tenant.id, since=new Date(Date.now()-24*3600*1000).toISOString();
    const [bookings,calls,leads,convos]=await Promise.all([
      c.from('bookings').select('*').eq('tenant_id',tid).gte('created_at',since).order('created_at',{ascending:false}).limit(10),
      c.from('calls').select('*').eq('tenant_id',tid).gte('created_at',since).order('created_at',{ascending:false}).limit(10),
      c.from('usage_events').select('*').eq('tenant_id',tid).eq('kind','lead').gte('created_at',since).order('created_at',{ascending:false}).limit(10),
      c.from('conversations').select('*').eq('tenant_id',tid).gte('started_at',since).order('started_at',{ascending:false}).limit(10)
    ]);
    const failed=[bookings,calls,leads,convos].some(r=>r?.error);
    if(failed){
      console.error('[notifications] tenant query failed',bookings?.error||calls?.error||leads?.error||convos?.error);
      return res.status(200).json(empty(tenant.name||'Your business',{dataUnavailable:true}));
    }
    const bRows=bookings.data||[], cRows=calls.data||[], lRows=leads.data||[], convRows=convos.data||[];
    const events=[];
    for(const b of bRows)events.push({type:'booking',icon:'calendar',title:`New booking — ${b.service||'appointment'}`,when:timeAgo(b.created_at),ts:b.created_at});
    for(const l of lRows)events.push({type:'lead',icon:'user',title:'New lead captured',when:timeAgo(l.created_at),ts:l.created_at});
    for(const call of cRows)events.push({type:'call',icon:'phone',title:`Call ${call.outcome||'handled'}`,when:timeAgo(call.created_at),ts:call.created_at});
    for(const convo of convRows)events.push({type:'message',icon:'message',title:`New ${convo.channel||'client'} conversation`,when:timeAgo(convo.started_at||convo.created_at),ts:convo.started_at||convo.created_at});
    events.sort((a,b)=>new Date(b.ts)-new Date(a.ts));
    return res.status(200).json({tenant:tenant.name||'Your business',counts:{bookings:bRows.length,leads:lRows.length,calls:cRows.length},events:events.slice(0,10),insights:deriveInsights(bRows)});
  }catch(e){
    console.error('[notifications] unavailable',e);
    return res.status(200).json(empty('Your business',{dataUnavailable:true}));
  }
}

function deriveInsights(bookings){
  const insights=[],byTime={};
  for(const b of bookings){
    if(!b.starts_at)continue;
    const key=new Date(b.starts_at).toISOString().slice(0,16);
    byTime[key]=(byTime[key]||0)+1;
    if(byTime[key]===2){const d=new Date(b.starts_at);insights.push({level:'warn',text:`Possible double-booking around ${d.toLocaleString('en-US',{weekday:'short',hour:'numeric',minute:'2-digit'})}.`});}
  }
  if(bookings.length===0)insights.push({level:'info',text:'No new bookings in the last 24 hours. Lola can help prepare a win-back campaign.'});
  return insights;
}
