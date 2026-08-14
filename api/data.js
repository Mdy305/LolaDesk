import { db } from './lib/db.js';
import { bearer, getUserFromToken } from './lib/auth.js';
import { resolveTenantForUser } from './lib/tenant-access.js';
import { listBookings, listServices, listStaff } from './lib/booking-store.js';

function ago(ts){
  if(!ts) return '';
  const s=Math.max(0,Math.floor((Date.now()-new Date(ts).getTime())/1000));
  if(s<60) return 'just now'; if(s<3600) return Math.floor(s/60)+'m ago'; if(s<86400) return Math.floor(s/3600)+'h ago'; return Math.floor(s/86400)+'d ago';
}
function money(n){ return '$'+Number(n||0).toLocaleString('en-US',{maximumFractionDigits:0}); }

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  if(req.method==='OPTIONS') return res.status(200).end();
  try{
    const c=db();
    if(!c) return res.status(503).json({error:'database not configured'});
    const user=await getUserFromToken(bearer(req));
    if(!user) return res.status(401).json({error:'not authenticated'});
    const tenant=await resolveTenantForUser(user);
    if(!tenant?.id) return res.status(403).json({error:'no tenant mapped to this account'});
    const resource=new URL(req.url,'http://x').searchParams.get('resource')||'overview';
    const tid=tenant.id;

    if(resource==='clients'){
      const {data=[],error}=await c.from('clients').select('*').eq('tenant_id',tid).order('updated_at',{ascending:false}).limit(300);
      if(error) throw error;
      return res.status(200).json({tenant:tenant.name,clients:data.map(x=>({id:x.id,name:[x.first_name,x.last_name].filter(Boolean).join(' ')||'Client',phone:x.phone||'',email:x.email||'',photo:x.profile_picture_url||null,vip:String(x.status||'').toLowerCase()==='vip',lastService:x.preferred_service||'',lastVisit:x.last_visit||'',ltv:Number(x.lifetime_value||0),notes:x.notes||'',tags:[]}))});
    }

    if(resource==='bookings'){
      const bookings=await listBookings(tid);
      return res.status(200).json({tenant:tenant.name,bookings});
    }

    if(resource==='team'){
      const staff=await listStaff(tid);
      const fallback=Array.isArray(tenant.team)?tenant.team:[];
      const team=staff.length?staff.map(s=>({id:s.id,name:s.name,role:s.role||'Stylist',active:s.is_active!==false})):fallback.map(x=>({name:x.name,role:x.role||'Stylist',active:true}));
      return res.status(200).json({tenant:tenant.name,team});
    }

    if(resource==='services'){
      const services=await listServices(tid);
      const fallback=Array.isArray(tenant.services)?tenant.services:[];
      return res.status(200).json({tenant:tenant.name,services:services.length?services.map(s=>({id:s.id,name:s.name,durationMin:Number(s.duration_minutes||60),price:Number(s.price||0),description:s.description||'',active:s.is_active!==false})):fallback.map(s=>({name:s.name,durationMin:Number(s.duration_minutes||60),price:Number(s.price||0),active:true}))});
    }

    if(resource==='calls'){
      const {data=[],error}=await c.from('calls').select('*').eq('tenant_id',tid).order('created_at',{ascending:false}).limit(100);
      if(error) throw error;
      return res.status(200).json({tenant:tenant.name,calls:data.map(x=>({id:x.id,from:x.from_number||'',when:ago(x.created_at),outcome:x.status||'handled',durationSec:Number(x.duration_seconds||0),summary:'',booked:String(x.status||'').toLowerCase()==='booked'}))});
    }

    if(resource==='inbox'){
      const {data=[],error}=await c.from('conversations').select('id,client_name,client_phone,channel,status,content,created_at,updated_at').eq('tenant_id',tid).order('updated_at',{ascending:false}).limit(80);
      if(error) throw error;
      return res.status(200).json({tenant:tenant.name,threads:data.map(x=>({id:x.id,channel:x.channel||'sms',who:x.client_name||x.client_phone||'Client',when:ago(x.updated_at||x.created_at),preview:x.content||'',unread:String(x.status||'').toLowerCase()==='new'}))});
    }

    if(resource==='revenue'){
      const bookings=await listBookings(tid,{limit:1000});
      const live=bookings.filter(b=>b.status!=='cancelled');
      const total=live.reduce((s,b)=>s+Number(b.price||0),0);
      const byMonth={},byService={};
      live.forEach(b=>{ const m=String(b.startsAt||'').slice(0,7); if(m) byMonth[m]=(byMonth[m]||0)+Number(b.price||0); byService[b.service||'Other']=(byService[b.service||'Other']||0)+Number(b.price||0); });
      return res.status(200).json({tenant:tenant.name,total,money:money(total),months:Object.entries(byMonth).sort().map(([month,value])=>({month,value})),services:Object.entries(byService).sort((a,b)=>b[1]-a[1]).map(([name,value])=>({name,value})),bookingCount:live.length});
    }

    if(resource==='overview'){
      const since=new Date(Date.now()-30*86400000).toISOString();
      const [{count:clientsCount=0},{count:callsCount=0},bookings]=await Promise.all([
        c.from('clients').select('id',{count:'exact',head:true}).eq('tenant_id',tid),
        c.from('calls').select('id',{count:'exact',head:true}).eq('tenant_id',tid).gte('created_at',since),
        listBookings(tid,{from:since,limit:1000})
      ]);
      const active=bookings.filter(b=>b.status!=='cancelled');
      const revenue=active.reduce((s,b)=>s+Number(b.price||0),0);
      return res.status(200).json({tenant:tenant.name,kpis:{clients:clientsCount||0,calls30:callsCount||0,bookings30:active.length,revenue30:revenue,revenue30Money:money(revenue),upsellRevenue:0,upsellRate:'0%'}});
    }

    return res.status(400).json({error:'unknown resource'});
  }catch(e){
    console.error('/api/data',e);
    return res.status(500).json({error:String(e?.message||e)});
  }
}
