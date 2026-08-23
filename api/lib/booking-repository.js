import { randomInt } from 'node:crypto';
import { db } from './db.js';
import { sendSMS } from '../telnyx-sms.js';

// Short, human-friendly confirmation code for client self-cancel. 6 chars,
// unambiguous alphabet (no 0/O/1/I/L), crypto-random.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function makeConfirmationCode(){
  let out = '';
  for(let i = 0; i < 6; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

async function sendConfirmationSMS({tenantId,clientId,serviceId,startTime,confirmationCode=null}){
  try{
    const db2 = db();
    if(!db2) return;
    const [{data:tenant},{data:client},{data:svc}] = await Promise.all([
      db2.from('tenants').select('name,phone_number').eq('id',tenantId).maybeSingle(),
      db2.from('clients').select('name,phone').eq('id',clientId).maybeSingle(),
      db2.from('services').select('name').eq('id',serviceId).maybeSingle()
    ]);
    if(!client || !client.phone || !tenant || !tenant.phone_number) return;
    const when = new Date(startTime).toLocaleString('en-US',{weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
    const code = confirmationCode ? ' Your code: ' + confirmationCode + ' — use it to cancel or reschedule online.' : '';
    const text = 'Booked at ' + (tenant.name || 'the salon') + ': ' + (svc && svc.name ? svc.name : 'Appointment') + ' on ' + when + '.' + code + ' Reply STOP to opt out.';
    sendSMS({ from: tenant.phone_number, to: client.phone, text, tenantId });
  }catch(e){ console.warn('[repo] SMS:', e.message); }
}

const CANCELED = new Set(['cancelled','canceled']);

export function iso(value){
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function addMinutes(value, minutes){
  const start = new Date(value);
  return new Date(start.getTime() + Number(minutes || 0) * 60000).toISOString();
}

export async function getBookingSettings(tenantId){
  const c = db();
  if(!c) return null;
  const { data } = await c.from('booking_settings').select('*').eq('tenant_id', tenantId).maybeSingle();
  return data || {
    tenant_id: tenantId,
    timezone: 'America/New_York',
    slot_interval_minutes: 15,
    minimum_notice_minutes: 120,
    booking_horizon_days: 90,
    cancellation_window_hours: 24,
    default_buffer_before_min: 0,
    default_buffer_after_min: 0,
    allow_staff_choice: true,
    allow_any_staff: true,
    allow_processing_overlap: true,
    public_booking_enabled: true,
    voice_booking_enabled: true
  };
}

export async function listServices(tenantId, { activeOnly=true } = {}){
  const c = db(); if(!c) return [];
  let q = c.from('services').select('*').eq('tenant_id', tenantId).order('name');
  if(activeOnly) q = q.eq('is_active', true);
  const { data, error } = await q;
  if(error) throw error;
  return data || [];
}

export async function listStaff(tenantId, { activeOnly=true } = {}){
  const c = db(); if(!c) return [];
  let q = c.from('staff').select('*').eq('tenant_id', tenantId).order('name');
  if(activeOnly) q = q.eq('is_active', true);
  const { data, error } = await q;
  if(error) throw error;
  return data || [];
}

export async function getStaffServices(tenantId){
  const c = db(); if(!c) return [];
  const { data, error } = await c.from('staff_services')
    .select('staff_id,service_id,custom_duration_minutes,custom_price,staff!inner(tenant_id)')
    .eq('staff.tenant_id', tenantId);
  if(error) throw error;
  return data || [];
}

export async function getStaffSchedules(tenantId){
  const c = db(); if(!c) return [];
  const { data, error } = await c.from('staff_schedules').select('*').eq('tenant_id', tenantId);
  if(error) throw error;
  return data || [];
}

export async function getStaffTimeOff(tenantId, from, to){
  const c = db(); if(!c) return [];
  const { data, error } = await c.from('staff_time_off').select('*')
    .eq('tenant_id', tenantId).eq('approved', true)
    .lt('start_time', to).gt('end_time', from);
  if(error) throw error;
  return data || [];
}

export async function getBusinessHoursForTenant(tenantId){
  const c = db(); if(!c) return [];
  const { data: locations } = await c.from('locations').select('id,is_primary,timezone').eq('organization_id', tenantId);
  if(!locations?.length) return [];
  const primary = locations.find(x=>x.is_primary) || locations[0];
  const { data, error } = await c.from('business_hours').select('*').eq('location_id', primary.id).order('day_of_week');
  if(error) throw error;
  return (data || []).map(x=>({ ...x, location_id: primary.id, timezone: primary.timezone }));
}

export async function listBookings(tenantId, from, to, { staffId=null, clientId=null } = {}){
  const c = db(); if(!c) return [];
  let q = c.from('bookings').select('*').eq('tenant_id', tenantId).lt('start_time', to).gt('end_time', from);
  if(staffId) q = q.eq('staff_id', staffId);
  if(clientId) q = q.eq('client_id', clientId);
  const { data, error } = await q.order('start_time');
  if(error) throw error;
  return (data || []).filter(x=>!CANCELED.has(String(x.status||'').toLowerCase()));
}

export async function listActiveHolds(tenantId, from, to, { staffId=null } = {}){
  const c = db(); if(!c) return [];
  let q = c.from('availability_holds').select('*')
    .eq('tenant_id', tenantId).eq('status','active').gt('expires_at', new Date().toISOString())
    .lt('starts_at', to).gt('ends_at', from);
  if(staffId) q = q.eq('staff_id', staffId);
  const { data, error } = await q;
  if(error) throw error;
  return data || [];
}

export async function createHold({ tenantId, clientId=null, staffId, serviceId=null, startsAt, endsAt, channel='voice', conversationId=null, ttlSeconds=300 }){
  const c = db(); if(!c) throw new Error('database not configured');
  const expiresAt = new Date(Date.now() + Math.max(30, Number(ttlSeconds||300))*1000).toISOString();
  const { data, error } = await c.from('availability_holds').insert({
    tenant_id: tenantId, client_id: clientId, staff_id: staffId, service_id: serviceId,
    starts_at: startsAt, ends_at: endsAt, channel, conversation_id: conversationId,
    expires_at: expiresAt, status:'active'
  }).select().single();
  if(error) throw error;
  return data;
}

export async function releaseHold(tenantId, holdToken, status='released'){
  const c = db(); if(!c) return null;
  const { data, error } = await c.from('availability_holds').update({ status })
    .eq('tenant_id', tenantId).eq('hold_token', holdToken).select().maybeSingle();
  if(error) throw error;
  return data;
}

export async function getHold(tenantId, holdToken){
  const c = db(); if(!c) return null;
  const { data } = await c.from('availability_holds').select('*')
    .eq('tenant_id', tenantId).eq('hold_token', holdToken).maybeSingle();
  return data || null;
}

export async function createCanonicalBooking({ tenantId, clientId, serviceId=null, staffId=null, locationId=null, startTime, endTime, status='confirmed', totalAmount=0, notes=null, source='lola', conversationId=null, holdId=null, externalId=null, externalSource=null }){
  const c = db(); if(!c) throw new Error('database not configured');
  const row = {
    tenant_id: tenantId, client_id: clientId, service_id: serviceId, staff_id: staffId,
    location_id: locationId, start_time: startTime, end_time: endTime, status,
    total_amount: totalAmount || 0, notes, source, conversation_id: conversationId, hold_id: holdId,
    external_id: externalId, external_provider: externalSource,
    confirmation_code: makeConfirmationCode()
  };
  const { data, error } = await c.from('bookings').insert(row).select().single();
  if(error) throw error;
  await appendBookingHistory({ tenantId, bookingId:data.id, fromStatus:null, toStatus:status, source });
  if(status==='confirmed') sendConfirmationSMS({tenantId,clientId,serviceId,startTime,confirmationCode:row.confirmation_code}).catch(()=>{});
  return data;
}

export async function updateCanonicalBooking(tenantId, bookingId, patch, { source='lola', reason=null } = {}){
  const c = db(); if(!c) throw new Error('database not configured');
  const { data: before } = await c.from('bookings').select('*').eq('tenant_id',tenantId).eq('id',bookingId).maybeSingle();
  if(!before) return null;
  const { data, error } = await c.from('bookings').update({ ...patch, updated_at:new Date().toISOString() })
    .eq('tenant_id', tenantId).eq('id', bookingId).select().single();
  if(error) throw error;
  if(patch.status && patch.status !== before.status){
    await appendBookingHistory({ tenantId, bookingId, fromStatus:before.status, toStatus:patch.status, source, reason });
  }
  return data;
}

export async function appendBookingHistory({ tenantId, bookingId, fromStatus=null, toStatus, source='lola', actorId=null, reason=null, metadata={} }){
  const c = db(); if(!c) return null;
  const { data } = await c.from('booking_status_history').insert({
    tenant_id:tenantId, booking_id:bookingId, from_status:fromStatus, to_status:toStatus,
    source, actor_id:actorId, reason, metadata
  }).select().maybeSingle();
  return data;
}

export async function getProviderMapping(tenantId, provider, entityType, localId){
  const c = db(); if(!c) return null;
  const { data } = await c.from('provider_mappings').select('*')
    .eq('tenant_id',tenantId).eq('provider',provider).eq('entity_type',entityType).eq('local_id',localId).maybeSingle();
  return data || null;
}

export async function upsertProviderMapping({ tenantId, provider, entityType, localId, externalId, externalParentId=null, metadata={} }){
  const c = db(); if(!c) throw new Error('database not configured');
  const { data, error } = await c.from('provider_mappings').upsert({
    tenant_id:tenantId, provider, entity_type:entityType, local_id:localId,
    external_id:externalId, external_parent_id:externalParentId, metadata
  }, { onConflict:'tenant_id,provider,entity_type,local_id' }).select().single();
  if(error) throw error;
  return data;
}
