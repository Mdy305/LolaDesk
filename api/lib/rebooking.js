/**
 * api/lib/rebooking.js — the auto-rebooking loop (Loop #3).
 *
 * When a visit is completed, the client gets ONE text: same service, the
 * service's usual refresh interval out, with one concrete proposed slot from
 * the real availability engine (buffers, staff schedules, blocked time all
 * apply). If that slot has since filled, the hourly sweep advances to the
 * next open slot and re-texts once. If the offer window passes with no
 * booking, it expires with one gentle nudge. When the client books the same
 * service, the sweep marks the offer `booked`.
 *
 * Policy lives in booking_settings.metadata.rebooking (no migration —
 * `metadata` is already the writable channel, same as deposits):
 *   { enabled: bool, interval_days: >=0, window_days: >=1 }
 * Money moves nowhere: the offer is a text; acceptance is the client
 * booking through the normal path (dashboard, public calendar, voice).
 */

import { db } from './db.js';
import { ensureMigrations } from './migrate.js';
import { sendSMS } from './sms.js';
import { getAvailability } from './availability-engine-v2.js';
import { rebookingOfferText, rebookingExpiredText } from './lola-persona.js';

export const REBOOK_DEFAULTS = Object.freeze({ interval_days: 42, window_days: 7 });

// Parse the salon's policy from booking_settings.metadata.rebooking,
// tolerating bad types. Returns null when rebooking offers are off.
export function resolvePolicy(settings){
  const raw = settings && settings.metadata && settings.metadata.rebooking;
  if(!raw || raw.enabled !== true) return null;
  const interval = Math.round(Number(raw.interval_days));
  const windowDays = Math.round(Number(raw.window_days));
  return {
    enabled: true,
    interval_days: Number.isFinite(interval) && interval >= 0 ? interval : REBOOK_DEFAULTS.interval_days,
    window_days: Number.isFinite(windowDays) && windowDays >= 1 ? Math.min(60, windowDays) : REBOOK_DEFAULTS.window_days
  };
}

// Target date for the refresh: the completed appointment + interval_days.
// Zero/negative interval means "next day" (a client in daily for treatment).
export function computeTargetDate(completedAt, intervalDays){
  const t = new Date(completedAt).getTime();
  if(Number.isNaN(t)) return null;
  const days = Math.max(1, Math.round(Number(intervalDays) || REBOOK_DEFAULTS.interval_days));
  return new Date(t + days * 86400000);
}

const fmtWhen = (iso) => new Date(iso).toLocaleString('en-US', {
  weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
});

// Send the offer for a completed booking. Never throws — a failed offer must
// never fail the status change that triggered it. Injectable deps for tests.
export async function offerRebooking({ tenantId, booking, policy = null, send = sendSMS, availability = getAvailability } = {}){
  ensureMigrations(); // memoized self-heal of rebooking_offers, non-fatal
  const c = db();
  if(!c) return { ok: false, skipped: true, reason: 'no_db' };
  if(!policy){
    const { data: s } = await c.from('booking_settings').select('metadata').eq('tenant_id', tenantId).maybeSingle();
    policy = resolvePolicy(s);
  }
  if(!policy || policy.enabled !== true) return { ok: true, skipped: true, reason: 'policy_off' };
  if(!booking?.id || !booking.completed_at) return { ok: true, skipped: true, reason: 'no_completion' };
  if(!booking.client_id) return { ok: true, skipped: true, reason: 'no_client' };
  if(!booking.service_id) return { ok: true, skipped: true, reason: 'no_service' };

  // Exactly-once per booking (idempotent completion double-writes).
  const { data: existing } = await c.from('rebooking_offers').select('id').eq('tenant_id', tenantId).eq('booking_id', booking.id).limit(1);
  if(existing && existing.length) return { ok: true, skipped: true, reason: 'already_offered' };

  const target = computeTargetDate(booking.completed_at, policy.interval_days);

  try{
    // One concrete slot from the real engine on the target date. Slots in the
    // past (short interval + late day) are skipped by the engine's minimum
    // notice; if the whole day comes back empty the sweep advances the offer
    // day by day within the window.
    const proposed = await proposeSlot({ tenantId, booking, target, availability });
    if(!proposed) return { ok: true, skipped: true, reason: 'no_slots_in_window' };
    const [{ data: tenant }, { data: client }] = await Promise.all([
      c.from('tenants').select('name,phone_number').eq('id', tenantId).maybeSingle(),
      c.from('clients').select('id,name,phone').eq('id', booking.client_id).maybeSingle()
    ]);
    if(!client?.phone) return { ok: true, skipped: true, reason: 'no_client_phone' };
    if(!tenant?.phone_number) return { ok: true, skipped: true, reason: 'no_from_number' };

    const { data: offer, error } = await c.from('rebooking_offers').insert({
      tenant_id: tenantId,
      booking_id: booking.id,
      client_id: booking.client_id,
      service_id: booking.service_id,
      staff_id: proposed.staff_id || null,
      proposed_start: proposed.starts_at,
      // The offer lives until the proposed slot + window: it must outlive
      // the date it proposes (interval 42d > window 7d is the normal case).
      window_end: new Date(new Date(proposed.starts_at).getTime() + policy.window_days * 86400000),
      status: 'offered'
    }).select().maybeSingle();
    if(error) throw error;

    await send({
      from: tenant.phone_number, to: client.phone, tenantId, type: 'SMS',
      text: rebookingOfferText({
        firstName: client.name, salon: tenant.name, serviceName: proposed.service_name,
        when: fmtWhen(proposed.starts_at), staffName: proposed.staff_name
      })
    }).catch(() => {}); // a failed text never fails the completion
    return { ok: true, offer, proposed_start: proposed.starts_at };
  }catch(e){
    return { ok: false, reason: String(e?.message || e) };
  }
}

