// The onboarding scan commits in ONE transaction (lola_apply_onboarding): services, prices, the team,
// staff hours, opening hours, the Google Places payload and the salon record land together or not at all.
// The universal calendar bridge is an outbox: one job per calendar (each .ics link, each booking-system
// API), claimed with SKIP LOCKED; a link that fails or drops fails only its job, keeps its booked times
// LOCKED, and retries with back-off; tentative appointments and double bookings stay blocked.
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'tk';
process.env.SYNC_CONNECTOR_MS = '3000';
import { readFileSync } from 'node:fs';
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
globalThis.fetch = async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
const { T } = await import('./fake-supabase.mjs');
const P = new URL('../../api/', import.meta.url).href;
const { db } = await import(P + 'lib/db.js');
const BL = await import(P + 'lib/business-learn.js');
const SS = await import(P + 'lib/sync-schema.js');
const TID = '00000000-0000-4000-8000-0000000000a1';

// 0) The SQL the owner runs and the SQL the app self-applies are the same file
ok(SS.SYNC_ATOMIC_DDL === readFileSync(new URL('../../sql/sync-atomic-2026-10.sql', import.meta.url), 'utf8'), 'sync-schema.js carries sql/sync-atomic-2026-10.sql verbatim');
ok(/create or replace function public\.lola_apply_onboarding/.test(SS.SYNC_ATOMIC_DDL) && /for update skip locked/.test(SS.SYNC_ATOMIC_DDL) && /pg_advisory_xact_lock/.test(SS.SYNC_ATOMIC_DDL), 'one transaction per salon, SKIP LOCKED outbox');

// ── 1. Onboarding: one transaction ──
function reset() {
  T.tenants = [{ id: TID, name: 'MMA Salon', slug: 'mma', services: [], team: [], knowledge: null, persona: 'warm' }];
  T.booking_settings = [{ tenant_id: TID, timezone: 'America/New_York', metadata: {} }];
  T.services = [{ id: 's0', tenant_id: TID, name: 'Consultation', price: 0, is_active: true }];
  T.staff = [{ id: 'st0', tenant_id: TID, name: 'Any available team member', is_active: true }];
  T.bookings = []; T.staff_schedules = []; T.calendar_sync_jobs = []; T.calendar_conflicts = []; T.cached_availability = []; T.booking_sync_log = []; T.integrations = []; T.provider_mappings = [];
  SS._resetSyncSchema();
}
const profile = BL.cleanProfile({
  services: [{ name: 'Balayage', price: 250, duration_min: 180 }, { name: 'Cut', price: 80, duration_min: 60 }, { name: 'Toner' }],
  team: [{ name: 'Ana Ruiz', role: 'Colorist' }], hours_text: 'Mon-Sat 10am-7pm, Sun closed',
  policies: { deposit: '$50 deposit for color', cancellation_window_hours: 48 }, tone: 'luxury, warm',
});
const place = { id: 'gp1', name: 'MMA Salon', address: '1500 Alton Rd, Miami Beach', rating: 4.9, reviews_count: 212, review_link: 'https://g.page/r/x/review', maps_url: 'https://maps.google.com/?cid=1',
  hours: ['Monday: Closed', 'Tuesday: 10:00 AM – 7:00 PM', 'Wednesday: 10:00 AM – 7:00 PM', 'Thursday: 10:00 AM – 8:00 PM', 'Friday: 10:00 AM – 7:00 PM', 'Saturday: 9:00 AM – 6:00 PM', 'Sunday: Closed'], reviews: [] };
const source = { website: 'https://www.mmasalon.com', google: { ok: true, place, competitors: [{ id: 'c1', name: 'Rival', rating: 4.6, reviews_count: 90 }] } };

