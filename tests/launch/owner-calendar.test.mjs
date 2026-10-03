// The owner's calendar (bookings.html → /api/calendar-owner + /api/salon):
// salon-local times land at the right UTC instant, the owner override books
// walk-ins / off-grid / past times but never silently double-books a stylist,
// status changes go through the canonical update (history), the salon
// platform's appointments come back read-only, and multi-service bookings
// respect a lunch block in SALON time.
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'k';
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
globalThis.fetch = async () => new Response(JSON.stringify({ data: { id: 'x' } }), { status: 200, headers: { 'content-type': 'application/json' } });
const { T, createClient } = await import('./fake-supabase.mjs');
// Real Postgres hands back a SNAPSHOT for a single-row select; the in-memory fake
// hands back the live row, so a later update mutated the "before" copy and the
// canonical status-history write could never be observed. Snapshot here.
{ const Q = createClient().from('x').constructor.prototype, run0 = Q.run;
  Q.run = function () { const out = run0.call(this); if (this.op === 'select' && (this.one || this.maybe) && out && out.data) out.data = { ...out.data }; return out; }; }
const P = new URL('../../api/', import.meta.url).href;
const { zonedLocalToUtc } = await import(P + 'lib/timezone.js');
const TID = '44444444-4444-4444-8444-444444444444', OTHER = '55555555-5555-4555-8555-555555555555', TZ = 'America/New_York', DAY = 864e5;
const day = new Date(Date.now() + 3 * DAY).toLocaleDateString('en-CA', { timeZone: TZ });
const at = (hhmm, d = day) => zonedLocalToUtc(d, hhmm + ':00', TZ);
const reset = () => {
  T.tenants = [{ id: TID, name: 'MMA Salon', slug: 'mma', subscription_status: 'active', phone_number: '+13055550100' },
    { id: OTHER, name: 'Other Salon', slug: 'other', subscription_status: 'active' }];
  T.tenant_users = [{ user_id: 'u1', tenant_id: TID, role: 'owner', status: 'active' }, { user_id: 'u2', tenant_id: TID, role: 'staff', status: 'active' }];
  T.booking_settings = [{ tenant_id: TID, timezone: TZ, slot_interval_minutes: 15, minimum_notice_minutes: 0, booking_horizon_days: 90, default_buffer_before_min: 0, default_buffer_after_min: 0, allow_processing_overlap: true, metadata: {} }];
  T.services = [
    { id: 'cut', tenant_id: TID, name: 'Cut', duration_minutes: 60, price: 80, is_active: true },
    { id: 'gloss', tenant_id: TID, name: 'Gloss', duration_minutes: 30, price: 45, is_active: true },
    { id: 'color', tenant_id: TID, name: 'Color', duration_minutes: 90, active_duration_1_min: 45, processing_duration_min: 30, active_duration_2_min: 15, price: 160, is_active: true },
  ];
  T.staff = [{ id: 'ana', tenant_id: TID, name: 'Ana', is_active: true }, { id: 'bo', tenant_id: TID, name: 'Bo', is_active: true }];
  T.staff_services = []; T.staff_schedules = [];
  for (const s of ['ana', 'bo']) for (let d = 0; d < 7; d++) T.staff_schedules.push({ tenant_id: TID, staff_id: s, day_of_week: d, start_time: '09:00', end_time: '17:00' });
  T.staff_time_off = []; T.blocked_slots = []; T.bookings = []; T.availability_holds = []; T.locations = []; T.business_hours = [];
  T.clients = [{ id: 'c1', tenant_id: TID, name: 'Sarah Kim', first_name: 'Sarah', last_name: 'Kim', phone: '+13055554444' },
    { id: 'cx', tenant_id: OTHER, name: 'Sarah Other', first_name: 'Sarah', last_name: 'Other', phone: '+13055559999' }];
  T.cached_availability = []; T.provider_mappings = []; T.booking_outbox = []; T.integrations = []; T.client_memories = []; T.usage_events = [];
  T.deposits = []; T.tenant_channels = []; T.opt_outs = []; T.booking_status_history = []; T.booking_services = []; T.booking_fees = [];
};
reset();
globalThis.__authUsers = { tok: { id: 'u1', email: 'o@mma.com' }, stafftok: { id: 'u2', email: 's@mma.com' } };
const run = async (mod, req, tok = 'tok') => { const h = (await import(P + mod)).default; return new Promise((resolve) => { const res = { statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(o) { resolve({ status: this.statusCode, ...o }); }, end() { resolve({ status: this.statusCode }); } }; h({ method: 'POST', headers: { authorization: 'Bearer ' + tok }, query: {}, ...req }, res); }); };
const owner = (body, tok) => run('calendar-owner.js', { body }, tok);
const ownerGet = (query, tok) => run('calendar-owner.js', { method: 'GET', query }, tok);