// First open slot on the target date for this service (prefers the staff who
// just served the client). The engine enforces schedules, blocked time,
// buffers, holds and minimum notice — the offer never proposes a ghost slot.
async function proposeSlot({ tenantId, booking, target, availability }){
  const d = target.toISOString().slice(0, 10);
  for(const staffId of booking.staff_id ? [booking.staff_id, null] : [null]){
    const r = await availability({ tenantId, serviceId: booking.service_id, date: d, staffId, limit: 3 });
    if(r && r.ok && (r.slots || []).length) return r.slots[0];
  }
  return null;
}

// Acceptance signal, fired from the booking-creation seam (booking-repository
// createCanonicalBooking, via dynamic import to avoid a static cycle through
// the availability engine): the moment the client books this service again,
// every open offer for them flips to `booked`. Deterministic and instant —
// the sweep never has to scan future bookings to guess acceptance.
export async function markRebookingAccepted({ tenantId, clientId, serviceId } = {}){
  const c = db();
  if(!c || !tenantId || !clientId || !serviceId) return 0;
  try{
    for(const status of ['offered', 'advanced']){
      const { data } = await c.from('rebooking_offers').update({ status: 'booked', updated_at: new Date().toISOString() })
        .eq('tenant_id', tenantId).eq('client_id', clientId).eq('service_id', serviceId).eq('status', status).select();
      if(data && data.length) return data.length;
    }
  }catch{ /* an offer-bookkeeping miss never fails the booking */ }
  return 0;
}

