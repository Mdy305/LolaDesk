import { db } from './db.js';

function money(n){ return Number(n || 0); }
function durationFromService(service){
  if(!service) return 60;
  return Number(service.duration_minutes || service.active_duration_1_min || 60)
    + Number(service.processing_duration_min || 0)
    + Number(service.active_duration_2_min || 0);
}

export async function listStaff(tenantId){
  const c = db();
  if(!c) return [];
  const { data, error } = await c.from('staff').select('*').eq('tenant_id', tenantId).eq('is_active', true).order('created_at');
  if(error) throw new Error(error.message);
  return data || [];
}

export async function listServices(tenantId){
  const c = db();
  if(!c) return [];
  const { data, error } = await c.from('services').select('*').eq('tenant_id', tenantId).eq('is_active', true).order('name');
  if(error) throw new Error(error.message);
  return data || [];
}

export async function listBookings(tenantId, { from=null, to=null, limit=500 } = {}){
  const c = db();
  if(!c) return [];
  let q = c.from('bookings').select('*,clients(first_name,last_name,phone,email),services(name,duration_minutes,price),staff(name,role)').eq('tenant_id', tenantId).order('start_time', { ascending:true }).limit(limit);
  if(from) q = q.gte('start_time', from);
  if(to) q = q.lt('start_time', to);
  const { data, error } = await q;
  if(error) throw new Error(error.message);
  return (data || []).map(normalizeBooking);
}

export function normalizeBooking(row){
  const clientName = [row.clients?.first_name, row.clients?.last_name].filter(Boolean).join(' ') || 'Client';
  const serviceName = row.services?.name || 'Appointment';
  const staffName = row.staff?.name || '';
  const start = row.start_time;
  const end = row.end_time;
  const durationMin = start && end ? Math.max(1, Math.round((new Date(end) - new Date(start))/60000)) : durationFromService(row.services);
  return {
    id: row.id,
    clientId: row.client_id,
    client: clientName,
    clientPhone: row.clients?.phone || '',
    clientEmail: row.clients?.email || '',
    serviceId: row.service_id,
    service: serviceName,
    staffId: row.staff_id,
    stylist: staffName,
    startsAt: start,
    endsAt: end,
    durationMin,
    price: money(row.total_amount || row.services?.price),
    status: row.status || 'pending',
    source: row.source || 'lola',
    notes: row.notes || ''
  };
}

export async function findOrCreateClient(tenantId, { name='', phone='', email='' } = {}){
  const c = db();
  if(!c) return null;
  const normalizedPhone = String(phone || '').trim();
  const normalizedEmail = String(email || '').trim().toLowerCase();
  let existing = null;
  if(normalizedPhone){
    const { data } = await c.from('clients').select('*').eq('tenant_id', tenantId).eq('phone', normalizedPhone).limit(1);
    existing = data?.[0] || null;
  }
  if(!existing && normalizedEmail){
    const { data } = await c.from('clients').select('*').eq('tenant_id', tenantId).eq('email', normalizedEmail).limit(1);
    existing = data?.[0] || null;
  }
  if(existing) return existing;
  const parts = String(name || 'Client').trim().split(/\s+/);
  const firstName = parts.shift() || 'Client';
  const lastName = parts.join(' ') || null;
  const { data, error } = await c.from('clients').insert({ tenant_id:tenantId, first_name:firstName, last_name:lastName, phone:normalizedPhone || null, email:normalizedEmail || null }).select().single();
  if(error) throw new Error(error.message);
  return data;
}

export async function resolveService(tenantId, { serviceId=null, serviceName=null } = {}){
  const c = db();
  if(!c) return null;
  let q = c.from('services').select('*').eq('tenant_id', tenantId).eq('is_active', true);
  if(serviceId) q = q.eq('id', serviceId);
  else if(serviceName) q = q.ilike('name', serviceName);
  else return null;
  const { data, error } = await q.limit(1);
  if(error) throw new Error(error.message);
  return data?.[0] || null;
}

export async function resolveStaff(tenantId, { staffId=null, staffName=null } = {}){
  const c = db();
  if(!c) return null;
  let q = c.from('staff').select('*').eq('tenant_id', tenantId).eq('is_active', true);
  if(staffId) q = q.eq('id', staffId);
  else if(staffName) q = q.ilike('name', staffName);
  else return null;
  const { data, error } = await q.limit(1);
  if(error) throw new Error(error.message);
  return data?.[0] || null;
}

export async function createCanonicalBooking(tenantId, payload){
  const c = db();
  if(!c) throw new Error('database not configured');
  const service = await resolveService(tenantId, { serviceId:payload.serviceId, serviceName:payload.service });
  const staff = await resolveStaff(tenantId, { staffId:payload.staffId, staffName:payload.stylist });
  const client = payload.clientId ? { id:payload.clientId } : await findOrCreateClient(tenantId, { name:payload.clientName, phone:payload.clientPhone, email:payload.clientEmail });
  if(!client?.id) throw new Error('client required');
  const start = new Date(payload.startsAt);
  if(Number.isNaN(start.getTime())) throw new Error('invalid start time');
  const durationMin = Number(payload.durationMin || durationFromService(service) || 60);
  const end = new Date(start.getTime() + durationMin*60000);
  const row = {
    tenant_id: tenantId,
    client_id: client.id,
    service_id: service?.id || null,
    staff_id: staff?.id || null,
    start_time: start.toISOString(),
    end_time: end.toISOString(),
    status: payload.status || 'confirmed',
    total_amount: payload.price != null ? Number(payload.price) : Number(service?.price || 0),
    notes: payload.notes || null,
    source: payload.source || 'dashboard',
    conversation_id: payload.conversationId || null
  };
  const { data, error } = await c.from('bookings').insert(row).select('*,clients(first_name,last_name,phone,email),services(name,duration_minutes,price),staff(name,role)').single();
  if(error) throw new Error(error.message);
  return normalizeBooking(data);
}

export async function updateBookingTime(tenantId, bookingId, startsAt){
  const c = db();
  if(!c) throw new Error('database not configured');
  const { data: rows } = await c.from('bookings').select('*,services(duration_minutes,active_duration_1_min,processing_duration_min,active_duration_2_min)').eq('tenant_id',tenantId).eq('id',bookingId).limit(1);
  const row = rows?.[0];
  if(!row) throw new Error('booking not found');
  const oldStart = new Date(row.start_time);
  const oldEnd = new Date(row.end_time);
  const durationMin = Number.isFinite(oldEnd-oldStart) ? Math.max(1,Math.round((oldEnd-oldStart)/60000)) : durationFromService(row.services);
  const start = new Date(startsAt);
  const end = new Date(start.getTime()+durationMin*60000);
  const { data, error } = await c.from('bookings').update({ start_time:start.toISOString(), end_time:end.toISOString(), status:'confirmed' }).eq('tenant_id',tenantId).eq('id',bookingId).select('*,clients(first_name,last_name,phone,email),services(name,duration_minutes,price),staff(name,role)').single();
  if(error) throw new Error(error.message);
  return normalizeBooking(data);
}

export async function cancelCanonicalBooking(tenantId, bookingId){
  const c = db();
  if(!c) throw new Error('database not configured');
  const { data, error } = await c.from('bookings').update({ status:'cancelled' }).eq('tenant_id',tenantId).eq('id',bookingId).select('*,clients(first_name,last_name,phone,email),services(name,duration_minutes,price),staff(name,role)').single();
  if(error) throw new Error(error.message);
  return normalizeBooking(data);
}
