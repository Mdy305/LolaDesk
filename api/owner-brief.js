import { bearer, getUserFromToken } from './lib/auth.js';
import { db } from './lib/db.js';
import { resolveTenantForUser } from './lib/tenant-access.js';

function money(value){ return Math.round((Number(value)||0)*100)/100; }

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');
  if(req.method==='OPTIONS') return res.status(200).end();
  if(req.method!=='GET') return res.status(405).json({error:'GET only'});
  try{
    const user=await getUserFromToken(bearer(req));
    if(!user) return res.status(401).json({error:'not authenticated'});
    const tenant=await resolveTenantForUser(user);
    if(!tenant) return res.status(404).json({error:'tenant not found'});
    const c=db(); if(!c) return res.status(503).json({error:'database not configured'});
    const startToday=new Date(); startToday.setHours(0,0,0,0);
    const endToday=new Date(startToday.getTime()+86400000);
    const start30=new Date(Date.now()-30*86400000).toISOString();
    const [todayR,monthR,callsR,msgsR]=await Promise.all([
      c.from('bookings').select('id,status,starts_at:start_time,price:total_amount,service:services(name),stylist:staff(name)').eq('tenant_id',tenant.id).gte('start_time',startToday.toISOString()).lt('start_time',endToday.toISOString()).order('start_time',{ascending:true}),
      c.from('bookings').select('id,status,price:total_amount,starts_at:start_time').eq('tenant_id',tenant.id).gte('start_time',start30),
      c.from('calls').select('id,status,duration_seconds,created_at').eq('tenant_id',tenant.id).gte('created_at',start30),
      c.from('messages').select('id,role,created_at').eq('tenant_id',tenant.id).gte('created_at',start30)
    ]);
    for(const r of [todayR,monthR,callsR,msgsR]) if(r.error) throw new Error(r.error.message);
    const today=(todayR.data||[]).map(b=>({...b,service:b.service?.name||null,stylist:b.stylist?.name||null})), month=monthR.data||[];
    const calls=(callsR.data||[]).map(c=>({...c,outcome:c.status||null,duration_sec:c.duration_seconds||null})), messages=msgsR.data||[];
    const completed=month.filter(x=>String(x.status).toLowerCase()==='completed');
    const active=month.filter(x=>['pending','confirmed','scheduled','completed'].includes(String(x.status||'').toLowerCase()));
    const cancelled=month.filter(x=>['cancelled','no_show'].includes(String(x.status||'').toLowerCase()));
    const revenue=completed.reduce((s,x)=>s+(Number(x.price)||0),0);
    const bookedValue=active.reduce((s,x)=>s+(Number(x.price)||0),0);
    const missedCalls=calls.filter(x=>['missed','failed','error','no_answer','voicemail'].includes(String(x.outcome||'').toLowerCase())).length;
    const answerRate=calls.length?Math.round(((calls.length-missedCalls)/calls.length)*100):null;
    const priorities=[];
    if(today.some(x=>String(x.status||'pending').toLowerCase()==='pending')) priorities.push('Confirm today’s pending appointments before the service window.');
    if(missedCalls) priorities.push(`Recover ${missedCalls} missed or failed call${missedCalls===1?'':'s'} from the last 30 days.`);
    if(cancelled.length) priorities.push(`Rebook ${cancelled.length} cancelled or no-show appointment${cancelled.length===1?'':'s'}.`);
    if(!priorities.length) priorities.push('Operations are clear. Focus Lola on proactive rebooking and VIP retention.');
    return res.status(200).json({ok:true,business:tenant.name,period:'30d',today:{appointments:today.length,scheduled_value:money(today.reduce((s,x)=>s+(Number(x.price)||0),0)),schedule:today},performance:{completed_bookings:completed.length,booked_value:money(bookedValue),recognized_revenue:money(revenue),cancelled_or_no_show:cancelled.length,calls:calls.length,answer_rate:answerRate,messages:messages.length},priorities,generated_at:new Date().toISOString()});
  }catch(error){ return res.status(500).json({error:String(error?.message||error)}); }
}