// Hourly sweep (cron/rebooking). Each row is claimed with a status-conditional
// update BEFORE acting, so overlapping cron ticks can never double-text.
// Sends are injectable for tests; individual failures never abort the run.
export async function runRebookingSweep(now = new Date(), { send = sendSMS, availability = getAvailability } = {}){
  const migrations = await ensureMigrations(); // awaited: cold start must not race its DDL
  const c = db();
  if(!c) throw new Error('database not configured');
  const result = { migrations, checked: 0, advanced: 0, expired: 0, retexted: 0, failed: 0, skipped: 0 };

  const { data: offers } = await c.from('rebooking_offers')
    .select('id,tenant_id,booking_id,client_id,service_id,staff_id,proposed_start,window_end,status,advanced_count,last_texted_at,created_at')
    .in('status', ['offered', 'advanced']).order('created_at').limit(200);
  if(!offers || !offers.length) return result;

  const bookingIds = [...new Set(offers.map(o => o.booking_id).filter(Boolean))];
  const { data: bookings } = bookingIds.length
    ? await c.from('bookings').select('id,status,start_time,client_id,service_id,staff_id,completed_at').in('id', bookingIds) : { data: [] };
  const bMap = Object.fromEntries((bookings || []).map(b => [b.id, b]));

  for(const o of offers){
    result.checked++;
    const b = bMap[o.booking_id];
    const status = String(b?.status || '').toLowerCase();

    // The completed booking was cancelled/undone after the offer: expire quietly.
    if(['cancelled', 'canceled', 'no_show'].includes(status)){
      if(await claim(c, o.id, 'expired', o.status)) result.expired++; else result.skipped++;
      continue;
    }

    // Window closed with no booking: one gentle nudge, then done.
    if(now.getTime() > new Date(o.window_end).getTime()){
      const claimed = await claim(c, o.id, 'expiring', o.status);
      if(!claimed) continue;
      try{
        const [{ data: tenant }, { data: client }, { data: svc }] = await Promise.all([
          c.from('tenants').select('name,phone_number').eq('id', o.tenant_id).maybeSingle(),
          c.from('clients').select('name,phone').eq('id', o.client_id).maybeSingle(),
          c.from('services').select('name').eq('id', o.service_id).maybeSingle()
        ]);
        if(tenant?.phone_number && client?.phone){
          await send({
            from: tenant.phone_number, to: client.phone, tenantId: o.tenant_id, type: 'SMS',
            text: rebookingExpiredText({ firstName: client.name, salon: tenant.name, serviceName: svc?.name })
          }).catch(() => {});
          result.retexted++;
        }
        await claim(c, o.id, 'expired', 'expiring');
        result.expired++;
      }catch(e){ result.failed++; }
      continue;
    }

    // Proposed slot already taken (or taken and the re-text failed last tick):
    // advance to the next open day inside the window, re-text once per advance.
    if(o.proposed_start && new Date(o.proposed_start).getTime() <= now.getTime()){
      const policy = await (async () => {
        const { data: s } = await c.from('booking_settings').select('metadata').eq('tenant_id', o.tenant_id).maybeSingle();
        return resolvePolicy(s);
      })();
      if(!policy) continue;
      const advanced = (Number(o.advanced_count) || 0) + 1;
      if(advanced > policy.window_days){
        // Every day of the window was full — expire quietly, no nudge text.
        if(await claim(c, o.id, 'expired', o.status)) result.expired++;
        continue;
      }
      // Keep the cadence: completed_at + interval + advanced days.
      const target = computeTargetDate(b?.completed_at || o.created_at, policy.interval_days + advanced - 1);
      if(!target){ result.skipped++; continue; } // booking row vanished mid-flight
      let slot = null;
      try{ slot = await proposeSlot({ tenantId: o.tenant_id, booking: b || { service_id: o.service_id, client_id: o.client_id, staff_id: o.staff_id }, target, availability }); }
      catch{ /* engine miss — try again next tick */ }
      if(!slot) continue;
      const claimed = await claim(c, o.id, 'advancing', o.status);
      if(!claimed) continue;
      const { error } = await c.from('rebooking_offers').update({
        proposed_start: slot.starts_at, staff_id: slot.staff_id || o.staff_id || null,
        window_end: new Date(new Date(slot.starts_at).getTime() + policy.window_days * 86400000),
        advanced_count: advanced, last_texted_at: now.toISOString(), status: 'advanced'
      }).eq('id', o.id);
      if(error){ result.failed++; await claim(c, o.id, o.status, 'advancing'); continue; }
      try{
        const [{ data: tenant }, { data: client }] = await Promise.all([
          c.from('tenants').select('name,phone_number').eq('id', o.tenant_id).maybeSingle(),
          c.from('clients').select('name,phone').eq('id', o.client_id).maybeSingle()
        ]);
        if(tenant?.phone_number && client?.phone){
          await send({
            from: tenant.phone_number, to: client.phone, tenantId: o.tenant_id, type: 'SMS',
            text: rebookingOfferText({
              firstName: client.name, salon: tenant.name, serviceName: slot.service_name,
              when: fmtWhen(slot.starts_at), staffName: slot.staff_name
            })
          }).catch(() => {});
          result.retexted++;
        }
        result.advanced++;
      }catch(e){ result.failed++; }
    }
  }
  return result;
}

// Status-conditional claim (same contract as deposits' setDepositStatus):
// returns the row only when it still had the expected status.
async function claim(c, id, status, expected){
  const { data, error } = await c.from('rebooking_offers').update({ status }).eq('id', id).eq('status', expected).select().maybeSingle();
  return error ? null : data;
}