// ── 1. Salon-local time → the right UTC instant ──
let r = await owner({ action: 'book', service_ids: ['cut'], staff_id: 'ana', date: day, time: '14:00', client_id: 'c1', override: true });
const b1 = T.bookings.find((b) => b.id === r.booking_id);
ok(r.ok && b1 && b1.start_time === at('14:00') && Date.parse(b1.end_time) - Date.parse(b1.start_time) === 3600e3, `2:00 PM New York lands at ${at('14:00')} (got ${b1?.start_time})`);
ok(new Date(b1.start_time).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }) === '2:00 PM', 'and reads back as 2:00 PM in the salon’s zone');
ok(b1.source === 'dashboard' && b1.client_id === 'c1' && b1.status === 'confirmed', 'owner booking: dashboard source, picked client, confirmed');
ok(T.booking_outbox.some((o) => o.booking_id === b1.id), 'written through to the salon platform outbox');
r = await owner({ action: 'book', service_ids: ['cut'], staff_id: 'ana', date: day, time: '15:00', client_id: 'cx', override: true });
ok(!r.ok && r.status === 404, 'another salon’s client id is refused (tenant-scoped)');

// ── 2. Owner override: off-grid, walk-in, past — but never a silent double-book ──
r = await owner({ action: 'book', service_ids: ['gloss'], staff_id: 'bo', date: day, time: '10:10', client_name: 'Off Grid', override: true });
ok(r.ok && T.bookings.find((b) => b.id === r.booking_id)?.start_time === at('10:10'), 'off-grid 10:10 books for the owner');
r = await owner({ action: 'book', service_ids: ['gloss'], staff_id: 'bo', date: day, time: '10:10', client_name: 'Strict', override: false });
ok(!r.ok && r.conflict, 'the same off-grid request without override is validated by the engine (refused)');
r = await owner({ action: 'book', service_ids: ['cut'], staff_id: 'bo', date: day, time: '18:30', client_name: 'Late', override: true });
ok(r.ok && r.warnings.some((w) => /Outside Bo/.test(w)), 'outside Bo’s hours books with a warning: ' + (r.warnings || []).join(' '));
const nowLocal = new Date().toLocaleString('en-CA', { timeZone: TZ, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(',', '');
const [today, nowT] = nowLocal.split(' ');
r = await owner({ action: 'book', service_ids: ['cut'], staff_id: 'bo', date: today, time: nowT.replace(/^24/, '00'), walk_in: true, override: true });
const walk = T.bookings.find((b) => b.id === r.booking_id);
ok(r.ok && walk && Math.abs(Date.parse(walk.start_time) - Date.now()) < 2 * 60e3, 'walk-in now books at this minute');
ok(T.clients.some((c) => c.id === walk.client_id && /Walk-in/.test(c.first_name || c.name || '')), 'walk-in with no name gets a Walk-in client');
const yesterday = new Date(Date.now() - DAY).toLocaleDateString('en-CA', { timeZone: TZ });
r = await owner({ action: 'book', service_ids: ['cut'], staff_id: 'ana', date: yesterday, time: '11:00', client_id: 'c1', override: true });
ok(r.ok && r.warnings.some((w) => /past/.test(w)), 'yesterday’s visit can be entered after the fact');
r = await owner({ action: 'book', service_ids: ['gloss'], staff_id: 'ana', date: day, time: '14:30', client_name: 'Clash', override: true });
ok(!r.ok && r.status === 409 && r.needs_confirmation && /Ana is already booked/.test(r.error) && /Sarah Kim/.test(r.error), 'same-stylist overlap refused with a clear question: ' + r.error);
ok(!T.bookings.some((b) => b.start_time === at('14:30')), 'nothing was written');
r = await owner({ action: 'book', service_ids: ['gloss'], staff_id: 'bo', date: day, time: '14:30', client_name: 'Other chair', override: true });
ok(r.ok, 'the same time with a different stylist books (only same-stylist overlap blocks)');
r = await owner({ action: 'book', service_ids: ['gloss'], staff_id: 'ana', date: day, time: '14:30', client_name: 'Clash', override: true, force: true });
ok(r.ok && r.forced && T.bookings.filter((b) => b.staff_id === 'ana' && b.start_time === at('14:30')).length === 1, '“Book anyway” (force) double-books on purpose');
r = await owner({ action: 'book', service_ids: ['gloss'], staff_id: 'ana', date: day, time: '16:00', client_name: 'Nope', override: true }, 'stafftok');
ok(r.status === 403, 'override is owner/manager only (staff login refused)');

// ── 3. Status through the canonical update ──
T.booking_status_history = [];
r = await owner({ action: 'status', booking_id: b1.id, status: 'no_show' });
ok(r.ok && T.bookings.find((b) => b.id === b1.id).status === 'no_show', 'no_show saved');
ok(T.booking_status_history.some((h) => h.booking_id === b1.id && h.from_status === 'confirmed' && h.to_status === 'no_show' && h.source === 'dashboard'), 'a status-history row records confirmed → no_show');
r = await owner({ action: 'status', booking_id: b1.id, status: 'banana' });
ok(!r.ok && r.status === 400, 'an invalid status is refused');
r = await owner({ action: 'status', booking_id: b1.id, status: 'checked_in' });
ok(r.ok && T.bookings.find((b) => b.id === b1.id).status === 'checked_in', 'checked_in (Arrived) is a valid owner status');
// legacy salon.js status writes also go through the canonical path now
const hist0 = T.booking_status_history.length;
r = await run('salon.js', { body: { resource: 'appointment', action: 'update', id: b1.id, status: 'in_progress' } });
ok(r.ok && T.booking_status_history.length === hist0 + 1, 'salon.js status update writes history too');

// ── 3b. Moving keeps the status; series “following” shifts later occurrences ──
r = await owner({ action: 'move', booking_id: b1.id, date: day, time: '09:05', staff_id: 'ana', override: true });
const moved = T.bookings.find((b) => b.id === b1.id);
ok(r.ok && moved.start_time === at('09:05') && moved.status === 'in_progress', 'drag-move to 9:05 keeps in_progress (not reset to confirmed)');
r = await owner({ action: 'move', booking_id: b1.id, duration_min: 95, override: true });
ok(r.ok && Date.parse(T.bookings.find((b) => b.id === b1.id).end_time) - Date.parse(at('09:05')) === 95 * 60e3, 'resize sets the end time');
r = await owner({ action: 'book', service_ids: ['cut'], staff_id: 'bo', date: day, time: '12:00', client_name: 'Series', repeat: { rule: 'weekly', count: 3 }, override: true });
const ser = T.bookings.filter((b) => b.series_id && b.series_id === r.series?.id).sort((a, b) => a.series_pos - b.series_pos);
ok(r.ok && ser.length === 3 && ser.every((b, i) => b.start_time === at('12:00', new Date(Date.parse(day + 'T12:00:00Z') + 7 * i * DAY).toISOString().slice(0, 10))), 'weekly series keeps 12:00 salon time on every date');
const serStarts = ser.map((b) => b.start_time);
r = await owner({ action: 'move', booking_id: ser[1].id, date: ser[1].start_time && new Date(ser[1].start_time).toLocaleDateString('en-CA', { timeZone: TZ }), time: '13:00', series_scope: 'following', override: true });
const ser2 = T.bookings.filter((b) => b.series_id === ser[0].series_id).sort((a, b) => a.series_pos - b.series_pos);
ok(r.ok && r.moved_count === 2 && /T1[78]:00/.test(ser2[1].start_time) && ser2[2].start_time === new Date(Date.parse(serStarts[2]) + 3600e3).toISOString() && ser2[0].start_time === serStarts[0], 'this + following moves occurrences 2 and 3, not 1');

// ── 4. The salon platform’s appointments, read-only ──
T.cached_availability = [
  { id: 'ca1', tenant_id: TID, provider: 'vagaro', external_booking_id: 'v1', starts_at: at('15:00'), ends_at: at('16:00'), staff_id: 'local:ana', status: 'booked' },
  { id: 'ca2', tenant_id: TID, provider: 'square', external_booking_id: 's9', starts_at: at('11:00'), ends_at: at('11:30'), staff_id: 'SQ-BO', status: 'booked' },
  { id: 'ca3', tenant_id: TID, provider: 'square', external_booking_id: 's10', starts_at: at('12:00'), ends_at: at('12:30'), staff_id: null, status: 'cancelled' },
  { id: 'ca4', tenant_id: OTHER, provider: 'square', external_booking_id: 'zz', starts_at: at('12:00'), ends_at: at('12:30'), staff_id: null, status: 'booked' },
];
T.provider_mappings = [{ tenant_id: TID, provider: 'square', entity_type: 'staff', external_id: 'SQ-BO', local_id: 'bo' }];
r = await ownerGet({ action: 'external', from: day, to: day });
const ex = r.appointments || [];
ok(r.ok && ex.length === 2 && ex.find((x) => x.provider === 'vagaro')?.staff_id === 'ana' && ex.find((x) => x.provider === 'square')?.staff_id === 'bo' && ex.every((x) => x.read_only), 'two live platform appointments, mapped to Ana (local:) and Bo (provider mapping); cancelled + other salon excluded');
r = await owner({ action: 'book', service_ids: ['gloss'], staff_id: 'ana', date: day, time: '15:15', client_name: 'Ext clash', override: true });
ok(!r.ok && r.needs_confirmation && /vagaro/i.test(r.error), 'a platform appointment on the same stylist is a real double-booking: ' + r.error);
r = await ownerGet({ action: 'context', date: day, days: 1 });
ok(r.ok && r.timezone === TZ && r.hours.start_min === 540 && r.hours.end_min === 1020 && r.external.length === 2 && r.schedules.length === 14, 'context: salon tz, 9–5 working range, schedules, platform rows');
r = await ownerGet({ action: 'clients', q: 'sarah' });
ok(r.ok && r.clients.length === 1 && r.clients[0].id === 'c1', 'client search is tenant-scoped');
r = await ownerGet({ action: 'clients', q: '5554444' });
ok(r.ok && r.clients[0]?.id === 'c1', 'client search by phone digits');

// ── 5. Multi-service validation respects lunch in SALON time ──
reset();
T.blocked_slots = [{ id: 'lunch', tenant_id: TID, staff_id: 'ana', blocked_date: day, start_time: '12:00', end_time: '13:00', reason: 'Lunch' }];
r = await run('salon.js', { body: { resource: 'appointment', service_ids: ['cut', 'gloss'], staff_id: 'ana', starts_at: at('11:30'), client_name: 'Lunch Clash', client_phone: '+13055551111' } });
ok(!r.ok && r.conflict && T.bookings.length === 0, 'salon.js: Cut+Gloss at 11:30 into Ana’s 12–1 lunch (salon time) is refused: ' + r.error);
r = await run('salon.js', { body: { resource: 'appointment', service_ids: ['cut', 'gloss'], staff_id: 'ana', starts_at: at('13:00'), client_name: 'After Lunch', client_phone: '+13055551111' } });
const ml = T.bookings.find((b) => b.start_time === at('13:00'));
ok(r.ok && ml && ml.end_time === at('14:30') && T.booking_services.filter((x) => x.booking_id === ml.id).length === 2, 'Cut+Gloss at 1:00 PM books 1:00–2:30 with two line items');
ok(T.booking_outbox.some((o) => o.booking_id === ml.id), 'salon.js multi-service writes through to the platform outbox');
// The old UTC-hour check let 4 PM UTC (= noon New York) through and blocked the wrong hour.
r = await run('salon.js', { body: { resource: 'appointment', service_ids: ['gloss'], staff_id: 'ana', starts_at: at('12:15'), client_name: 'UTC', client_phone: '+13055551112' } });
ok(!r.ok && r.conflict, 'single service at 12:15 New York (16:15Z) hits the lunch block');
r = await owner({ action: 'book', service_ids: ['cut', 'gloss'], staff_id: 'ana', date: day, time: '11:30', client_name: 'Strict', override: false });
ok(!r.ok && r.conflict, 'calendar-owner strict mode refuses the same lunch overlap');
r = await owner({ action: 'book', service_ids: ['cut', 'gloss'], staff_id: 'ana', date: day, time: '11:30', client_name: 'Owner', override: true });
ok(r.ok && r.warnings.some((w) => /blocked time \(Lunch\)/.test(w)), 'owner override books through lunch with a warning');
r = await run('salon.js', { body: { resource: 'appointment', service_ids: ['gloss'], staff_id: 'bo', starts_at: at('09:00'), client_name: 'Rec', client_phone: '+13055551113', repeat: { rule: 'weekly', count: 3 } } });
ok(r.ok && r.series?.total === 3 && T.bookings.filter((b) => b.series_id === r.series.id).length === 3, 'salon.js recurring series validates and creates every occurrence');
T.blocked_slots.push({ id: 'off', tenant_id: TID, staff_id: 'bo', blocked_date: new Date(Date.parse(day + 'T12:00:00Z') + 14 * DAY).toISOString().slice(0, 10), start_time: null, end_time: null, reason: 'Day off' });
const before = T.bookings.length;
r = await run('salon.js', { body: { resource: 'appointment', service_ids: ['gloss'], staff_id: 'bo', starts_at: at('10:00'), client_name: 'Rec2', client_phone: '+13055551114', repeat: { rule: 'weekly', count: 3 } } });
ok(!r.ok && r.failed_at_occurrence === 3 && T.bookings.length === before, 'a day off on occurrence 3 refuses the series before anything is written');

console.log(fails ? `\n${fails} FAILED` : '\nall owner-calendar tests passed');
process.exit(fails ? 1 : 0);
