/**
 * Telnyx AI booking webhook — canonical calendar path.
 * AI speaks human language; Lola resolves IDs, validates availability,
 * creates a short hold, commits the booking, then returns confirmation.
 */
import { upsertClient } from './lib/db.js';
import { getTenantById } from './lib/operator-db.js';
import { resolveBookingRequest } from './lib/booking-resolver.js';
import { holdAvailability } from './lib/availability-engine-v2.js';
import { createCanonicalBooking, listServices, releaseHold } from './lib/booking-repository.js';

function bodyOf(req){
  if(typeof req.body==='string'){ try{return JSON.parse(req.body||'{}')}catch{return {}} }
  return req.body || {};
}

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, x-lola-booking-secret');
  if(req.method==='OPTIONS') return res.status(204).end();
  if(req.method!=='POST') return res.status(405).json({speak:'Method not allowed'});

  const provided=req.headers['x-lola-booking-secret'];
  const expected=process.env.BOOKING_TOOL_SECRET;
  if(!expected || !provided || provided!==expected){
    return res.status(401).json({speak:"I'm not able to book that from here right now."});
  }

  try{
    const body=bodyOf(req);
    const {tenant_id,service,stylist,starts_at,client_name,client_phone,client_email,conversation_id}=body;
    if(!tenant_id) return res.status(400).json({speak:"I couldn't tell which salon this call belongs to."});
    if(!service) return res.status(200).json({speak:'Absolutely. What would you like to come in for?',needs:'service'});
    if(!starts_at) return res.status(200).json({speak:'What day and roughly what time works best for you?',needs:'time'});

    const tenant=await getTenantById(tenant_id);
    if(!tenant) return res.status(404).json({speak:"I couldn't find this salon's account."});

    const resolved=await resolveBookingRequest(tenant.id,{service,stylist});
    if(!resolved.ok){
      if(resolved.needs==='service'){
        const names=(resolved.serviceResult?.candidates||[]).slice(0,4).map(x=>x.name);
        return res.status(200).json({
          speak:names.length?`I want to make sure I book the right service. I have ${names.join(', ')}. Which one sounds right?`:`Tell me a little more about what you'd like done and I'll match the right service.`,
          booked:false,needs:'service',options:names
        });
      }
      const names=(resolved.staffResult?.candidates||[]).slice(0,4).map(x=>x.name);
      return res.status(200).json({
        speak:names.length?`I don't see that exact name, but I have ${names.join(', ')}. Who would you like?`:`I can find the best person for that service. Do you have someone specific in mind?`,
        booked:false,needs:'staff',options:names
      });
    }

    const client=await upsertClient(tenant.id,{phone:client_phone,name:client_name,email:client_email});
    if(!client?.id) return res.status(200).json({speak:"What's the best phone number for the appointment?",booked:false,needs:'client_phone'});

    // If caller did not request a person, test eligible staff and choose the first
    // actually available option rather than letting the model invent one.
    let selectedStaff=resolved.staff;
    let held=null;
    if(selectedStaff){
      held=await holdAvailability({tenantId:tenant.id,clientId:client.id,serviceId:resolved.service.id,staffId:selectedStaff.id,startsAt:starts_at,channel:'voice',conversationId:conversation_id||null,ttlSeconds:120});
    }else{
      for(const candidate of (resolved.staffResult?.candidates||[])){
        const attempt=await holdAvailability({tenantId:tenant.id,clientId:client.id,serviceId:resolved.service.id,staffId:candidate.id,startsAt:starts_at,channel:'voice',conversationId:conversation_id||null,ttlSeconds:120});
        if(attempt.ok){ selectedStaff=candidate; held=attempt; break; }
      }
    }

    if(!held?.ok){
      return res.status(200).json({
        speak:`That time just got taken. I can find you the closest opening instead — would a little earlier or later be better?`,
        booked:false,conflict:true,needs:'alternate_time'
      });
    }

    const services=await listServices(tenant.id);
    const serviceRow=services.find(x=>x.id===resolved.service.id) || resolved.service;
    const booking=await createCanonicalBooking({
      tenantId:tenant.id,clientId:client.id,serviceId:resolved.service.id,staffId:selectedStaff.id,
      startTime:held.slot.starts_at,endTime:held.slot.ends_at,status:'confirmed',
      totalAmount:held.slot.price ?? serviceRow.price ?? 0,source:'telnyx_voice',
      conversationId:conversation_id||null,holdId:held.hold.id
    });
    await releaseHold(tenant.id,held.hold.hold_token,'converted');

    const when=new Date(booking.start_time).toLocaleString('en-US',{weekday:'long',month:'long',day:'numeric',hour:'numeric',minute:'2-digit'});
    return res.status(200).json({
      speak:`Perfect${client_name?`, ${String(client_name).split(' ')[0]}`:''}. You're with ${selectedStaff.name} for ${serviceRow.name} on ${when}. I'll text you the confirmation.`,
      booked:true,status:'confirmed',booking_id:booking.id,service_id:resolved.service.id,staff_id:selectedStaff.id
    });
  }catch(e){
    console.error('[telnyx-book-tool]',e);
    return res.status(200).json({speak:"I hit a snag locking that in. Give me another time and I'll take care of it.",booked:false,error:'booking_failed'});
  }
}
