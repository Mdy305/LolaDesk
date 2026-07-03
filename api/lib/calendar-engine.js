import { db, createBooking, getTenantIntegrations } from './db.js';
import { listAllAppointments } from './aggregator.js';

function toIso(value){
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function overlaps(aStart, aEnd, bStart, bEnd){
  return aStart < bEnd && bStart < aEnd;
}

function addMinutes(iso, min){
  return new Date(new Date(iso).getTime() + min * 60000).toISOString();
}

export function parseDurationMin(value, fallback=60){
  if(value == null) return fallback;
  if(typeof value === 'number' && Number.isFinite(value)) return Math.max(15, Math.min(480, Math.round(value)));
  const t = String(value).trim().toLowerCase();
  if(!t) return fallback;
  if(/^\d+$/.test(t)) return Math.max(15, Math.min(480, Number(t)));
  let minutes = 0;
  const h = t.match(/(\d+(?:\.\d+)?)\s*h/);
  const m = t.match(/(\d+)\s*m/);
  if(h) minutes += Math.round(Number(h[1]) * 60);
  if(m) minutes += Number(m[1]);
  const compact = t.match(/^(\d{1,2})h(?:(\d{1,2}))?$/);
  if(!minutes && compact){
    minutes = Number(compact[1]) * 60 + Number(compact[2] || 0);
  }
  return Math.max(15, Math.min(480, minutes || fallback));
}

function parseHourRange(hoursText=''){
  const t = String(hoursText || '').toLowerCase();
  const m = t.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?.*?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if(!m) return { startMin: 9 * 60, endMin: 18 * 60 };
  const h = (hh, mm, ap) => {
    let x = Number(hh || 0);
    if(String(ap).toLowerCase() === 'pm' && x < 12) x += 12;
    if(String(ap).toLowerCase() === 'am' && x === 12) x = 0;
    return x * 60 + Number(mm || 0);
  };
  const startMin = h(m[1], m[2], m[3]);
  const endMin = h(m[4], m[5], m[6]);
  return { startMin: Math.max(0, startMin), endMin: Math.min(24 * 60, endMin || 18 * 60) };
}

async function internalBookingsForDay(tenantId, dayIso){
  const c = db();
  if(!c) return [];
  const day = new Date(dayIso);
  day.setUTCHours(0, 0, 0, 0);
  const start = day.toISOString();
  const end = new Date(day.getTime() + 24 * 3600 * 1000).toISOString();
  const { data } = await c
    .from('bookings')
    .select('id, starts_at, duration_min, stylist, status, service')
    .eq('tenant_id', tenantId)
    .gte('starts_at', start)
    .lt('starts_at', end);
  return data || [];
}

export async function listAvailability({ tenant, date, durationMin=60, stylist=null }){
  const dayIso = toIso(date || new Date());
  if(!dayIso) return { slots: [], speak: 'I need a valid date to check availability.' };
  const { startMin, endMin } = parseHourRange(tenant?.hours);
  const day = new Date(dayIso);
  day.setUTCHours(0, 0, 0, 0);
  const bookings = await internalBookingsForDay(tenant.id, day.toISOString());

  let external = [];
  try{
    const integrations = await getTenantIntegrations(tenant.id);
    if(integrations.length){
      external = await listAllAppointments(integrations, {
        from: day.toISOString(),
        to: new Date(day.getTime() + 24 * 3600 * 1000).toISOString()
      });
    }
  }catch{}

  const busy = [
    ...bookings.map(b => ({
      start: toIso(b.starts_at),
      end: addMinutes(toIso(b.starts_at), Number(b.duration_min || 60)),
      stylist: b.stylist || null
    })),
    ...external.map(e => ({
      start: toIso(e.starts_at),
      end: toIso(e.ends_at) || addMinutes(toIso(e.starts_at), Number(e.duration_min || 60)),
      stylist: e.stylist || null
    }))
  ].filter(x => x.start && x.end);

  const slots = [];
  for(let minute = startMin; minute + durationMin <= endMin; minute += 30){
    const slotStart = new Date(day.getTime() + minute * 60000).toISOString();
    const slotEnd = addMinutes(slotStart, durationMin);
    const conflict = busy.some(b =>
      (!stylist || !b.stylist || String(b.stylist).toLowerCase() === String(stylist).toLowerCase()) &&
      overlaps(slotStart, slotEnd, b.start, b.end)
    );
    if(!conflict) slots.push(slotStart);
    if(slots.length >= 6) break;
  }
  return { slots, speak: slots.length ? null : 'I do not see open slots in that window. I can offer the next best time.' };
}

export async function createBookingSafe({ tenant, clientId, conversationId=null, service, stylist=null, startsAt, durationMin=60, price=null }){
  const startIso = toIso(startsAt);
  if(!startIso) return { ok:false, error:'invalid datetime' };
  if(new Date(startIso).getTime() < (Date.now() + 2 * 60 * 1000)){
    return { ok:false, error:'appointment time must be in the future' };
  }
  const normalizedDuration = parseDurationMin(durationMin, 60);
  const endIso = addMinutes(startIso, normalizedDuration);
  const { startMin, endMin } = parseHourRange(tenant?.hours);
  const startDate = new Date(startIso);
  const endDate = new Date(endIso);
  const startMinute = startDate.getUTCHours() * 60 + startDate.getUTCMinutes();
  const endMinute = endDate.getUTCHours() * 60 + endDate.getUTCMinutes();
  if(startMinute < startMin || endMinute > endMin){
    return { ok:false, error:'outside business hours' };
  }

  const existing = await internalBookingsForDay(tenant.id, startIso);
  const conflict = existing.find(b => {
    if(String(b.status || '').toLowerCase() === 'cancelled') return false;
    if(stylist && b.stylist && String(b.stylist).toLowerCase() !== String(stylist).toLowerCase()) return false;
    const bStart = toIso(b.starts_at);
    const bEnd = addMinutes(bStart, Number(b.duration_min || 60));
    return overlaps(startIso, endIso, bStart, bEnd);
  });
  if(conflict){
    return { ok:false, conflict:true, error:'time conflict', conflictBookingId: conflict.id };
  }

  try{
    const integrations = await getTenantIntegrations(tenant.id);
    if(integrations.length){
      const from = new Date(new Date(startIso).getTime() - 2 * 3600 * 1000).toISOString();
      const to = new Date(new Date(endIso).getTime() + 2 * 3600 * 1000).toISOString();
      const external = await listAllAppointments(integrations, { from, to });
      const externalConflict = (external || []).find(e => {
        const eStart = toIso(e.starts_at);
        const eEnd = toIso(e.ends_at) || addMinutes(eStart, parseDurationMin(e.duration_min, 60));
        if(!eStart || !eEnd) return false;
        if(stylist && e.stylist && String(stylist).toLowerCase() !== String(e.stylist).toLowerCase()) return false;
        return overlaps(startIso, endIso, eStart, eEnd);
      });
      if(externalConflict){
        return { ok:false, conflict:true, error:'time conflict with external calendar' };
      }
    }
  }catch{}

  const booking = await createBooking(tenant.id, {
    clientId,
    conversationId,
    service,
    stylist,
    startsAt: startIso,
    durationMin: normalizedDuration,
    price
  });
  return { ok: !!booking?.id, booking };
}

export async function rescheduleBookingSafe({ tenantId, bookingId, newStartsAt }){
  const c = db();
  if(!c) return { ok:false, error:'database not configured' };
  const startIso = toIso(newStartsAt);
  if(!startIso) return { ok:false, error:'invalid datetime' };
  const { data: rows } = await c
    .from('bookings')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('id', bookingId)
    .limit(1);
  const booking = rows?.[0];
  if(!booking) return { ok:false, error:'booking not found' };
  const dur = Number(booking.duration_min || 60);
  const endIso = addMinutes(startIso, dur);
  const dayBookings = await internalBookingsForDay(tenantId, startIso);
  const conflict = dayBookings.find(b => {
    if(b.id === bookingId || String(b.status || '').toLowerCase() === 'cancelled') return false;
    const bStart = toIso(b.starts_at);
    const bEnd = addMinutes(bStart, Number(b.duration_min || 60));
    return overlaps(startIso, endIso, bStart, bEnd);
  });
  if(conflict) return { ok:false, conflict:true, error:'time conflict', conflictBookingId: conflict.id };
  const { data, error } = await c
    .from('bookings')
    .update({ starts_at: startIso, status: 'confirmed' })
    .eq('tenant_id', tenantId)
    .eq('id', bookingId)
    .select()
    .limit(1);
  if(error) return { ok:false, error:error.message };
  return { ok:true, booking: data?.[0] || null };
}

export async function cancelBookingSafe({ tenantId, bookingId }){
  const c = db();
  if(!c) return { ok:false, error:'database not configured' };
  const { data, error } = await c
    .from('bookings')
    .update({ status: 'cancelled' })
    .eq('tenant_id', tenantId)
    .eq('id', bookingId)
    .select()
    .limit(1);
  if(error) return { ok:false, error:error.message };
  return { ok:true, booking: data?.[0] || null };
}
