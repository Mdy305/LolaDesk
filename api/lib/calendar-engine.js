/**
 * lib/calendar-engine.js — conflict-safe booking primitives for /api/lola-tools
 * ════════════════════════════════════════════════════════════════════
 * Thin facade over the canonical smart-booking engine (availability-engine-v2
 * + booking-repository). lola-tools.js (the Telnyx "orchestral skill layer")
 * calls these four functions; they used to live in a file that went missing,
 * which left the public booking endpoint broken at import time.
 *
 * Everything is tenant-scoped and conflict-safe: an atomic hold is taken
 * before a commit and claimed exactly once, so two callers can't book the same
 * slot. A spoken service that doesn't resolve is NEVER written unchecked — the
 * caller gets { ok:false, error:'service_not_found', menu } to offer the menu.
 */

import { db } from './db.js';
import { bookFromHold, releaseHold, updateCanonicalBooking, listServices } from './booking-repository.js';
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

export async function resolveServiceId(tenantId, service){
  if(!service) return null;
  const c = db(); if(!c) return null;
  const { data } = await c.from('services').select('id').eq('tenant_id', tenantId).ilike('name', `%${String(service)}%`).limit(1);
  return data?.[0]?.id || null;
}

export async function resolveStaffId(tenantId, stylist){
  if(!stylist) return null;
  const c = db(); if(!c) return null;
  const { data } = await c.from('staff').select('id').eq('tenant_id', tenantId).ilike('name', `%${String(stylist)}%`).limit(1);
  return data?.[0]?.id || null;
}

// ISO slots for a service/day. Canonical when the services table has rows;
// a best-effort afternoon spread otherwise.
export async function listAvailability({ tenant, date, durationMin = 60, stylist = null, service = null }){
  const tenantId = tenant?.id;
  if(tenantId){
    try{
      const c = db();
      if(c){
        // The service the caller actually asked for (not just the first one).
        const wanted = service ? await resolveServiceId(tenantId, service) : null;
        const { data: services } = wanted ? { data: [{ id: wanted }] } : await c.from('services').select('id').eq('tenant_id', tenantId).eq('is_active', true).limit(1);
        if(services?.length){
          const staffId = stylist ? await resolveStaffId(tenantId, stylist) : null;
          const av = await getAvailability({ tenantId, serviceId: services[0].id, date: date || new Date().toISOString(), staffId, limit: 2000 });
          // One entry per time: two stylists free at 11:00 is one option, not "11, 11, 11:30".
          const times = [...new Set((av.slots || []).map(s => new Date(s.starts_at).toISOString()))].slice(0, 12);
          if(av.ok && times.length) return { slots: times };
        }
      }
    }catch(e){ /* no invented times */ }
  }
  // Never invent openings (it used to offer made-up UTC times).
  return { slots: [] };
}


// The salon's real menu, for "which service did you mean?".
async function serviceMenu(tenant){
  try{
    const rows = await listServices(tenant.id);
    if(rows.length) return rows.map(x => x.name).filter(Boolean).slice(0, 12);
  }catch(_){}
  try{
    const list = Array.isArray(tenant.services) ? tenant.services : (typeof tenant.services === 'string' ? JSON.parse(tenant.services) : []);
    return (list || []).map(x => typeof x === 'string' ? x : x?.name).filter(Boolean).slice(0, 12);
  }catch(_){ return []; }
}

/**
 * Options (for lola-tools):
 *   sendConfirmation:false — no confirmation text and no deposit request for this row
 *                            (e.g. an add-on segment confirmed with its main booking)
 *   skipDeposit:true       — confirmation text yes, deposit request no
 *   notes, source          — stored on the booking
 */
export async function createBookingSafe({ tenant, clientId = null, service, stylist = null, startsAt, durationMin = 60, price = 0, sendConfirmation = true, skipDeposit = false, notes = null, source = 'lola_tools' }){
  try{
    const tenantId = tenant?.id;
    if(!tenantId) return { ok: false, error: 'tenant_required' };
    const startIso = new Date(startsAt).toISOString();
    const serviceId = await resolveServiceId(tenantId, service);
    // Never write a booking the engine hasn't checked: no resolved service →
    // no conflict check possible → offer the real menu instead.
    if(!serviceId) return { ok: false, error: 'service_not_found', menu: await serviceMenu(tenant) };
    let staffId = await resolveStaffId(tenantId, stylist);
    // No stylist named: take whoever is free at that exact time — never
    // write a booking without a conflict check.
    if(!staffId){
      // The client's usual stylist if free, else whoever's day this time packs best (no dead holes).
      try{ const { bestStaffAt } = await import('./smart-slots.js'); staffId = (await bestStaffAt({ tenantId, serviceId, startsAt: startIso, clientId }))?.staff_id || null; }catch(_){ staffId = null; }
      if(!staffId){
        const av = await getAvailability({ tenantId, serviceId, date: startIso, limit: 500 });
        staffId = (av.slots || []).find(x => new Date(x.starts_at).getTime() === new Date(startIso).getTime())?.staff_id || null;
      }
      if(!staffId) return { ok: false, conflict: true, error: 'slot_unavailable' };
    }

    const held = await holdAvailability({ tenantId, clientId, serviceId, staffId, startsAt: startIso, channel: 'lola_tools', ttlSeconds: 120 });
    if(!held.ok) return { ok: false, conflict: true, error: held.error || 'slot_unavailable' };

    const r = await bookFromHold(tenantId, held.hold, {
      clientId, serviceId, staffId,
      startTime: held.slot.starts_at, endTime: held.slot.ends_at,
      status: 'confirmed', totalAmount: Number(price || 0), source, notes,
      sendConfirmation, skipDeposit
    });
    if(!r.ok) return { ok: false, conflict: true, error: r.error || 'slot_unavailable' };
    return { ok: true, booking: r.booking };
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
    // A moved booking keeps its REAL length (multi-service / long visits).
    const lenMin = current.end_time ? Math.round((new Date(current.end_time) - new Date(current.start_time)) / 60000) : null;

    if(current.service_id && current.staff_id){
      const held = await holdAvailability({ tenantId, clientId: current.client_id, serviceId: current.service_id, staffId: current.staff_id, startsAt: startIso, channel: 'lola_tools', ttlSeconds: 120, excludeBookingId: current.id, minDurationMin: lenMin });
      if(!held.ok) return { ok: false, conflict: true, booking: current };
      // (starts_at is a generated column — writing it made every voice reschedule fail.)
      const patch = { start_time: held.slot.starts_at, end_time: held.slot.ends_at };
      const booking = await updateCanonicalBooking(tenantId, bookingId, patch, { source: 'lola_tools', reason: 'rescheduled' });
      await releaseHold(tenantId, held.hold.hold_token, 'converted');
      return { ok: true, booking };
    }

    // Legacy row without canonical ids: no engine check is possible; move it
    // keeping its length, through the canonical update (history, text, upstream).
    const patch = { start_time: startIso, ...(lenMin ? { end_time: new Date(new Date(startIso).getTime() + lenMin * 60000).toISOString() } : {}) };
    const booking = await updateCanonicalBooking(tenantId, bookingId, patch, { source: 'lola_tools', reason: 'rescheduled' });
    return booking ? { ok: true, booking } : { ok: false, error: 'booking_not_found' };
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
