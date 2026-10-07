/**
 * api/lib/gap-fill-booking.js — book a "fill the gap" yes, exactly once.
 * ════════════════════════════════════════════════════════════════════════════
 * Gap-fill calls/texts go to several clients for ONE open slot. Each "yes"
 * calls bookGapFillSlot: the slot is taken with the same atomic hold every
 * booking uses (createHoldAtomic → Postgres lola_take_hold, or insert +
 * re-check), and the hold is claimed into exactly one booking. The first yes
 * wins; every later yes gets { ok:false, taken:true } → put them on the
 * waitlist and tell them kindly.
 *
 *   bookGapFillSlot({ tenantId, clientId, startsAt, durationMin, serviceId, staffId,
 *                     stylist, source, notes, sendConfirmation })
 *   → { ok:true, booking } | { ok:false, taken:true } | { ok:false, error }
 */
import { createHoldAtomic, bookFromHold, listServices, addMinutes } from './booking-repository.js';
import { holdAvailability } from './availability-engine-v2.js';
import { resolveStaffId } from './calendar-engine.js';

export async function bookGapFillSlot({ tenantId, clientId, startsAt, durationMin = 60, serviceId = null, staffId = null, stylist = null,
  source = 'lola_gap_fill', notes = null, sendConfirmation = true } = {}){
  try{
    if(!tenantId || !clientId || !startsAt) return { ok: false, error: 'tenant_client_and_start_required' };
    const start = new Date(startsAt);
    if(Number.isNaN(start.getTime())) return { ok: false, error: 'invalid_start' };
    const startIso = start.toISOString();
    const minutes = Math.max(5, Number(durationMin) || 60);
    if(!staffId && stylist) staffId = await resolveStaffId(tenantId, stylist).catch(() => null);

    let held = null, price = 0;
    if(serviceId && staffId){
      // The full engine (shift, buffers, time off, blocks, the salon platform's
      // own appointments), then the atomic take — the gap's real length kept.
      const r = await holdAvailability({ tenantId, clientId, serviceId, staffId, startsAt: startIso, channel: 'gap_fill', ttlSeconds: 120, minDurationMin: minutes });
      if(!r.ok) return { ok: false, taken: true };
      held = { hold: r.hold, start: r.slot.starts_at, end: r.slot.ends_at };
      price = Number(r.slot.price ?? 0) || 0;
    } else {
      // No catalog ids for the gap: lock the stylist's (or the unassigned) lane
      // for exactly this window. Any booking already there = taken.
      const endIso = addMinutes(startIso, minutes);
      const r = await createHoldAtomic({ tenantId, clientId, staffId: staffId || null, serviceId: serviceId || null, startsAt: startIso, endsAt: endIso,
        channel: 'gap_fill', ttlSeconds: 120, seenBookingIds: [] });
      if(!r.ok) return { ok: false, taken: true };
      held = { hold: r.hold, start: startIso, end: endIso };
      if(serviceId){ try{ price = Number((await listServices(tenantId)).find(s => s.id === serviceId)?.price || 0); }catch(_){} }
    }

    const made = await bookFromHold(tenantId, held.hold, {
      clientId, serviceId: serviceId || null, staffId: staffId || null,
      startTime: held.start, endTime: held.end, status: 'confirmed', totalAmount: price,
      source, notes, sendConfirmation
    });
    if(!made.ok) return { ok: false, taken: true };
    return { ok: true, booking: made.booking };
  }catch(e){
    return { ok: false, error: String(e?.message || e) };
  }
}

export default { bookGapFillSlot };
