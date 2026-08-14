import { bearer, getUserFromToken } from './lib/auth.js';
import { resolveTenantForUser } from './lib/tenant-access.js';
import { cancelCanonicalBooking, createCanonicalBooking, listBookings, listServices, listStaff, updateBookingTime } from './lib/booking-store.js';

function dayBounds(value){
  const d=new Date(value||Date.now());
  if(Number.isNaN(d.getTime())) return null;
  d.setHours(0,0,0,0);
  return {from:d.toISOString(),to:new Date(d.getTime()+86400000).toISOString()};
}
function overlaps(aStart,aEnd,bStart,bEnd){ return new Date(aStart)<new Date(bEnd)&&new Date(bStart)<new Date(aEnd); }

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  if(req.method==='OPTIONS') return res.status(200).end();
  try{
    const user=await getUserFromToken(bearer(req));
    if(!user) return res.status(401).json({error:'not authenticated'});
    const tenant=await resolveTenantForUser(user);
    if(!tenant?.id) return res.status(403).json({error:'no tenant mapped to this account'});
    const tid=tenant.id;

    if(req.method==='GET'){
      const q=Object.fromEntries(new URL(req.url,'http://x').searchParams);
      const action=q.action||'day';
      if(action==='day'){
        const range=dayBounds(q.date);
        if(!range) return res.status(400).json({error:'invalid date'});
        const [bookings,staff,services]=await Promise.all([listBookings(tid,range),listStaff(tid),listServices(tid)]);
        return res.status(200).json({ok:true,tenant:{id:tid,name:tenant.name,hours:tenant.hours},bookings,staff,services});
      }
      if(action==='availability'){
        const range=dayBounds(q.date);
        if(!range) return res.status(400).json({error:'invalid date'});
        const bookings=await listBookings(tid,range);
        const staff=await listStaff(tid);
        const duration=Math.max(15,Number(q.duration_min||60));
        const staffId=q.staff_id||null;
        const slots=[];
        const base=new Date(range.from);
        const startHour=12,endHour=20;
        for(let h=startHour*60;h+duration<=endHour*60;h+=30){
          const start=new Date(base.getTime()+h*60000),end=new Date(start.getTime()+duration*60000);
          const conflict=bookings.some(b=>b.status!=='cancelled'&&(!staffId||b.staffId===staffId)&&overlaps(start,end,b.startsAt,b.endsAt));
          if(!conflict) slots.push(start.toISOString());
          if(slots.length>=12) break;
        }
        return res.status(200).json({ok:true,slots,staff});
      }
      return res.status(400).json({error:'unknown action'});
    }

    const body=typeof req.body==='string'?JSON.parse(req.body||'{}'):(req.body||{});
    const action=body.action||'book';
    if(action==='book'){
      if(!body.starts_at) return res.status(400).json({ok:false,error:'starts_at required'});
      const duration=Math.max(15,Number(body.duration_min||60));
      const start=new Date(body.starts_at),end=new Date(start.getTime()+duration*60000);
      const range=dayBounds(start);
      const existing=await listBookings(tid,range);
      const conflict=existing.find(b=>b.status!=='cancelled'&&(!body.staff_id||b.staffId===body.staff_id)&&overlaps(start,end,b.startsAt,b.endsAt));
      if(conflict) return res.status(409).json({ok:false,conflict:true,error:'time conflict',conflictBookingId:conflict.id});
      const booking=await createCanonicalBooking(tid,{clientId:body.client_id,clientName:body.client_name,clientPhone:body.client_phone,clientEmail:body.client_email,serviceId:body.service_id,service:body.service,staffId:body.staff_id,stylist:body.stylist,startsAt:body.starts_at,durationMin:duration,price:body.price,notes:body.notes,source:body.source||'dashboard',conversationId:body.conversation_id});
      return res.status(200).json({ok:true,booking});
    }
    if(action==='reschedule'){
      if(!body.booking_id||!body.starts_at) return res.status(400).json({ok:false,error:'booking_id and starts_at required'});
      const booking=await updateBookingTime(tid,body.booking_id,body.starts_at);
      return res.status(200).json({ok:true,booking});
    }
    if(action==='cancel'){
      if(!body.booking_id) return res.status(400).json({ok:false,error:'booking_id required'});
      const booking=await cancelCanonicalBooking(tid,body.booking_id);
      return res.status(200).json({ok:true,booking});
    }
    return res.status(400).json({error:'unknown action'});
  }catch(e){
    console.error('/api/calendar-manager',e);
    return res.status(500).json({ok:false,error:String(e?.message||e)});
  }
}
