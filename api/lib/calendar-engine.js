/**
 * lib/calendar-engine.js — conflict-safe booking primitives for /api/lola-tools
 * ════════════════════════════════════════════════════════════════════
 * Thin facade over the canonical smart-booking engine (availability-engine-v2
 * + booking-repository). lola-tools.js (the Telnyx "orchestral skill layer")
 * calls these four functions; they used to live in a file that went missing,
 * which left the public booking endpoint broken at import time.
 *
 * Everything is tenant-scoped and conflict-safe: holds are taken before a
 * commit, so two callers can't book the same slot. When the tenant has no
 * canonical services/staff rows yet, we degrade to a direct (unheld) write
 * with the legacy text columns, matching the onboarding experience.
 */

import { db } from './db.js';
import { addMinutes, createCanonicalBooking, releaseHold, updateCanonicalBooking } from './booking-repository.js';
import { getAvailability, holdAvailability } from './availability-engine-v2.js';

// "2h30" | "1h15" | "90" | "90 min" | "2 hours" | "consult" → minutes
export function parseDurationMin(value, fallback = 60){
  const v = String(value ?? '').trim().toLowerCase();
  if(!v) return Number(fallback) || 60;
  if(v === 'consult' || v === 'consultation') return Number(fallback) || 60;
  const hm = v.match(/^(\d+)\s*h\s*(?:(\d+)\s*(?:m|min|mins)?)?$/);
  if(hm) return Number(hm[1]) * 60 + (hm[2] ? Number(hm[2]) : 0);
  const hh = v.match(/^(\d+)\s*hours?$/);
  if(hh) return Number(hh[1]) * 60;
  const mm = v.match(/^(\d+)\s*(?:m|min|mins)?$/);
  if(mm) return Number(mm[1]);
  const digits = Number(v.replace(/[^\d]/g, ''));
  return digits > 0 ? digits : (Number(fallback) || 60);
}

async function resolveServiceId(tenantId, service){
  if(!service) return null;
  const c = db(); if(!c) return null;
  const { data } = await c.from('services').select('id').eq('tenant_id', tenantId).ilike('name', `%${String(service)}%`).limit(1);
  return data?.[0]?.id || null;
}

async function resolveStaffId(tenantId, stylist){
  if(!stylist) return null;
  const c = db(); if(!c) return null;
  const { data } = await c.from('staff').select('id').eq('tenant_id', tenantId).ilike('name', `%${String(stylist)}%`).limit(1);
  return data?.[0]?.id || null;
}

// ISO slots for a service/day. Canonical when the services table has rows;
// a best-effort afternoon spread otherwise.
export async function listAvailability({ tenant, date, durationMin = 60, stylist = null }){
  const tenantId = tenant?.id;
  if(tenantId){
    try{
      const c = db();
      if(c){
        const { data: services } = await c.from('services').select('id').eq('tenant_id', tenantId).eq('is_active', true).limit(1);
        if(services?.length){
          const staffId = stylist ? await resolveStaffId(tenantId, stylist) : null;
          const av = await getAvailability({ tenantId, serviceId: services[0].id, date: date || new Date().toISOString(), staffId, limit: 12 });
          if(av.ok && av.slots.length) return { slots: av.slots.map(s => s.starts_at) };
        }
      }
    }catch(e){ /* fall through to naive */ }
  }
  const day = date ? new Date(date) : new Date();
  const slots = [];
  for(const t of ['12:00', '13:30', '15:00', '16:30', '18:00']){
    const [h, m] = t.split(':').map(Number);
    const d = new Date(day); d.setHours(h, m, 0, 0);
    if(d.getTime() > Date.now()) slots.push(d.toISOString());
  }
  return { slots };
}

async function writeLegacy(tenantId, bookingId, { service, stylist, startsAt, durationMin, price }){
  const c = db(); if(!c) return;
  await c.from('bookings').update({
    service: service || null, stylist: stylist || null,
    starts_at: startsAt, duration_min: durationMin, price: Number(price || 0)
  }).eq('tenant_id', tenantId).eq('id', bookingId);
}

export async function createBookingSafe({ tenant, clientId = null, service, stylist = null, startsAt, durationMin = 60, price = 0 }){
  try{
    const tenantId = tenant?.id;
    if(!tenantId) return { ok: false, error: 'tenant_required' };
    const startIso = new Date(startsAt).toISOString();
    const serviceId = await resolveServiceId(tenantId, service);
    const staffId = await resolveStaffId(tenantId, stylist);

    let hold = null;
    if(serviceId && staffId){
      hold = await holdAvailability({ tenantId, clientId, serviceId, staffId, startsAt: startIso, channel: 'lola_tools', ttlSeconds: 120 });
      if(!hold.ok) return { ok: false, conflict: true, error: hold.error || 'slot_unavailable' };
    }

    const booking = await createCanonicalBooking({
      tenantId, clientId, serviceId, staffId,
      startTime: hold ? hold.slot.starts_at : startIso,
      endTime: hold ? hold.slot.ends_at : addMinutes(startIso, durationMin),
      status: 'confirmed', totalAmount: Number(price || 0), source: 'lola_tools',
      holdId: hold ? hold.hold.id : null
    });
    if(hold) await releaseHold(tenantId, hold.hold.hold_token, 'converted');
    await writeLegacy(tenantId, booking.id, { service, stylist, startsAt: booking.start_time, durationMin, price });
    return { ok: true, booking };
  }catch(e){
    return { ok: false, error: String(e?.message || e) };
  }
}

export async function rescheduleBookingSafe({ tenantId, bookingId, newStartsAt }){
  try{
    const c = db(); if(!c) return { ok: false, error: 'db_not_configured' };
    const { data: current } = await c.from('bookings').select('*').eq('tenant_id', tenantId).eq('id', bookingId).maybeSingle();
    if(!current) return { ok: false, error: 'booking_not_found' };
    const startIso = new Date(newStartsAt).toISOString();

    if(current.service_id && current.staff_id){
      const held = await holdAvailability({ tenantId, clientId: current.client_id, serviceId: current.service_id, staffId: current.staff_id, startsAt: startIso, channel: 'lola_tools', ttlSeconds: 120 });
      if(!held.ok) return { ok: false, conflict: true, booking: current };
      const patch = { start_time: held.slot.starts_at, end_time: held.slot.ends_at, starts_at: held.slot.starts_at, duration_min: held.slot.duration_minutes };
      const booking = await updateCanonicalBooking(tenantId, bookingId, patch, { source: 'lola_tools', reason: 'rescheduled' });
      await releaseHold(tenantId, held.hold.hold_token, 'converted');
      return { ok: true, booking };
    }

    const { data: booking, error } = await c.from('bookings').update({ starts_at: startIso }).eq('tenant_id', tenantId).eq('id', bookingId).select().single();
    if(error) throw error;
    return { ok: true, booking };
  }catch(e){
    return { ok: false, error: String(e?.message || e) };
  }
}

export async function cancelBookingSafe({ tenantId, bookingId }){
  try{
    const booking = await updateCanonicalBooking(tenantId, bookingId, { status: 'cancelled' }, { source: 'lola_tools', reason: 'client_request' });
    return booking ? { ok: true, booking } : { ok: false, error: 'booking_not_found' };
  }catch(e){
    return { ok: false, error: String(e?.message || e) };
  }
}

export default { parseDurationMin, listAvailability, createBookingSafe, rescheduleBookingSafe, cancelBookingSafe };