reset();
let calls = [];
globalThis.__rpc = (name, args) => {
  calls.push({ name, args });
  if (name === 'lola_apply_onboarding') return { data: { ok: true, atomic: true, hours: true, services: [{ id: 'n1', name: 'Balayage', price: 250 }, { id: 'n2', name: 'Cut', price: 80 }, { id: 'n3', name: 'Toner', price: 0 }], services_added: 3, prices_filled: 0, team_added: 1, schedules_set: 1 }, error: null };
  return { data: [], error: null };
};
let rep = await BL.applyProfile(db(), T.tenants[0], profile, { source });
const call = calls.find((x) => x.name === 'lola_apply_onboarding');
const plan = call?.args?.p_plan || {};
ok(calls.filter((x) => x.name === 'lola_apply_onboarding').length === 1 && call.args.p_tenant_id === TID, 'ONE database call carries the whole ingestion');
ok(plan.hours?.source === 'google' && plan.hours.week.thu.close === '20:00' && plan.hours.week.mon.closed && plan.hours.week.sat.open === '09:00', 'opening hours from Google (exact) in the same transaction');
ok(plan.services_insert.length === 3 && plan.services_insert[0].processing_duration_min === 60 && plan.services_insert[1].price === 80, 'services + prices + color processing times in the same transaction');
ok(plan.staff_insert[0]?.name === 'Ana Ruiz' && plan.default_staff === 'Any available team member', 'the team (the starter stylist steps aside) in the same transaction');
ok(plan.tenant_patch.knowledge?.google?.rating === 4.9 && plan.tenant_patch.knowledge.google.competitors[0].name === 'Rival' && plan.tenant_patch.google_review_url && plan.tenant_patch.location, 'the Google Places payload + salon record in the same transaction');
ok(plan.settings_patch.deposits_detected?.fixed_cents === 5000 && plan.settings_patch.cancellation_window_hours === 48, 'booking settings the scan found in the same transaction');
ok(T.services.length === 1 && T.staff.length === 1 && !T.tenants[0].location, 'nothing was written piece by piece');
ok(rep.atomic === true && rep.services_added === 3 && rep.team_added === 1 && rep.hours && rep.needs_price?.[0]?.id === 'n3', 'the report comes from the committed transaction (unpriced service with its id)');

// The transaction refuses → NOTHING is written, and Lola says so
reset(); calls = [];
globalThis.__rpc = (name) => (name === 'lola_apply_onboarding' ? { data: null, error: { code: '22008', message: 'date/time field value out of range' } } : { data: [], error: null });
rep = await BL.applyProfile(db(), T.tenants[0], profile, { source });
ok(rep.failed && rep.atomic && T.services.length === 1 && T.staff.length === 1 && !T.tenants[0].knowledge, 'refused transaction → nothing half-written');
ok(/saved nothing/.test(BL.learnedSay(profile, rep, source).say), 'and the owner is told: ' + BL.learnedSay(profile, rep, source).say.slice(0, 90));

// No database function yet → the step-by-step writer still syncs (and the live check asks for the SQL)
reset(); delete globalThis.__rpc;
rep = await BL.applyProfile(db(), T.tenants[0], profile, { source });
ok(rep.atomic === false && T.services.filter((x) => x.is_active !== false).some((x) => x.name === 'Balayage') && T.staff.some((x) => x.name === 'Ana Ruiz'), 'no function yet → still synced step by step (atomic: false)');

// Malformed hours never reach the transaction
ok(BL.cleanWeek({ mon: { open: '10:00', close: '19:00' }, tue: { open: '99:99', close: '19:00' }, wed: { open: '10:00', close: '09:00' }, thu: { open: '10:00', close: '19:00' }, fri: { open: '10:00', close: '19:00' }, sat: { open: '10:00', close: '19:00' }, sun: { closed: true } })?.tue === undefined, 'bad times are dropped before the transaction');

