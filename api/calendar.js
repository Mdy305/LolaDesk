import { db, upsertClient } from './lib/db.js';
import { tenantForRequest } from './lib/tenant-context.js';
import { resolveBookingRequest } from './lib/booking-resolver.js';
import { getAvailability, holdAvailability } from './lib/availability-engine-v2.js';
import {
  addMinutes, createCanonicalBooking, getHold, getBookingSettings,
  listBookings, listServices, listStaff, releaseHold, updateCanonicalBooking
} from './lib/booking-repository.js';

function jsonBody(req){
  if(typeof req.body==='string') { try{return JSON.parse(req.body||'{}')}catch{return {}} }
  return req.body || {};
}

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization,x-lola-number');
  if(req.method==='OPTIONS') return res.status(204).end();

  try{
    // Merge query params into the body so GET requests (public booking,
    // calendar links) carry service_id / staff_id / date like POST does.
    const body={ ...(req.query||{}), ...jsonBody(req) };
    const tenant=await tenantForRequest(req,body);
    if(!tenant?.id){
      return res.status(req.__publicBooking===true?404:401).json({ ok:false,error:req.__publicBooking===true?'tenant_not_found':'not_authenticated' });
    }
    const action=body.action || req.query?.action || (req.method==='GET'?'day':'');

    if(action==='settings') return res.json({ ok:true, settings:await getBookingSettings(tenant.id) });

    if(action==='catalog'){
      const [services,staff]=await Promise.all([listServices(tenant.id),listStaff(tenant.id)]);
      return res.json({ ok:true,services,staff });
    }

    if(action==='day'){
      const [svcs,stff]=await Promise.all([listServices(tenant.id),listStaff(tenant.id)]);
      const date=req.query?.date || body.date || new Date().toISOString();
      const start=new Date(date); start.setUTCHours(0,0,0,0);
      const end=new Date(start.getTime()+86400000);
      const [bookings,services,staff,settings]=await Promise.all([
        listBookings(tenant.id,start.toISOString(),end.toISOString()),
        listServices(tenant.id),listStaff(tenant.id),getBookingSettings(tenant.id)
      ]);
      return res.json({ ok:true, services:svcs||[], staff:stff||[],date:start.toISOString().slice(0,10),bookings,services,staff,settings });
    }

    if(action==='availability'){
      const resolved=body.service_id
        ? { ok:true,service:{id:body.service_id},staff:body.staff_id?{id:body.staff_id}:null }
        : await resolveBookingRequest(tenant.id,{service:body.service,stylist:body.stylist||body.staff});
      if(!resolved.ok) return res.status(200).json({ ok:false,needs:resolved.needs,details:resolved });
      const out=await getAvailability({
        tenantId:tenant.id,serviceId:resolved.service.id,date:body.date||body.starts_at||new Date().toISOString(),
        staffId:body.staff_id || resolved.staff?.id || null,limit:Number(body.limit||12)
      });
      return res.json(out);
    }

    if(action==='hold'){
      let clientId=body.client_id||null;
      if(!clientId && (body.client_phone||body.client_name)){
        const client=await upsertClient(tenant.id,{phone:body.client_phone,name:body.client_name,email:body.client_email});
        clientId=client?.id||null;
      }
      const resolved=body.service_id && body.staff_id
        ? {ok:true,service:{id:body.service_id},staff:{id:body.staff_id}}
        : await resolveBookingRequest(tenant.id,{service:body.service,stylist:body.stylist||body.staff});
      if(!resolved.ok || !resolved.staff?.id) return res.status(200).json({ok:false,needs:resolved.needs||'staff'});
      return res.json(await holdAvailability({
        tenantId:tenant.id,clientId,serviceId:resolved.service.id,staffId:resolved.staff.id,
        startsAt:body.starts_at,channel:body.channel||'dashboard',conversationId:body.conversation_id||null,
        ttlSeconds:Number(body.ttl_seconds||300)
      }));
    }

    if(action==='book'){
      let clientId=body.client_id||null;
      if(!clientId){
        const client=await upsertClient(tenant.id,{phone:body.client_phone,name:body.client_name,email:body.client_email});
        clientId=client?.id||null;
      }
      if(!clientId) return res.status(200).json({ok:false,needs:'client'});

      let serviceId=body.service_id||null, staffId=body.staff_id||null;
      if(!serviceId || !staffId){
        const resolved=await resolveBookingRequest(tenant.id,{service:body.service,stylist:body.stylist||body.staff});
        if(!resolved.ok || !resolved.staff?.id) return res.status(200).json({ok:false,needs:resolved.needs||'staff'});
        serviceId=resolved.service.id; staffId=resolved.staff.id;
      }

      let hold=null;
      if(body.hold_token){
        hold=await getHold(tenant.id,body.hold_token);
        if(!hold || hold.status!=='active' || new Date(hold.expires_at)<=new Date()) return res.status(200).json({ok:false,conflict:true,error:'hold_expired'});
        if(hold.service_id!==serviceId || hold.staff_id!==staffId) return res.status(200).json({ok:false,error:'hold_mismatch'});
      } else {
        const held=await holdAvailability({tenantId:tenant.id,clientId,serviceId,staffId,startsAt:body.starts_at,channel:body.channel||'dashboard',conversationId:body.conversation_id||null,ttlSeconds:120});
        if(!held.ok) return res.status(200).json(held);
        hold=held.hold;
      }

      const services=await listServices(tenant.id);
      const service=services.find(x=>x.id===serviceId);
      const start=hold.starts_at;
      const end=hold.ends_at || addMinutes(start,service?.duration_minutes||60);
      const booking=await createCanonicalBooking({
        tenantId:tenant.id,clientId,serviceId,staffId,locationId:body.location_id||null,
        startTime:start,endTime:end,status:'confirmed',totalAmount:body.total_amount ?? service?.price ?? 0,
        notes:body.notes||null,source:body.channel||body.source||'dashboard',conversationId:body.conversation_id||null,holdId:hold.id
      });
      await releaseHold(tenant.id,hold.hold_token,'converted');
      return res.json({ok:true,status:'confirmed',booking_id:booking.id,booking});
    }

    if(action==='reschedule'){
      if(!body.booking_id || !body.starts_at) return res.status(400).json({ok:false,error:'booking_id_and_starts_at_required'});
      const c=db();
      const { data: current }=await c.from('bookings').select('*').eq('tenant_id',tenant.id).eq('id',body.booking_id).maybeSingle();
      if(!current) return res.status(404).json({ok:false,error:'booking_not_found'});
      const held=await holdAvailability({tenantId:tenant.id,clientId:current.client_id,serviceId:current.service_id,staffId:body.staff_id||current.staff_id,startsAt:body.starts_at,channel:body.channel||'dashboard',ttlSeconds:120});
      if(!held.ok) return res.status(200).json(held);
      const updated=await updateCanonicalBooking(tenant.id,current.id,{staff_id:body.staff_id||current.staff_id,start_time:held.slot.starts_at,end_time:held.slot.ends_at,status:'confirmed'},{source:body.channel||'dashboard',reason:'rescheduled'});
      await releaseHold(tenant.id,held.hold.hold_token,'converted');
      return res.json({ok:true,rescheduled:true,booking:updated});
    }

    if(action==='cancel'){
      if(!body.booking_id) return res.status(400).json({ok:false,error:'booking_id_required'});
      const updated=await updateCanonicalBooking(tenant.id,body.booking_id,{status:'cancelled'},{source:body.channel||'dashboard',reason:body.reason||'client_request'});
      return res.json({ok:!!updated,cancelled:!!updated,booking:updated});
    }

    return res.status(400).json({ok:false,error:'unknown_action'});
  }catch(e){
    console.error('[calendar]',e);
    return res.status(500).json({ok:false,error:'calendar_error',detail:String(e?.message||e)});
  }
}
