import { db, getTenantByPhone, getTenantBySlug } from './db.js';
import crm from './lola-crm.js';
import { resolveBookingRequest } from './booking-resolver.js';
import { getAvailability, holdAvailability } from './availability-engine-v2.js';
import { createCanonicalBooking, getHold, listServices, listStaff, releaseHold, updateCanonicalBooking } from './booking-repository.js';

const SAFE_ACTIONS=new Set([
  'identify_client','get_client_context','remember_client_detail','update_client',
  'list_services','list_staff','check_availability','hold_slot','create_booking',
  'reschedule_booking','cancel_booking','get_booking','create_follow_up','escalate'
]);

async function audit(tenantId, action, ok, metadata={}){
  const c=db(); if(!c||!tenantId)return;
  try{ await c.from('usage_events').insert({tenant_id:tenantId,kind:'lola_execution',units:1,metadata:{action,ok,...metadata}}); }catch{}
}

export async function resolveExecutionTenant(input={}){
  const c=db();
  if(input.tenant_id && c){ const {data}=await c.from('tenants').select('*').eq('id',input.tenant_id).maybeSingle(); if(data)return data; }
  if(input.tenant) return getTenantBySlug(input.tenant);
  if(input.to || input.called_number) return getTenantByPhone(input.to||input.called_number);
  return null;
}

async function resolveClient(tenantId,input={},create=false){
  if(input.client_id){ const c=db(); const {data}=await c.from('clients').select('*').eq('tenant_id',tenantId).eq('id',input.client_id).maybeSingle(); if(data)return data; }
  const found=await crm.findClientByContact(tenantId,input.client_phone||input.phone||null,input.client_email||input.email||null);
  if(found||!create)return found;
  return crm.upsertClient(tenantId,{phone:input.client_phone||input.phone,email:input.client_email||input.email,name:input.client_name||input.name});
}

async function getBooking(tenantId,id){ const c=db(); if(!c||!id)return null; const {data}=await c.from('bookings').select('*').eq('tenant_id',tenantId).eq('id',id).maybeSingle(); return data||null; }