// ── 2. The calendar outbox ──
reset();
const ical = await import(P + 'lib/connectors/ical.js');
const OB = await import(P + 'lib/calendar-outbox.js');
const day = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10).replace(/-/g, '');
const ev = (uid, d, h, extra = '') => `BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTART:${day(d)}T${String(h).padStart(2, '0')}0000Z\r\nDTEND:${day(d)}T${String(h + 1).padStart(2, '0')}0000Z\r\nSUMMARY:Client\r\n${extra}END:VEVENT\r\n`;
const cal = (...e) => `BEGIN:VCALENDAR\r\n${e.join('')}END:VCALENDAR\r\n`;
const FA = { url: 'https://cal.example-a.com/ana.ics', label: 'Ana (Boulevard)', staff_id: 'ana' };
const FB = { url: 'https://cal.down.invalid/bo.ics', label: 'Bo (Vagaro)', staff_id: 'bo' };
const FC = { url: 'https://cal.example-c.com/cy.ics', label: 'Cy', staff_id: 'cy' };
const feeds = { [FA.url]: cal(ev('a-1', 2, 15), ev('a-tent', 3, 16, 'STATUS:TENTATIVE\r\n')), [FC.url]: cal(ev('c-1', 2, 15)) };
ical.clearIcsCache();
const winFrom = new Date(Date.now() - 12 * 3600e3).toISOString(), winTo = new Date(Date.now() + 45 * 864e5).toISOString();
await ical.listAppointments({ access_token: JSON.stringify([FA, FC]), metadata: { timezone: 'UTC' } }, { from: winFrom, to: winTo, fetchImpl: async (u) => new Response(feeds[u], { status: 200 }) });
T.integrations = [
  { id: 'int-ical', tenant_id: TID, provider: 'ical', status: 'connected', access_token: JSON.stringify([FA, FB, FC]), metadata: { timezone: 'UTC' } },
  { id: 'int-vagaro', tenant_id: TID, provider: 'vagaro', status: 'connected', access_token: 'tok', metadata: {} },
];
T.staff = [{ id: 'ana', tenant_id: TID, name: 'Ana', is_active: true }, { id: 'bo', tenant_id: TID, name: 'Bo', is_active: true }];
const keyA = ical.feedKey(FA), keyB = ical.feedKey(FB);
const inDays = (d, h) => new Date(Date.parse(`${day(d).slice(0, 4)}-${day(d).slice(4, 6)}-${day(d).slice(6)}T${String(h).padStart(2, '0')}:00:00Z`)).toISOString();
// Already cached: Bo's appointment (his link is about to fail), Vagaro's (its API is about to fail), Ana's cancelled one.
T.cached_availability = [
  { id: 'keep-bo', tenant_id: TID, provider: 'ical', external_booking_id: `bo-1@1#${keyB}`, starts_at: inDays(1, 14), ends_at: inDays(1, 15), staff_id: 'local:bo', status: 'booked' },
  { id: 'keep-vagaro', tenant_id: TID, provider: 'vagaro', external_booking_id: 'vg-77', starts_at: inDays(1, 11), ends_at: inDays(1, 12), staff_id: null, status: 'unconfirmed' },
  { id: 'gone-ana', tenant_id: TID, provider: 'ical', external_booking_id: `a-old@1#${keyA}`, starts_at: inDays(1, 9), ends_at: inDays(1, 10), staff_id: 'local:ana', status: 'booked' },
];
// A LolaDesk booking for Ana at the same time as her outside appointment → a double booking.
T.bookings = [{ id: 'lb1', tenant_id: TID, staff_id: 'ana', start_time: inDays(2, 15), end_time: inDays(2, 16), status: 'confirmed' }];
// The database's claim function, emulated (due jobs, not leased; a salon's run takes all its jobs).
globalThis.__rpc = (name, a) => {
  if (name !== 'lola_claim_sync_jobs') return { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } };
  const now = Date.now();
  const due = (T.calendar_sync_jobs || []).filter((j) => (a.p_tenant_id && a.p_tenant_id !== '00000000-0000-0000-0000-000000000000' ? j.tenant_id === a.p_tenant_id : (!a.p_tenant_id && Date.parse(j.next_run_at) <= now)) && (!j.lease_until || Date.parse(j.lease_until) < now)).slice(0, a.p_limit);
  due.forEach((j) => { j.lease_until = new Date(now + a.p_lease_seconds * 1000).toISOString(); });
  return { data: due.map((j) => ({ ...j })), error: null };
};
SS._resetSyncSchema();
ok(await SS.syncSchemaReady({ fresh: true }), 'outbox detected');
let o = await OB.runOutbox({ tenantId: TID });
const jobs = T.calendar_sync_jobs;
ok(o.ok && jobs.length === 4 && o.claimed === 4, `one job per calendar: 3 links + the Vagaro API → ${jobs.length} jobs`);
const st = (lbl) => jobs.find((j) => j.label === lbl || j.provider === lbl);
ok(st('Ana (Boulevard)').status === 'ok' && st('Cy').status === 'ok', 'the links that answer synced');
ok(st('Bo (Vagaro)').status === 'retrying' && st('Bo (Vagaro)').attempts === 1 && Date.parse(st('Bo (Vagaro)').next_run_at) > Date.now() + 30e3, 'the dropped link fails ALONE and retries with back-off');
ok(st('vagaro').status === 'retrying' && /vagaro|answer|token|fetch|failed|error/i.test(st('vagaro').last_error || ''), 'the failing booking-system API fails alone: ' + st('vagaro').last_error);
ok(T.cached_availability.some((r) => r.id === 'keep-bo') && T.cached_availability.some((r) => r.id === 'keep-vagaro'), 'their booked times stay LOCKED (nothing pruned for a failed job)');
ok(!T.cached_availability.some((r) => r.id === 'gone-ana'), 'Ana’s cancelled appointment is released (her link answered)');
const tent = T.cached_availability.find((r) => String(r.external_booking_id).startsWith('a-tent'));
ok(tent && tent.status === 'unconfirmed', 'a tentative (unconfirmed) appointment stays blocked as unconfirmed');
const dbl = T.cached_availability.find((r) => String(r.external_booking_id).startsWith('a-1@'));
ok(dbl && dbl.status === 'conflict' && T.calendar_conflicts.length === 1 && T.calendar_conflicts[0].booking_id === 'lb1' && T.calendar_conflicts[0].status === 'open', 'a double booking stays blocked and is held for the owner');
ok(T.cached_availability.some((r) => String(r.external_booking_id).startsWith('c-1@')), 'Cy’s calendar synced independently');
ok(T.booking_sync_log.some((l) => /Bo \(Vagaro\)/.test(l.error_message || '')), 'the failing link is logged by name');

