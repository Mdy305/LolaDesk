import { db, upsertClient } from './lib/db.js';
import { tenantForRequest } from './lib/tenant-context.js';
import { resolveBookingRequest } from './lib/booking-resolver.js';
import { getAvailability, holdAvailability } from './lib/availability-engine-v2.js';
import {
  addMinutes, addToWaitlist, createCanonicalBooking, findWaitlistMatches, getHold, getBookingSettings,
  listBookings, listServices, listStaff, listWaitlist, releaseHold, removeFromWaitlist, updateCanonicalBooking,
  upsertProviderMapping
} from './lib/booking-repository.js';
import { ensureBookingBaseline } from './lib/booking-seed.js';
import { offerFreedSlot } from './lib/booking-reminders.js';
import { commitToExternalProvider } from './lib/booking-brain.js';

function jsonBody(req){
  if(typeof req.body==='string') { try{return JSON.parse(req.body||'{}')}catch{return {}} }
  return req.body || {};
}

// Compare phone numbers loosely: digits only, tolerate a leading US '1'.
// '(555) 123-4567' and '+15551234567' both normalize to '5551234567'.
function normPhone(p){
  let d=String(p||'').replace(/\D/g,'');
  if(d.length===11 && d[0]==='1') d=d.slice(1);
  return d;
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
    // Self-heal: any touch of a not-yet-bookable tenant (settings, catalog,
    // availability, Lola voice booking, the widget) seeds its missing booking
    // baseline. ensureBookingBaseline short-circuits on a single PK read when
    // the tenant is already bookable, so a healthy tenant pays one select.
    try{ await ensureBookingBaseline(tenant.id); }catch(e){ console.warn('[calendar] booking-seed', e.message); }
    const action=body.action || req.query?.action || (req.method==='GET'?'day':'');

    if(action==='settings') return res.json({ ok:true, settings:await getBookingSettings(tenant.id) });

    if(action==='catalog'){
      const [services,staff]=await Promise.all([listServices(tenant.id),listStaff(tenant.id)]);
      return res.json({ ok:true,services,staff });
    }

    if(action==='day' || action==='week'){
      const [services,staff]=await Promise.all([listServices(tenant.id),listStaff(tenant.id)]);
      const date=req.query?.date || body.date || new Date().toISOString();
      const start=new Date(date); start.setUTCHours(0,0,0,0);
      const days=action==='week' ? Math.max(1,Math.min(14,Number(body.days||7))) : 1;
      const end=new Date(start.getTime()+days*86400000);
      // Blocks (lunch, breaks, days off) ride the same payload so the calendar
      // can shade them on the staff grid. The table landed in
      // 20260829_inventory_ops.sql; pre-migration the query resolves empty.
      const from=start.toISOString().slice(0,10), to=end.toISOString().slice(0,10);
      const [bookings,settings,blocked]=await Promise.all([
        listBookings(tenant.id,start.toISOString(),end.toISOString()),
        action==='day' ? getBookingSettings(tenant.id) : Promise.resolve(null),
        db().from('blocked_slots').select('*').eq('tenant_id',tenant.id)
          .gte('blocked_date',from).lte('blocked_date',to)
      ]);
      const enriched=await enrichBookings(tenant.id,bookings,services,staff);
      const out={ ok:true, services, staff, start:start.toISOString(), days, bookings:enriched, blocked_slots:blocked.data||[] };
      if(action==='day'){ out.date=start.toISOString().slice(0,10); out.settings=settings; }
      return res.json(out);
    }

    if(action==='waitlist_add'){
      // All channels (voice via booking-brain, widget, dashboard, public web)
      // land here. Public callers identify by phone/name; dashboard passes
      // client_id. Service resolves by id or best-effort name.
      let clientId=body.client_id||null;
      if(!clientId && (body.client_phone||body.client_name)){
        const client=await upsertClient(tenant.id,{phone:body.client_phone,name:body.client_name,email:body.client_email});
        clientId=client?.id||null;
      }
      let serviceId=body.service_id||null, serviceName=body.service||body.service_name||null;
      if(!serviceId && serviceName){
        const services=await listServices(tenant.id);
        const match=services.find(s=>s.name?.toLowerCase()===serviceName.toLowerCase());
        if(match) serviceId=match.id;
      }
      const consent=body.sms_consent===true||body.sms_consent==='true';
      const entry=await addToWaitlist({
        tenantId:tenant.id, clientId,
        clientName:body.client_name||null, clientPhone:body.client_phone||null,
        serviceId, serviceName,
        staffId:body.staff_id||null,
        preferredDate:body.preferred_date||body.date||null,
        preferredTime:body.preferred_time||body.time||null,
        notes:body.notes||null,
        source:body.channel||body.source||'public_web',
        smsConsent:consent
      });
      return res.json({ ok:true, waitlisted:true, sms_consent:consent, entry });
    }

    if(action==='waitlist_list'){
      const entries=await listWaitlist(tenant.id,{ status:body.status||'active', limit:Number(body.limit||100) });
      return res.json({ ok:true, entries });
    }

    if(action==='waitlist_remove'){
      if(!body.id) return res.status(400).json({ ok:false, error:'id_required' });
      const removed=await removeFromWaitlist(tenant.id, body.id, body.status||'removed');
      return res.json({ ok:!!removed, removed });
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
      // Best-effort mesh write: when a booking provider is connected (incl.
      // cal_platform as booking_provider), the dashboard/widget booking also
      // lands upstream. Never fails the local booking — any outage or 409
      // keeps it local, exactly like the voice path's "caller never loses".
      let externalRef=null;
      try{
        const commit=await commitToExternalProvider(tenant.id,{
          client:{ id:clientId, name:body.client_name||null, phone:body.client_phone||null, email:body.client_email||null },
          service, staff:{ id:staffId },
          startsAt:start, endsAt:end, durationMin:service?.duration_minutes||60,
          notes:body.notes||'Booked from the LolaDesk calendar',
          price:body.total_amount ?? service?.price ?? 0, timezone:body.timezone||'America/New_York'
        });
        if(commit?.ok) externalRef=commit.external;
        else if(commit && !commit.skipped) console.warn('[calendar] external commit failed — booking kept local:', commit.error);
      }catch(e){ console.warn('[calendar] external write skipped — booking kept local:', e?.message||e); }
      const booking=await createCanonicalBooking({
        tenantId:tenant.id,clientId,serviceId,staffId,locationId:body.location_id||null,
        startTime:start,endTime:end,status:'confirmed',totalAmount:body.total_amount ?? service?.price ?? 0,
        notes:body.notes||null,source:body.channel||body.source||'dashboard',conversationId:body.conversation_id||null,holdId:hold.id,
        externalId:externalRef?.id||null, externalSource:externalRef?.provider||null
      });
      if(externalRef){
        try{ await upsertProviderMapping({ tenantId:tenant.id, provider:externalRef.provider, entityType:'booking', localId:booking.id, externalId:externalRef.id, metadata:{ starts_at: booking.start_time } }); }catch{}
      }
      await releaseHold(tenant.id,hold.hold_token,'converted');
      return res.json({ok:true,status:'confirmed',booking_id:booking.id,booking,external:externalRef||null});
    }

    if(action==='lookup'){
      // Public self-service: confirmation code + phone → the client's own
      // booking (never by booking_id, which would leak other people's rows).
      const code=String(body.code||'').trim().toUpperCase();
      const phone=String(body.client_phone||'').trim();
      if(!code || !phone) return res.status(200).json({ok:false,error:'code_and_phone_required'});
      const c=db();
      const { data: booking }=await c.from('bookings').select('*')
        .eq('tenant_id',tenant.id).eq('confirmation_code',code).maybeSingle();
      if(!booking) return res.status(200).json({ok:false,error:'code_not_found'});
      const { data: client }=await c.from('clients').select('phone').eq('id',booking.client_id).maybeSingle();
      if(!client || normPhone(client.phone)!==normPhone(phone)){
        return res.status(200).json({ok:false,error:'code_phone_mismatch'});
      }
      const [services,staff]=await Promise.all([listServices(tenant.id),listStaff(tenant.id)]);
      const enriched=await enrichBookings(tenant.id,[booking],services,staff);
      const b=enriched[0]||booking;
      return res.json({ ok:true, booking:{
        confirmation_code:b.confirmation_code,
        start_time:b.start_time, end_time:b.end_time, status:b.status,
        service:b.service ? { id:b.service.id, name:b.service.name, price:b.service.price, duration_minutes:b.service.duration_minutes } : null,
        staff:b.staff ? { id:b.staff.id, name:b.staff.name } : null
      }});
    }

    if(action==='reschedule'){
      // Public self-service: code + phone + new time (never booking_id).
      if(req.__publicBooking){
        const code=String(body.code||'').trim().toUpperCase();
        const phone=String(body.client_phone||'').trim();
        const startsAt=body.starts_at;
        if(!code || !phone || !startsAt) return res.status(200).json({ok:false,error:'code_phone_and_starts_at_required'});
        const c=db();
        const { data: current }=await c.from('bookings').select('*')
          .eq('tenant_id',tenant.id).eq('confirmation_code',code).maybeSingle();
        if(!current) return res.status(200).json({ok:false,error:'code_not_found'});
        if(current.status!=='confirmed') return res.status(200).json({ok:false,error:'not_reschedulable'});
        if(new Date(current.start_time)<=new Date()) return res.status(200).json({ok:false,error:'appointment_passed'});
        const { data: client }=await c.from('clients').select('phone').eq('id',current.client_id).maybeSingle();
        if(!client || normPhone(client.phone)!==normPhone(phone)){
          return res.status(200).json({ok:false,error:'code_phone_mismatch'});
        }
        if(new Date(startsAt)<=new Date()) return res.status(200).json({ok:false,error:'time_in_past'});
        const held=await holdAvailability({tenantId:tenant.id,clientId:current.client_id,serviceId:current.service_id,staffId:body.staff_id||current.staff_id,startsAt,channel:'public_widget',ttlSeconds:120});
        if(!held.ok) return res.status(200).json(held);
      const updated=await updateCanonicalBooking(tenant.id,current.id,{staff_id:body.staff_id||current.staff_id,start_time:held.slot.starts_at,end_time:held.slot.ends_at,status:'confirmed'},{source:'public_widget',reason:'client_self_service_reschedule'});
      await releaseHold(tenant.id,held.hold.hold_token,'converted');
      let publicOffer=null;
      if(updated){
        try{ publicOffer=await offerFreedSlot({tenantId:tenant.id,serviceId:current.service_id||null,serviceName:current.service||current.service_name||null,freedAt:current.start_time||current.starts_at}); }
        catch(e){ console.warn('[calendar] waitlist offer failed:',e.message); }
      }
      return res.json({ok:!!updated,rescheduled:!!updated,booking:updated,waitlist_offer:publicOffer});
    }
    if(!body.booking_id || !body.starts_at) return res.status(400).json({ok:false,error:'booking_id_and_starts_at_required'});
    const c=db();
    const { data: current }=await c.from('bookings').select('*').eq('tenant_id',tenant.id).eq('id',body.booking_id).maybeSingle();
    if(!current) return res.status(404).json({ok:false,error:'booking_not_found'});
    const held=await holdAvailability({tenantId:tenant.id,clientId:current.client_id,serviceId:current.service_id,staffId:body.staff_id||current.staff_id,startsAt:body.starts_at,channel:body.channel||'dashboard',ttlSeconds:120});
    if(!held.ok) return res.status(200).json(held);
    const updated=await updateCanonicalBooking(tenant.id,current.id,{staff_id:body.staff_id||current.staff_id,start_time:held.slot.starts_at,end_time:held.slot.ends_at,status:'confirmed'},{source:body.channel||'dashboard',reason:'rescheduled'});
    await releaseHold(tenant.id,held.hold.hold_token,'converted');
    let dashOffer=null;
    if(updated){
      try{ dashOffer=await offerFreedSlot({tenantId:tenant.id,serviceId:current.service_id||null,serviceName:current.service||current.service_name||null,freedAt:current.start_time||current.starts_at}); }
      catch(e){ console.warn('[calendar] waitlist offer failed:',e.message); }
    }
    return res.json({ok:true,rescheduled:true,booking:updated,waitlist_offer:dashOffer});
  }

    if(action==='cancel'){
      // Public self-cancel: confirmation code + phone (never booking_id, which
      // would let anyone cancel by guessing a UUID). The code alone can't
      // cancel — the client's phone must match the booking.
      if(req.__publicBooking){
        const code=String(body.code||'').trim().toUpperCase();
        const phone=String(body.client_phone||'').trim();
        if(!code || !phone) return res.status(200).json({ok:false,error:'code_and_phone_required'});
        const c=db();
        const { data: booking }=await c.from('bookings').select('*')
          .eq('tenant_id',tenant.id).eq('confirmation_code',code).maybeSingle();
        if(!booking) return res.status(200).json({ok:false,error:'code_not_found'});
        if(booking.status!=='confirmed') return res.status(200).json({ok:false,error:'not_cancellable'});
        if(new Date(booking.start_time)<=new Date()) return res.status(200).json({ok:false,error:'appointment_passed'});
        const { data: client }=await c.from('clients').select('phone').eq('id',booking.client_id).maybeSingle();
        if(!client || normPhone(client.phone)!==normPhone(phone)){
          return res.status(200).json({ok:false,error:'code_phone_mismatch'});
        }
        const updated=await updateCanonicalBooking(tenant.id,booking.id,{status:'cancelled'},{source:'public_widget',reason:'client_self_service'});
        let publicOffer=null;
        if(updated){
          try{ publicOffer=await offerFreedSlot({tenantId:tenant.id,serviceId:booking.service_id||null,serviceName:booking.service||booking.service_name||null,freedAt:booking.start_time||booking.starts_at}); }
          catch(e){ console.warn('[calendar] waitlist offer failed:',e.message); }
        }
        return res.json({ok:!!updated,cancelled:!!updated,booking:updated,waitlist_offer:publicOffer});
      }
      if(!body.booking_id) return res.status(400).json({ok:false,error:'booking_id_required'});
      const updated=await updateCanonicalBooking(tenant.id,body.booking_id,{status:'cancelled'},{source:body.channel||'dashboard',reason:body.reason||'client_request'});
      let waitlist_matches={count:0,entries:[]};
      let waitlist_offer=null;
      if(updated){
        try{
          let freedName=updated.service||updated.service_name||null;
          if(!freedName && updated.service_id){
            const services=await listServices(tenant.id);
            freedName=services.find(s=>s.id===updated.service_id)?.name||null;
          }
          waitlist_matches=await findWaitlistMatches(tenant.id,{
            serviceId:updated.service_id||null,
            serviceName:freedName
          });
          waitlist_offer=await offerFreedSlot({tenantId:tenant.id,serviceId:updated.service_id||null,serviceName:freedName,freedAt:updated.start_time||updated.starts_at});
        }catch(e){ console.warn('[calendar] waitlist match failed:',e.message); }
      }
      return res.json({ok:!!updated,cancelled:!!updated,booking:updated,waitlist_matches,waitlist_offer});
    }

    return res.status(400).json({ok:false,error:'unknown_action'});
  }catch(e){
    console.error('[calendar]',e);
    return res.status(500).json({ok:false,error:'calendar_error',detail:String(e?.message||e)});
  }
}

// Attach service / staff / client objects to raw booking rows so the calendar
// UI renders real names instead of "Appointment"/"Client" fallbacks.
async function enrichBookings(tenantId, bookings, services, staff){
  if(!Array.isArray(bookings) || !bookings.length) return bookings || [];
  const clientIds=[...new Set(bookings.map(b=>b.client_id).filter(Boolean))];
  let clients=[];
  if(clientIds.length){
    const c=db();
    const { data }=await c.from('clients').select('id,first_name,last_name,name,phone,email,is_vip,profile_picture_url').in('id',clientIds);
    clients=data||[];
  }
  return bookings.map(b=>({
    ...b,
    service:(services||[]).find(s=>s.id===b.service_id)||null,
    staff:(staff||[]).find(s=>s.id===b.staff_id)||null,
    client:clients.find(cl=>cl.id===b.client_id)||null
  }));
}