export async function executeLolaAction({action,tenant,input={},channel='lola',conversationId=null,actor='lola'}={}){
  const started=Date.now();
  if(!SAFE_ACTIONS.has(action)) return {ok:false,error:'unsupported_action'};
  if(!tenant?.id) return {ok:false,error:'tenant_required'};
  const tenantId=tenant.id;
  try{
    let result;
    if(action==='identify_client'){
      let client=await resolveClient(tenantId,input,false);
      if(!client && input.create_if_missing) client=await resolveClient(tenantId,input,true);
      result={ok:true,found:!!client,client};
    }
    else if(action==='get_client_context'){
      const client=await resolveClient(tenantId,input,false);
      if(!client) result={ok:true,found:false,client:null};
      else result={ok:true,found:true,client,context:await crm.getClientInsights(client.id,tenantId)};
    }
    else if(action==='remember_client_detail'){
      const client=await resolveClient(tenantId,input,true);
      if(!client) result={ok:false,error:'client_required'};
      else { const memory=await crm.rememberClientDetail(client.id,tenantId,{key:input.key,value:input.value,phone:client.phone}); result={ok:true,client_id:client.id,memory}; }
    }
    else if(action==='update_client'){
      const client=await resolveClient(tenantId,input,true);
      if(!client) result={ok:false,error:'client_required'};
      else result={ok:true,client:await crm.upsertClient(tenantId,{...input,id:client.id})};
    }
    else if(action==='list_services') result={ok:true,services:await listServices(tenantId)};
    else if(action==='list_staff') result={ok:true,staff:await listStaff(tenantId)};
    else if(action==='check_availability'){
      const resolved=input.service_id?{ok:true,service:{id:input.service_id},staff:input.staff_id?{id:input.staff_id}:null}:await resolveBookingRequest(tenantId,{service:input.service,stylist:input.stylist||input.staff});
      if(!resolved.ok) result={ok:false,needs:resolved.needs,details:resolved};
      else result=await getAvailability({tenantId,serviceId:resolved.service.id,date:input.date||input.starts_at||new Date().toISOString(),staffId:input.staff_id||resolved.staff?.id||null,limit:Number(input.limit||12)});
    }
    else if(action==='hold_slot'){
      const client=await resolveClient(tenantId,input,true);
      const resolved=input.service_id&&input.staff_id?{ok:true,service:{id:input.service_id},staff:{id:input.staff_id}}:await resolveBookingRequest(tenantId,{service:input.service,stylist:input.stylist||input.staff});
      if(!resolved.ok||!resolved.staff?.id) result={ok:false,needs:resolved.needs||'staff'};
      else result=await holdAvailability({tenantId,clientId:client?.id||null,serviceId:resolved.service.id,staffId:resolved.staff.id,startsAt:input.starts_at,channel,conversationId,ttlSeconds:Number(input.ttl_seconds||300)});
    }
    else if(action==='create_booking'){
      const client=await resolveClient(tenantId,input,true); if(!client) return {ok:false,error:'client_required'};
      const resolved=input.service_id&&input.staff_id?{ok:true,service:{id:input.service_id},staff:{id:input.staff_id}}:await resolveBookingRequest(tenantId,{service:input.service,stylist:input.stylist||input.staff});
      if(!resolved.ok||!resolved.staff?.id) result={ok:false,needs:resolved.needs||'staff'};
      else {
        let hold=input.hold_token?await getHold(tenantId,input.hold_token):null;
        if(hold && (hold.status!=='active'||new Date(hold.expires_at)<=new Date())) hold=null;
        if(!hold){ const h=await holdAvailability({tenantId,clientId:client.id,serviceId:resolved.service.id,staffId:resolved.staff.id,startsAt:input.starts_at,channel,conversationId,ttlSeconds:120}); if(!h.ok) result=h; else hold=h.hold; }
        if(hold){
          const services=await listServices(tenantId), service=services.find(s=>s.id===resolved.service.id);
          const booking=await createCanonicalBooking({tenantId,clientId:client.id,serviceId:resolved.service.id,staffId:resolved.staff.id,locationId:input.location_id||null,startTime:hold.starts_at,endTime:hold.ends_at,status:'confirmed',totalAmount:input.total_amount??service?.price??0,notes:input.notes||null,source:channel,conversationId,holdId:hold.id});
          await releaseHold(tenantId,hold.hold_token,'converted');
          await crm.updateClientFromConversation(client.id,tenantId,{intent:'booking_completed',channel,summary:`Booking ${booking.id} confirmed`,phone:client.phone});
          result={ok:true,status:'confirmed',booking_id:booking.id,booking};
        }
      }
    }
    else if(action==='reschedule_booking'){
      const current=await getBooking(tenantId,input.booking_id); if(!current) result={ok:false,error:'booking_not_found'};
      else { const held=await holdAvailability({tenantId,clientId:current.client_id,serviceId:current.service_id,staffId:input.staff_id||current.staff_id,startsAt:input.starts_at,channel,conversationId,ttlSeconds:120}); if(!held.ok) result=held; else { const booking=await updateCanonicalBooking(tenantId,current.id,{staff_id:input.staff_id||current.staff_id,start_time:held.slot.starts_at,end_time:held.slot.ends_at,status:'confirmed'},{source:channel,reason:'rescheduled'}); await releaseHold(tenantId,held.hold.hold_token,'converted'); result={ok:true,rescheduled:true,booking}; } }
    }
    else if(action==='cancel_booking'){
      const booking=await updateCanonicalBooking(tenantId,input.booking_id,{status:'cancelled'},{source:channel,reason:input.reason||'client_request'}); result={ok:!!booking,cancelled:!!booking,booking};
    }
    else if(action==='get_booking') result={ok:true,booking:await getBooking(tenantId,input.booking_id)};
    else if(action==='create_follow_up'){
      const client=await resolveClient(tenantId,input,true); if(!client) result={ok:false,error:'client_required'}; else { const c=db(); const when=input.scheduled_for||new Date(Date.now()+24*3600000).toISOString(); const {data,error}=await c.from('follow_up_queue').insert({client_id:client.id,tenant_id:tenantId,campaign_type:input.campaign_type||'lola_follow_up',context:input.context||{},scheduled_for:when}).select().single(); if(error)throw error; result={ok:true,follow_up:data}; }
    }
    else if(action==='escalate'){
      const c=db(); const client=await resolveClient(tenantId,input,true); await c.from('usage_events').insert({tenant_id:tenantId,kind:'human_escalation',units:1,metadata:{client_id:client?.id||null,reason:input.reason||'requested',message:input.message||null,channel,conversation_id:conversationId}}); result={ok:true,escalated:true};
    }
    await audit(tenantId,action,!!result?.ok,{channel,actor,conversation_id:conversationId,duration_ms:Date.now()-started,error:result?.error||null});
    return result;
  }catch(error){ await audit(tenantId,action,false,{channel,actor,conversation_id:conversationId,duration_ms:Date.now()-started,error:String(error?.message||error)}); return {ok:false,error:'execution_failed',detail:String(error?.message||error)}; }
}

export default {executeLolaAction,resolveExecutionTenant};
