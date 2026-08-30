/**
 * api/lib/booking-seed.js — make a provisioned tenant immediately bookable.
 * ════════════════════════════════════════════════════════════════
 * The full booking engine (bookings, holds, waitlist, reminders, connectors)
 * exists, but NOTHING in the onboarding/provisioning path ever seeds a
 * tenant's booking configuration. A brand-new tenant gets its Telnyx line,
 * Lola's voice, and the brain wired — yet has zero `booking_settings`,
 * services, staff, schedules, or business hours, so Lola and the widget
 * cannot actually take the first booking. This is owner-facing as "the
 * booking system isn't in place."

 * ensureBookingBaseline() closes that: it idempotently seeds, per tenant:
 *   1. a `booking_settings` row (schema defaults)
 *   2. `services` rows from the owner's stored menu (tenants.services), or a
 *      single default "Consultation" so the catalog is never empty
 *   3. one default `staff` member + a `staff_schedules` week
 *
 * (No `business_hours`/`locations`: availability-engine-v2 builds slots purely
 * from `staff_schedules`, and `locations.organization_id` is an FK to
 * `organizations`, not tenants — seeding it would violate the constraint.)
 *
 * Gate: a tenant is only considered already-bookable when ALL four baseline
 * pieces are present (booking_settings + services + staff + staff_schedules
 * for every staff member). A tenant missing even one piece — for example one
 * that predates the seed and only has a booking_settings row, or one whose
 * staff lost their schedules — is healed on this call rather than sailed past,
 * which is what keeps "bookable-yet-unbookable" tenants from ever arising.
 * Called at provisioning time (both buy + attach) and lazily from the calendar
 * handler, so existing bookless tenants self-heal the first time anyone
 * touches their calendar, booking link, or Lola voice booking.
 */

import { db } from './db.js';

// Default availability week, Monday (1) .. Sunday (0). Sun=0, Mon=1, ... Sat=6.
const WEEK = [1,2,3,4,5,6,0];

// Supabase returns {message} error objects; normalize to a real Error so
// callers always catch a throwable (fail-loud, never a silent {message}).
function reject(err){
  if(err instanceof Error) throw err;
  throw new Error(err?.message || String(err));
}

// Lola's client-facing copy for the fallback service, so a brand-new salon
// never hands a caller an empty menu. The owner renames it in seconds.
function cleanService(s){
  if(!s) return null;
  if(typeof s === 'string'){
    const name = String(s).trim();
    if(!name) return null;
    const m = name.match(/^(.*?)\s*\$?(\d+(?:\.\d{1,2})?)$/);
    return m ? { name: m[1].trim(), price: Number(m[2]), duration: '' } : { name, price: 0, duration: '' };
  }
  const name = String(s.name || '').trim();
  if(!name) return null;
  return { name, price: Number(s.price || 0), duration: String(s.duration || s.dur || '').trim() };
}

/**
 * Idempotent, tenant-scoped booking baseline. Returns a summary; throws only
 * on a real DB error so callers can surface it (fail-loud) rather than the
 * tenant silently staying bookless.
 */
export async function ensureBookingBaseline(tenantId){
  const c = db();
  if(!c) return { seeded: [], skipped: 'no-db' };

  const seeded = [];
  let hasAllPieces = true;

  // Gate: every baseline piece must be present, or we seed the missing ones.
  // booking_settings
  const { data: existingSettings } = await c.from('booking_settings')
    .select('tenant_id').eq('tenant_id', tenantId).maybeSingle();
  if(!existingSettings){
    const { error: settingsErr } = await c.from('booking_settings').insert({ tenant_id: tenantId });
    if(settingsErr) reject(settingsErr);
    seeded.push('booking_settings');
    hasAllPieces = false;
  }

  // services (the owner's stored menu, else one default so the catalog never
  // hands a caller an empty menu).
  const { data: tenant } = await c.from('tenants').select('services,name').eq('id', tenantId).maybeSingle();
  const menu = Array.isArray(tenant?.services) ? tenant.services : [];
  const { count: serviceCount } = await c.from('services')
    .select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId);
  if(!serviceCount){
    const svcs = menu.map(cleanService).filter(Boolean);
    const rows = (svcs.length ? svcs : [{ name: 'Consultation', price: 0, duration: 30 }]).map(s => ({
      tenant_id: tenantId,
      name: s.name,
      description: '',
      duration_minutes: Number(s.duration || 60),
      price: Number(s.price || 0),
      is_active: true
    }));
    // Plain insert (like api/services.js): there is no unique (tenant_id,
    // name) constraint on the live table, so upsert-onConflict would 42P10.
    // Safe because this block only runs when the tenant has zero services.
    const { error: svcErr } = await c.from('services').insert(rows);
    if(svcErr) reject(svcErr);
    seeded.push('services');
    hasAllPieces = false;
  }

  // staff — create one default member if none exist, then ensure EVERY staff
  // member has a full Mon–Sun (09:00–19:00) schedule. A staff member with no
  // schedule (e.g. added after provisioning) would otherwise render the
  // availability engine slotless, so this heals partial/missing schedules too.
  const { data: staffRows } = await c.from('staff')
    .select('id').eq('tenant_id', tenantId);
  let staffIds = (staffRows || []).map(s => s.id);
  if(!staffIds.length){
    const { data: staff, error: staffErr } = await c.from('staff').insert({
      tenant_id: tenantId, name: 'Any available team member', role: 'Stylist', is_active: true
    }).select().single();
    if(staffErr) reject(staffErr);
    staffIds = [staff.id];
    seeded.push('staff');
    hasAllPieces = false;
  }

  if(staffIds.length){
    const { data: schedRows } = await c.from('staff_schedules')
      .select('staff_id,day_of_week').in('staff_id', staffIds);
    const have = new Map();
    for(const r of (schedRows || [])){
      if(!have.has(r.staff_id)) have.set(r.staff_id, new Set());
      have.get(r.staff_id).add(r.day_of_week);
    }
    const rows = [];
    for(const sid of staffIds){
      const days = have.get(sid) || new Set();
      for(const day of WEEK){
        if(!days.has(day)) rows.push({ tenant_id: tenantId, staff_id: sid, day_of_week: day, start_time: '09:00:00', end_time: '19:00:00' });
      }
    }
    if(rows.length){
      const { error: schedErr } = await c.from('staff_schedules').insert(rows);
      if(schedErr) reject(schedErr);
      seeded.push('staff_schedules');
    }
  }

  // A fully bookable tenant (all pieces present) still short-circuits cheaply:
  // nothing was written, so report skipped:'present' for the caller's fast path.
  if(!seeded.length) return { seeded: [], skipped: hasAllPieces ? 'present' : 'partial' };

  return { seeded };
}