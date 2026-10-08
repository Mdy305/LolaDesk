/**
 * api/lib/booking-readiness.js — "is this salon's booking page live?"
 * ════════════════════════════════════════════════════════════════
 * One honest answer, read from the same tables the availability engine
 * reads, for a salon with NO booking software of its own:
 *
 *   hours        the salon's opening hours were set (booking-settings)
 *   services     at least one active service with a length and a price
 *   staff        at least one real team member (not the day-one stand-in)
 *   staff_hours  every team member has weekly hours, and every priced
 *                service has someone with hours who can take it
 *   online       public online booking is switched on
 *
 * → { ready, steps:[{id,done,label,detail,href}], next, booking_url }
 *
 * bookingReadiness() first runs ensureBookingBaseline (booking_settings
 * defaults exist, stylists without hours get the salon's, the stand-in steps
 * aside) — it only ever fills what is missing, never what an owner set.
 */
import { db } from './db.js';
import { ensureBookingBaseline, PLACEHOLDER_STAFF } from './booking-seed.js';
import { getBookingSettings } from './booking-repository.js';
import { staffForService } from './availability-engine-v2.js';
import { lolaBookingPage } from './booking-link.js';
import { salonWeekRows, workingRows } from './setup-store.js';

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const DEFAULT_SIG = JSON.stringify(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, '10:00', '20:00', d === 'sun']));

/** The owner set opening hours (saved them, or they differ from the untouched default). */
export function hoursSet(settings) {
  const md = isObj(settings?.metadata) ? settings.metadata : {};
  if (!salonWeekRows(settings)) return false;            // none, or closed every day
  if (md.hours_confirmed_at) return true;
  const bh = isObj(settings?.business_hours) ? settings.business_hours : md.business_hours;
  const sig = JSON.stringify(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, String(bh?.[d]?.open || '').slice(0, 5), String(bh?.[d]?.close || '').slice(0, 5), bh?.[d]?.closed === true]));
  return sig !== DEFAULT_SIG;
}

function minutesOf(s) {
  const a1 = Number(s?.active_duration_1_min || 0), p = Number(s?.processing_duration_min || 0), a2 = Number(s?.active_duration_2_min || 0);
  return (a1 || p || a2) ? a1 + p + a2 : Number(s?.duration_minutes || 0);
}
const activeRow = (r) => r && r.is_active !== false && r.active !== false;

/** A service a client can book: active, not an add-on, with a length and a price. */
export function bookableService(s) {
  return activeRow(s) && s.is_addon !== true && minutesOf(s) > 0 && Number(s.price) > 0;
}

/** Pure: the readiness answer from already-loaded rows (unit-testable). */
export function readinessFrom({ tenant, settings, services = [], staff = [], schedules = [], links = [] }) {
  const priced = services.filter(bookableService);
  const team = staff.filter((m) => activeRow(m) && m.name !== PLACEHOLDER_STAFF);
  const withHours = new Set(team.filter((m) => workingRows(schedules.filter((r) => r.staff_id === m.id)).length).map((m) => m.id));
  const noHours = team.filter((m) => !withHours.has(m.id));
  const activeIds = new Set(services.filter(activeRow).map((s) => s.id));
  const nobody = priced.filter((s) => !staffForService({ staff: team, links, serviceId: s.id, activeServiceIds: activeIds, allowAny: settings?.allow_any_staff !== false })
    .staff.some((m) => withHours.has(m.id)));
  const first = (m) => String(m?.name || '').trim().split(/\s+/)[0] || 'A team member';
  const list = (arr, f) => arr.length === 1 ? f(arr[0]) : `${f(arr[0])} and ${arr.length - 1} more`;

  const steps = [
    { id: 'hours', done: hoursSet(settings), label: 'Opening hours', href: '/booking-settings',
      detail: hoursSet(settings) ? '' : 'Set the days and times you’re open.' },
    { id: 'services', done: priced.length > 0, label: 'Services and prices', href: '/services',
      detail: priced.length ? `${priced.length} bookable` : 'Add a service with its length and price.' },
    { id: 'staff', done: team.length > 0, label: 'Your team', href: '/team',
      detail: team.length ? `${team.length} ${team.length === 1 ? 'person' : 'people'}` : 'Add yourself and anyone who takes clients.' },
    { id: 'staff_hours', done: team.length > 0 && !noHours.length && priced.length > 0 && !nobody.length, label: 'Team hours and services', href: '/team',
      detail: !team.length ? 'Comes after your team.'
        : noHours.length ? `${list(noHours, (m) => first(m))} ${noHours.length === 1 ? 'has' : 'have'} no weekly hours.`
        : nobody.length ? `Nobody takes ${list(nobody, (s) => s.name)} yet.`
        : priced.length ? '' : 'Comes after your services.' },
    { id: 'online', done: settings?.public_booking_enabled !== false, label: 'Online booking on', href: '/settings#booking',
      detail: settings?.public_booking_enabled === false ? 'Turn on public online booking.' : '' }
  ];
  const ready = steps.every((s) => s.done);
  return { ready, steps, next: steps.find((s) => !s.done)?.id || null, booking_url: lolaBookingPage(tenant) };
}

/** Readiness for one salon (tenant row or id). Tenant-scoped reads only. */
export async function bookingReadiness(tenantOrId) {
  const c = db();
  const tenantId = typeof tenantOrId === 'object' ? tenantOrId?.id : tenantOrId;
  if (!c || !tenantId) return { ready: false, steps: [], next: null, booking_url: '' };
  try { await ensureBookingBaseline(tenantId); } catch (e) { console.warn('[booking-readiness] baseline', e?.message || e); }
  let tenant = typeof tenantOrId === 'object' ? tenantOrId : null;
  if (!tenant) ({ data: tenant } = await c.from('tenants').select('id,slug,name').eq('id', tenantId).maybeSingle());
  const [settings, svc, stf, sch] = await Promise.all([
    getBookingSettings(tenantId),
    c.from('services').select('*').eq('tenant_id', tenantId),
    c.from('staff').select('*').eq('tenant_id', tenantId),
    c.from('staff_schedules').select('*').eq('tenant_id', tenantId)
  ]);
  const staff = stf.data || [];
  let links = [];
  if (staff.length) {
    const l = await c.from('staff_services').select('*').in('staff_id', staff.map((s) => s.id));
    if (!l.error) links = l.data || [];
  }
  const out = readinessFrom({ tenant: tenant || { id: tenantId }, settings, services: svc.data || [], staff, schedules: sch.data || [], links });
  // A salon whose book lives in Square / Boulevard: Lola checks and books there — nothing to set up here.
  try {
    const { liveProviderFor } = await import('./live-booking.js');
    const lp = await liveProviderFor(tenantId);
    if (lp) return { ...out, ready: true, live_system: lp.name, next: null };
  } catch (_) {}
  return out;
}
