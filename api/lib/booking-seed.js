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
 *   4. a primary `location` + `business_hours` week
 *
 * It is gated on a single cheap PK-equality read: if the tenant already has
 * a `booking_settings` row it is considered bookable and returns immediately
 * (no re-checking of every table on every request). Called at provisioning
 * time (both buy + attach) and lazily from the calendar handler, so existing
 * bookless tenants self-heal the first time anyone touches their calendar,
 * booking link, or Lola voice booking.
 */

import { db } from './db.js';

// Default open hours, Monday (1) .. Sunday (0). Sun=0, Mon=1, ... Sat=6.
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

  // Cheap gate: a tenant with booking_settings is already bookable. This is
  // the ONLY read on the hot path, so a healthy tenant pays one PK-equality
  // select per request and returns immediately.
  const { data: existingSettings } = await c.from('booking_settings')
    .select('tenant_id').eq('tenant_id', tenantId).maybeSingle();
  if(existingSettings) return { seeded: [], skipped: 'present' };

  const seeded = [];

  // 1. booking_settings (schema defaults).
  const { error: settingsErr } = await c.from('booking_settings').insert({ tenant_id: tenantId });
  if(settingsErr) reject(settingsErr);
  seeded.push('booking_settings');

  // 2. Services from the owner's stored menu, else one default.
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
    const { error: svcErr } = await c.from('services').upsert(rows, { onConflict: 'tenant_id,name' });
    if(svcErr) reject(svcErr);
    seeded.push('services');
  }

  // 3. One default staff member + a Mon–Sun schedule (09:00–19:00).
  const { count: staffCount } = await c.from('staff')
    .select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId);
  if(!staffCount){
    const { data: staff, error: staffErr } = await c.from('staff').insert({
      tenant_id: tenantId, name: 'Any available team member', role: 'Stylist', is_active: true
    }).select().single();
    if(staffErr) reject(staffErr);
    await c.from('staff_schedules').insert(WEEK.map(day => ({
      tenant_id: tenantId, staff_id: staff.id, day_of_week: day, start_time: '09:00:00', end_time: '19:00:00'
    })));
    seeded.push('staff', 'staff_schedules');
  }

  // 4. Primary location + a business_hours week (availability needs a timezone + hours).
  const { data: locs } = await c.from('locations').select('id,is_primary').eq('organization_id', tenantId);
  const primary = (locs || []).find(l => l.is_primary) || (locs || [])[0];
  if(!primary){
    const { data: loc, error: locErr } = await c.from('locations').insert({
      organization_id: tenantId, name: tenant?.name || 'Main location', timezone: 'America/New_York', is_primary: true
    }).select().single();
    if(locErr) reject(locErr);
    await c.from('business_hours').insert(WEEK.map(day => ({
      location_id: loc.id, day_of_week: day, open_time: '09:00:00', close_time: '19:00:00', is_closed: false
    })));
    seeded.push('location', 'business_hours');
  }

  return { seeded };
}