// The cron only takes jobs that are due: the healthy ones wait their 2 minutes, the failing ones their back-off.
o = await OB.runOutbox({});
ok(o.ok && o.claimed === 0, 'next minute: nothing due, nothing re-read');
// Bo's link comes back after its back-off
st('Bo (Vagaro)').next_run_at = new Date(Date.now() - 1000).toISOString();
feeds[FB.url] = cal(ev('b-new', 4, 10));
await ical.listAppointments({ access_token: JSON.stringify([FB]), metadata: { timezone: 'UTC' } }, { from: winFrom, to: winTo, fetchImpl: async (u) => new Response(feeds[u], { status: 200 }) });
o = await OB.runOutbox({});
ok(o.claimed === 1 && st('Bo (Vagaro)').status === 'ok' && st('Bo (Vagaro)').attempts === 0, 'back-off over → only Bo’s job runs, and it recovers');
ok(!T.cached_availability.some((r) => r.id === 'keep-bo') && T.cached_availability.some((r) => String(r.external_booking_id).startsWith('b-new@')), 'with his link back, his schedule is current again');
ok(T.cached_availability.some((r) => r.id === 'keep-vagaro'), 'Vagaro (still failing) keeps its booked times');

// The owner removes Cy's link → that job and its busy time go; nothing else moves
T.integrations[0].access_token = JSON.stringify([FA, FB]);
await OB.ensureJobs(db(), TID);
ok(!T.calendar_sync_jobs.some((j) => j.label === 'Cy') && !T.cached_availability.some((r) => String(r.external_booking_id).startsWith('c-1@')) && T.cached_availability.some((r) => r.id === 'keep-vagaro'), 'a removed link takes only its own busy time');

// Lola tells the owner
const A = await import(P + 'lib/owner-awareness.js');
A._resetAwareness();
const snap = await A.businessSnapshot(T.tenants[0]);
ok(snap.gaps.some((g) => g.key === 'conflict') && snap.gaps.some((g) => g.key === 'sync' && /vagaro/i.test(g.say)), 'Lola names the double booking and the failing calendar');

// A calendar that suddenly lists nothing is re-checked once before its booked times are released
ical.clearIcsCache();
const ana = st('Ana (Boulevard)'); ana.last_count = 6; ana.next_run_at = new Date(Date.now() - 1000).toISOString();
await ical.listAppointments({ access_token: JSON.stringify([FA]), metadata: { timezone: 'UTC' } }, { from: winFrom, to: winTo, fetchImpl: async () => new Response(cal(), { status: 200 }) });
const anaRows = () => T.cached_availability.filter((r) => String(r.external_booking_id).endsWith('#' + keyA)).length;
const before = anaRows();
o = await OB.runOutbox({});
ok(before > 0 && anaRows() === before && ana.status === 'retrying' && /empty_pending/.test(ana.last_error), 'an empty answer is not trusted at once: times kept, re-checking');
ana.next_run_at = new Date(Date.now() - 1000).toISOString();
o = await OB.runOutbox({});
ok(anaRows() === 0 && ana.status === 'ok' && T.calendar_conflicts[0].status === 'resolved', 'confirmed empty on the next read → released (and the double booking is resolved)');

// No outbox tables yet → the step-by-step sync still runs
delete globalThis.__rpc; SS._resetSyncSchema();
const { syncTenantAvailability } = await import(P + 'lib/booking-sync.js');
const legacy = await syncTenantAvailability(db(), TID);
ok(legacy.ok && !legacy.outbox, 'without the SQL: the step-by-step sync still runs');

console.log(fails ? `\n${fails} FAILED` : '\nall atomic + outbox checks pass');
process.exit(fails ? 1 : 0);
