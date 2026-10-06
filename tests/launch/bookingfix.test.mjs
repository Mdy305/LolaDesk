// Booking-engine defects, fixed: no double bookings (atomic hold + claim-once),
// salon-timezone times, cancels/moves reach the salon's system, Square/Google
// done right, nobody holds a whole day, DST-safe series, honest texts.
// The server clock runs in UTC here (like Vercel) so timezone bugs show up.
process.env.TZ = 'UTC';
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'k';
process.env.STRIPE_SECRET_KEY = 'sk_test_x'; process.env.OPERATOR_TOOLS_SECRET = 'op-master';
process.env.INTEGRATION_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
const net = { calls: [], texts: [], route: null };
globalThis.fetch = async (url, init = {}) => {
  const u = String(url); net.calls.push({ url: u, method: init.method || 'GET', body: init.body ? (() => { try { return JSON.parse(init.body); } catch { return init.body; } })() : null });
  if (net.route) { const r = await net.route(u, init); if (r) return r; }
  if (u.includes('/v2/messages')) { net.texts.push(JSON.parse(init.body || '{}')); return J({ data: { id: 'm' } }); }
  if (u.includes('api.stripe.com')) return J({ id: 'plink_1', url: 'https://buy.stripe.com/x' });
  return J({ data: [] });
};
const { T, createClient } = await import('./fake-supabase.mjs');
// Real Postgres returns a snapshot for single-row selects; the fake hands back the live row.
{ const Q = createClient().from('x').constructor.prototype, run0 = Q.run;
  Q.run = function () { const out = run0.call(this); if (this.op === 'select' && (this.one || this.maybe) && out && out.data) out.data = { ...out.data }; return out; }; }
const fs = await import('node:fs');
const P = new URL('../../api/', import.meta.url).href;
const { zonedLocalToUtc } = await import(P + 'lib/timezone.js');
const { db } = await import(P + 'lib/db.js');
const repo = await import(P + 'lib/booking-repository.js');
const engine = await import(P + 'lib/availability-engine-v2.js');
const integ = await import(P + 'lib/booking-integrity.js');
const TID = '66666666-6666-4666-8666-666666666666', TZ = 'America/New_York', DAY = 864e5;
const day = new Date(Date.now() + 3 * DAY).toLocaleDateString('en-CA', { timeZone: TZ });
const at = (hhmm, d = day) => zonedLocalToUtc(d, hhmm + ':00', TZ);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = (handler, { method = 'POST', query = {}, body = {}, headers = {} }) => new Promise((resolve) => {
  const res = { statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(o) { resolve({ status: this.statusCode, ...o }); return this; }, end() { resolve({ status: this.statusCode }); return this; }, send(o) { resolve({ status: this.statusCode, body: o }); } };
  handler({ method, query, body, headers }, res);
});
const reset = (settings = {}) => {
  T.tenants = [{ id: TID, name: 'MMA Salon', slug: 'mma', subscription_status: 'active', phone_number: '+13055550100', operator_phone: '+17865550199',
    operator_pin_hash: null, services: [{ name: 'Consult', price: 0, duration: 30 }], team: [{ name: 'Ana' }] }];
  T.tenant_users = [{ user_id: 'u1', tenant_id: TID, role: 'owner', status: 'active' }];
  T.booking_settings = [{ tenant_id: TID, timezone: TZ, slot_interval_minutes: 15, minimum_notice_minutes: 0, booking_horizon_days: 90, default_buffer_before_min: 0, default_buffer_after_min: 0, allow_processing_overlap: true, metadata: {}, ...settings }];
  T.services = [
    { id: 'cut', tenant_id: TID, name: 'Cut', duration_minutes: 60, price: 80, is_active: true },
    { id: 'gloss', tenant_id: TID, name: 'Gloss', duration_minutes: 30, price: 45, is_active: true },
  ];
  T.staff = [{ id: 'ana', tenant_id: TID, name: 'Ana', is_active: true }, { id: 'bo', tenant_id: TID, name: 'Bo', is_active: true }];
  T.staff_services = []; T.staff_schedules = [];
  for (const s of ['ana', 'bo']) for (let d = 0; d < 7; d++) T.staff_schedules.push({ tenant_id: TID, staff_id: s, day_of_week: d, start_time: '09:00', end_time: '17:00' });
  T.staff_time_off = []; T.blocked_slots = []; T.bookings = []; T.availability_holds = []; T.locations = []; T.business_hours = [];
  T.clients = [{ id: 'c1', tenant_id: TID, name: 'Sarah Kim', first_name: 'Sarah', last_name: 'Kim', phone: '+13055554444' }];
  T.cached_availability = []; T.provider_mappings = []; T.booking_outbox = []; T.integrations = []; T.client_memories = []; T.usage_events = [];
  T.deposits = []; T.tenant_channels = []; T.opt_outs = []; T.booking_status_history = []; T.booking_services = []; T.booking_fees = [];
  T.booking_reminders = []; T.booking_waitlist = []; T.public_rate_hits = []; T.tenant_memory = []; T.booking_sync_log = [];
  net.calls.length = 0; net.texts.length = 0; net.route = null;
  integ.resetBookingIntegrity();
};
const B = (id, staff, svc, s, e, extra = {}) => ({ id, tenant_id: TID, staff_id: staff, service_id: svc, start_time: s, end_time: e, status: 'confirmed', client_id: 'c1', ...extra });

// ── 0. The self-applied DDL is the migration ──
const mig = fs.readFileSync(new URL('../../migrations/20261006_booking_integrity.sql', import.meta.url), 'utf8');
const sqlCopy = fs.readFileSync(new URL('../../sql/booking-integrity.sql', import.meta.url), 'utf8');
ok(mig.includes(integ.BOOKING_INTEGRITY_DDL) && sqlCopy.includes(integ.BOOKING_INTEGRITY_DDL) && /pg_advisory_xact_lock/.test(mig) && /bookings_hold_id_unique/.test(mig) && /public_rate_hits/.test(mig) && /cancelled_at/.test(mig),
  'migration 20261006 (advisory-lock hold fn, unique hold_id, cancelled_at, shared rate ledger) == the runtime self-heal DDL == sql/ copy');

// ── 1. Two callers, one slot: exactly one hold (rpc unavailable → insert + re-check) ──
reset();
const both = await Promise.all([1, 2].map(() => engine.holdAvailability({ tenantId: TID, serviceId: 'cut', staffId: 'ana', startsAt: at('10:00'), channel: 'voice' })));
ok(both.filter((h) => h.ok).length === 1 && T.availability_holds.filter((h) => h.status === 'active').length === 1, 'two simultaneous holds on Ana 10:00 → exactly one survives (the later duplicate deleted itself)');
reset();
T.bookings.push(B('sneaky', 'ana', 'cut', at('10:00'), at('11:00')));
const sneak = await repo.createHoldAtomic({ tenantId: TID, staffId: 'ana', serviceId: 'cut', startsAt: at('10:30'), endsAt: at('11:30'), seenBookingIds: [] });
ok(!sneak.ok && sneak.conflict && T.availability_holds.length === 0, 'a booking written after the engine looked → the hold is refused and removed');
// rpc path: lola_take_hold answers
reset();
const c0 = db(); const rpc0 = c0.rpc; let rpcArgs = null;
c0.rpc = async (fn, args) => { if (fn !== 'lola_take_hold') return rpc0(fn, args); rpcArgs = args; return { data: { ok: false, conflict: true, reason: 'hold' }, error: null }; };
let h = await engine.holdAvailability({ tenantId: TID, serviceId: 'cut', staffId: 'ana', startsAt: at('11:00') });
ok(!h.ok && h.conflict && rpcArgs?.p_staff_id === 'ana' && Array.isArray(rpcArgs.p_seen_booking_ids) && rpcArgs.p_window_end === at('12:00') && T.availability_holds.length === 0, 'with the DB function deployed, the lock+re-check runs in Postgres (conflict honored, no client insert)');
c0.rpc = async (fn, args) => fn === 'lola_take_hold' ? { data: { ok: true, hold: { id: 'h-db', hold_token: args.p_hold_token, starts_at: args.p_starts_at, ends_at: args.p_ends_at, staff_id: args.p_staff_id, status: 'active' } }, error: null } : rpc0(fn, args);
h = await engine.holdAvailability({ tenantId: TID, serviceId: 'cut', staffId: 'ana', startsAt: at('11:00') });
ok(h.ok && h.atomic && h.hold.id === 'h-db', 'lola_take_hold ok → the DB-created hold is used');
c0.rpc = rpc0;

// ── 2. One hold → one booking, even on retry / double submit ──
reset();
const pub = (await import(P + 'public-booking.js')).default;
const cal = (await import(P + 'calendar.js')).default;
const { resetRateLimits } = await import(P + 'lib/public-rate-limit.js');
resetRateLimits();
const W = (action, extra = {}, ip = '9.9.9.9') => call(pub, { body: { action, tenant: 'mma', ...extra }, headers: { 'x-forwarded-for': ip } });
let r = await W('hold', { service_id: 'cut', staff_id: 'ana', starts_at: at('10:00'), client_phone: '3055554444' });
const tok = r.hold?.hold_token;
const [b1, b2] = await Promise.all([1, 2].map(() => W('book', { service_id: 'cut', hold_token: tok, starts_at: at('10:00'), client_name: 'Sarah Kim', client_phone: '3055554444' })));
ok(r.ok && [b1, b2].filter((x) => x.ok).length === 1 && T.bookings.length === 1 && T.deposits.length <= 1, 'the same hold submitted twice at once → ONE booking (claimed active→converted before insert)');
ok(T.availability_holds.find((x) => x.hold_token === tok).status === 'converted' && T.bookings[0].hold_id === T.availability_holds.find((x) => x.hold_token === tok).id, 'the booking carries its hold id; the hold is converted');
const again = await repo.bookFromHold(TID, { hold_token: tok }, { clientId: 'c1', serviceId: 'cut', staffId: 'ana', startTime: at('10:00'), endTime: at('11:00') });
ok(!again.ok && again.error === 'hold_expired' && T.bookings.length === 1, 'a retry with a used hold → hold_expired, nothing written');

// ── 3. Nobody holds a whole day ──
reset(); resetRateLimits();
r = await W('hold', { service_id: 'cut', staff_id: 'ana', starts_at: at('09:00'), ttl_seconds: 3600 });
ok(r.ok && Date.parse(r.hold.expires_at) - Date.now() <= 300e3 + 2000, 'public hold TTL is capped at 5 minutes (asked for an hour)');
await W('hold', { service_id: 'cut', staff_id: 'ana', starts_at: at('11:00'), client_phone: '3055550002' });
r = await W('hold', { service_id: 'cut', staff_id: 'ana', starts_at: at('13:00'), client_phone: '3055550003' });
ok(!r.ok && r.error === 'too_many_holds' && r.status === 429, 'a third live hold from the same device → refused (max 2 per IP)');
r = await W('hold', { service_id: 'cut', staff_id: 'bo', starts_at: at('09:00'), client_phone: '3055550004' }, '8.8.8.8');
await W('hold', { service_id: 'cut', staff_id: 'bo', starts_at: at('11:00'), client_phone: '3055550004' }, '7.7.7.7');
await W('hold', { service_id: 'cut', staff_id: 'bo', starts_at: at('13:00'), client_phone: '3055550004' }, '6.6.6.6');
const byPhone = T.availability_holds.filter((x) => x.status === 'active' && x.staff_id === 'bo');
ok(byPhone.length === 2 && !byPhone.some((x) => x.starts_at === at('09:00')), 'one phone keeps at most 2 live holds (its oldest is let go)');
ok(T.public_rate_hits.length > 0 && T.public_rate_hits.every((x) => /^rl:/.test(x.key)), 'public hits are counted in the shared ledger (every instance sees them)');

// ── 4. Times in the salon's timezone; no invented 10 AM ──
const brain = await import(P + 'lib/booking-brain.js');
const odb = await import(P + 'lib/operator-db.js');
ok(brain.startsAtFromParams({ date: '2026-10-08', time: '2pm' }, { tz: TZ }) === '2026-10-08T18:00:00.000Z', '"Oct 8, 2pm" = 2 PM in Miami (18:00Z), not 2 PM UTC');
ok(brain.startsAtFromParams({ date: '2026-10-08' }, { tz: TZ }) === null && odb.to24('') === null && odb.to24('noon') === '12:00:00', 'no time → null (never a silent 10:00)');
const lateNight = new Date('2026-10-07T02:30:00Z'); // 10:30 PM Oct 6 in Miami
ok(odb.resolveDateKey('tomorrow', TZ, lateNight) === '2026-10-07' && odb.resolveDateKey('today', TZ, lateNight) === '2026-10-06', '"tomorrow" at 10:30 PM is the salon’s tomorrow (UTC already says Oct 7)');
ok(odb.computeNewStart('2026-11-10T15:00:00Z', { new_date: '2026-11-12' }, TZ) === null && odb.computeNewStart('2026-11-10T15:00:00Z', { new_time: '3pm' }, TZ) === '2026-11-10T20:00:00.000Z', 'owner move: no new time → ask; a new time keeps the booking’s salon day');
reset();
r = await brain.bookAppointment(T.tenants[0], { service: 'Cut', stylist: 'Ana', date: day, client_phone: '+13055554444', client_name: 'Sarah Kim' }, { channel: 'voice' });
ok(!r.ok && r.needs === 'time' && !T.bookings.length, 'voice booking with no time → Lola asks for one, nothing booked');
r = await brain.checkAvailability(T.tenants[0], { service: 'Cut', stylist: 'Ana', date: day });
ok(r.ok && /9:00\sAM/.test(r.speak) && !/1:00\sPM/.test(r.speak.split(':')[0]), 'Lola speaks salon times ("9:00 AM"), not UTC: ' + r.speak);

// ── 5. An unknown spoken service is never written unchecked ──
const ce = await import(P + 'lib/calendar-engine.js');
reset();
r = await ce.createBookingSafe({ tenant: T.tenants[0], clientId: 'c1', service: 'Mystery Treatment', startsAt: at('10:00') });
ok(!r.ok && r.error === 'service_not_found' && r.menu.includes('Cut') && !T.bookings.length, 'createBookingSafe: unknown service → service_not_found + the real menu, nothing written');
r = await ce.createBookingSafe({ tenant: T.tenants[0], clientId: 'c1', service: 'Gloss', stylist: 'Ana', startsAt: at('11:00'), sendConfirmation: false });
await sleep(30);
ok(r.ok && !net.texts.length && !T.deposits.length, 'createBookingSafe({ sendConfirmation:false }) → no second confirmation text, no deposit (add-on joins the visit)');
reset();
T.tenants[0].team = [{ name: 'Ana' }];
T.services = []; // onboarding: JSON menu only
T.bookings.push(B('x', null, null, at('10:00'), at('11:00')));
r = await brain.bookAppointment(T.tenants[0], { service: 'Consult', time: '10:15am', date: day, client_phone: '+13055554444', client_name: 'Sarah Kim' }, { channel: 'voice' });
ok(!r.ok && r.conflict && T.bookings.filter((b) => b.status === 'confirmed').length === 1, 'legacy JSON-service booking is conflict-checked too (one chair, already taken)');

// ── 6. Reschedule: own slot excluded, real length kept, one history row ──
reset();
T.bookings.push(B('long', 'ana', 'cut', at('10:00'), at('12:00')));
r = await brain.rescheduleAppointment(T.tenants[0], { booking_id: 'long', starts_at: at('10:30') }, { channel: 'voice' });
const long = T.bookings.find((b) => b.id === 'long');
ok(r.ok && long.start_time === at('10:30') && Date.parse(long.end_time) - Date.parse(long.start_time) === 2 * 3600e3, 'moving a 2h booking 30 min later: its own old slot doesn’t block it, and it stays 2h');
ok(T.booking_status_history.filter((x) => x.booking_id === 'long').length === 1, 'exactly one history row for the move');
T.bookings.push(B('next', 'ana', 'cut', at('14:00'), at('15:00')));
r = await ce.rescheduleBookingSafe({ tenantId: TID, bookingId: 'long', newStartsAt: at('13:00') });
ok(!r.ok && r.conflict && T.bookings.find((b) => b.id === 'long').start_time === at('10:30'), 'voice-tools reschedule keeps the real length: 13:00–15:00 would hit the 2pm client → refused');

// ── 7. Same instant, different spelling → no "Rescheduled" text ──
reset();
T.bookings.push(B('s1', 'ana', 'cut', at('10:00').replace('.000Z', '+00:00'), at('11:00')));
await repo.updateCanonicalBooking(TID, 's1', { start_time: at('10:00'), notes: 'x' });
await sleep(20);
ok(!net.texts.length, '"…00.000Z" vs "…00+00:00" is the same time → no reschedule text');
await repo.updateCanonicalBooking(TID, 's1', { start_time: at('12:00'), end_time: at('13:00') });
await sleep(20);
ok(net.texts.length === 1 && /Rescheduled/i.test(net.texts[0].text || ''), 'a real move texts "Rescheduled" once');

// ── 8. Cancels and moves reach the salon's booking system ──
reset();
T.integrations = [{ tenant_id: TID, provider: 'square', status: 'connected', access_token: 'sq-tok' }];
T.bookings.push(B('sq1', 'ana', 'cut', at('10:00'), at('11:00'), { external_id: 'SQB1', external_provider: 'square' }));
const sqSeen = [];
net.route = (u, init) => {
  if (!u.includes('squareup')) return null;
  sqSeen.push({ u, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
  if (/\/v2\/bookings\/SQB1\/cancel/.test(u)) return J({ booking: { id: 'SQB1', version: 4, status: 'CANCELLED_BY_SELLER', start_at: at('10:00') } });
  if (/\/v2\/bookings\/SQB1$/.test(u) && (init.method || 'GET') === 'GET') return J({ booking: { id: 'SQB1', version: 3, status: 'ACCEPTED', start_at: at('10:00'), appointment_segments: [{ duration_minutes: 60 }] } });
  if (/\/v2\/bookings\/SQB1$/.test(u) && init.method === 'PUT') return J({ booking: { id: 'SQB1', version: 4, start_at: JSON.parse(init.body).booking.start_at, appointment_segments: [{ duration_minutes: 60 }] } });
  return J({});
};
await repo.updateCanonicalBooking(TID, 'sq1', { start_time: at('12:00'), end_time: at('13:00') });
await sleep(50);
const put = sqSeen.find((x) => x.method === 'PUT');
ok(T.booking_outbox.some((o) => o.op === 'update' && o.booking_id === 'sq1') && put && put.body.booking.version === 3 && put.body.booking.start_at === at('12:00'), 'a move → outbox "update" → Square PUT /v2/bookings/{id} with the current version');
await repo.updateCanonicalBooking(TID, 'sq1', { status: 'cancelled' });
await sleep(50);
const cxl = sqSeen.find((x) => /\/cancel$/.test(x.u));
ok(T.booking_outbox.some((o) => o.op === 'cancel' && o.status === 'done') && cxl && cxl.body.booking_version === 3, 'a cancel → outbox "cancel" → Square POST /v2/bookings/{id}/cancel with booking_version');
ok(T.bookings.find((b) => b.id === 'sq1').cancelled_at, 'cancelled_at records the real cancellation moment');
reset();
T.integrations = [{ tenant_id: TID, provider: 'vagaro', status: 'connected', access_token: 'v' }];
T.bookings.push(B('vg1', 'ana', 'cut', at('10:00'), at('11:00'), { external_id: 'VG1', external_provider: 'vagaro' }));
const { processOutbox } = await import(P + 'lib/booking-outbox.js');
await repo.updateCanonicalBooking(TID, 'vg1', { status: 'cancelled' }, { upstream: false });
await (await import(P + 'lib/booking-outbox.js')).enqueueUpstream(db(), { tenantId: TID, bookingId: 'vg1', ctx: {}, op: 'cancel' });
const alerts = [];
const res8 = await processOutbox(db(), { bookingId: 'vg1', send: async (m) => { alerts.push(m); return { data: { id: 'a' } }; } });
ok(res8.results[0]?.failed && res8.results[0].unsupported && alerts.length === 1 && /cancel it there too/.test(alerts[0].text) && alerts[0].to === '+17865550199', 'a platform with no cancel API → recorded failed + the owner is texted to cancel it there');
reset();
T.integrations = [{ tenant_id: TID, provider: 'boulevard_client', status: 'connected' }];
T.bookings.push(B('bl1', 'ana', 'cut', at('10:00'), at('11:00'), { external_id: 'BLV', external_provider: 'boulevard_client' }));
await repo.updateCanonicalBooking(TID, 'bl1', { status: 'cancelled' });
ok(!T.booking_outbox.length, 'live Boulevard cancel is skipped (logged) — no outbox row');

// ── 9. Square done right ──
reset();
const sq = await import(P + 'lib/connectors/square.js');
const listCalls = [];
net.route = (u) => {
  if (!u.includes('squareup')) return null;
  if (u.includes('/v2/locations')) return J({ locations: [{ id: 'L1', status: 'ACTIVE' }] });
  if (u.includes('/v2/bookings?')) { listCalls.push(new URL(u)); return J({ bookings: [{ id: 'X' + listCalls.length, start_at: at('10:00'), appointment_segments: [{ duration_minutes: 30 }] }] }); }
  return null;
};
const from = new Date(Date.now() - 12 * 3600e3).toISOString(), to = new Date(Date.now() + 45 * DAY).toISOString();
const apps = await sq.listAppointments({ access_token: 't' }, { from, to });
ok(listCalls.length === 2 && listCalls.every((x) => x.pathname === '/v2/bookings' && x.searchParams.get('location_id') === 'L1' && Date.parse(x.searchParams.get('start_at_max')) - Date.parse(x.searchParams.get('start_at_min')) <= 31 * DAY) && apps.length === 2,
  'Square ListBookings: GET /v2/bookings, location_id, ≤31-day windows (45 days → 2 calls)');
net.route = (u) => u.includes('squareup') ? (u.includes('/v2/locations') ? J({ locations: [{ id: 'L1' }] }) : J({ errors: [{ detail: 'boom' }] }, 503)) : null;
let threw = null; try { await sq.listAppointments({ access_token: 't' }, { from, to }); } catch (e) { threw = e; }
ok(threw && /503/.test(threw.message), 'a Square outage THROWS (never "no appointments")');
T.integrations = [{ tenant_id: TID, provider: 'square', status: 'connected', access_token: 't' }];
T.cached_availability = [{ id: 'ca1', tenant_id: TID, provider: 'square', external_booking_id: 'KEEP', starts_at: at('10:00'), ends_at: at('11:00'), status: 'booked' }];
const sync = await import(P + 'lib/booking-sync.js');
let sres = await sync.syncTenantAvailability(db(), TID);
ok(sres.provider_errors.length === 1 && T.cached_availability.length === 1, 'booking-sync: provider error → the cached busy time is KEPT');
const inChair = { id: 'NOW1', start_at: new Date(Date.now() - 3600e3).toISOString(), appointment_segments: [{ duration_minutes: 120 }] };
let minSeen = null;
net.route = (u) => { if (!u.includes('squareup')) return null; if (u.includes('/v2/locations')) return J({ locations: [{ id: 'L1' }] }); const q = new URL(u).searchParams; minSeen = minSeen || q.get('start_at_min'); return J({ bookings: [inChair] }); };
sres = await sync.syncTenantAvailability(db(), TID);
ok(Date.now() - Date.parse(minSeen) >= 11.9 * 3600e3 && T.cached_availability.some((x) => x.external_booking_id === 'NOW1'), 'sync looks back 12h: the appointment in the chair right now stays busy');
// create
T.provider_mappings = [{ tenant_id: TID, provider: 'square', entity_type: 'service', local_id: 'cut', external_id: 'VAR1' },
  { tenant_id: TID, provider: 'square', entity_type: 'staff', local_id: 'ana', external_id: 'TM_ANA' }];
const sqCreate = [];
net.route = (u, init) => {
  if (!u.includes('squareup')) return null;
  sqCreate.push({ u, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
  if (u.includes('/v2/locations')) return J({ locations: [{ id: 'L1' }] });
  if (u.includes('/v2/catalog/object/VAR1')) return J({ object: { id: 'VAR1', version: 1717 } });
  if (u.includes('/v2/customers/search')) return J({});
  if (u.endsWith('/v2/customers')) return J({ customer: { id: 'CUST9' } });
  if (u.endsWith('/v2/bookings')) return J({ booking: { id: 'SQNEW', start_at: at('10:00'), appointment_segments: [{ duration_minutes: 60 }] } });
  return J({});
};
const made = await sq.createAppointment({ tenant_id: TID, access_token: 't' }, { starts_at: at('10:00'), duration_min: 60, local_booking_id: 'bk-777', local_service_id: 'cut', local_staff_id: 'ana', service_id: 'cut', team_member_id: 'ana', client_phone: '+13055554444', client_name: 'Sarah Kim' });
const post = sqCreate.find((x) => x.u.endsWith('/v2/bookings'))?.body;
const seg = post?.booking.appointment_segments[0];
ok(made.id === 'SQNEW' && seg.service_variation_id === 'VAR1' && seg.service_variation_version === 1717 && seg.team_member_id === 'TM_ANA' && post.booking.customer_id === 'CUST9' && post.idempotency_key === 'lola-bk-777',
  'Square create: variation via provider_mappings, real catalog version, customer found-or-created by phone, mapped team member, idempotency key = the LolaDesk booking id');

// ── 10. Google: errors throw, expired tokens refresh (and persist) ──
reset();
const g = await import(P + 'lib/connectors/google-calendar.js');
let refreshed = 0;
net.route = (u, init) => {
  if (u.includes('oauth2.googleapis.com/token')) { refreshed++; return J({ access_token: 'fresh', expires_in: 3600 }); }
  if (u.includes('googleapis.com/calendar')) return init.headers?.Authorization === 'Bearer fresh' ? J({ items: [{ id: 'e1', start: { dateTime: at('10:00') }, end: { dateTime: at('11:00') } }] }) : J({ error: { message: 'invalid' } }, 401);
  return null;
};
T.integrations = [{ tenant_id: TID, provider: 'google_calendar', status: 'connected', access_token: 'old', refresh_token: 'r', expires_at: new Date(Date.now() - 60e3).toISOString() }];
const gi = { ...T.integrations[0] };
const evs = await g.listAppointments(gi, {});
ok(refreshed === 1 && evs.length === 1 && T.integrations[0].expires_at !== gi.expires_at - 0 && T.integrations[0].access_token && T.integrations[0].access_token !== 'old', 'expired Google token → refreshed, used, and the new token persisted (encrypted)');
net.route = (u) => u.includes('googleapis.com/calendar') ? J({ error: { message: 'down' } }, 500) : null;
threw = null; try { await g.listAppointments({ access_token: 'x', expires_at: new Date(Date.now() + 3600e3).toISOString() }, {}); } catch (e) { threw = e; }
ok(threw && /500/.test(threw.message), 'a Google outage THROWS (cache kept by booking-sync)');

// ── 11. Series: DST-safe weekly, validate-all-then-write, blocked time in salon time ──
reset();
globalThis.__authUsers = { tok: { id: 'u1', email: 'o@mma.com' } };
const salon = (await import(P + 'salon.js')).default;
r = await call(salon, { headers: { authorization: 'Bearer tok' }, body: { resource: 'appointment', service_ids: ['cut'], staff_id: 'ana', client_name: 'Sarah Kim', client_phone: '+13055554444',
  starts_at: zonedLocalToUtc('2026-10-27', '10:00:00', TZ), repeat: { rule: 'weekly', count: 2 } } });
const occ = T.bookings.map((b) => b.start_time).sort();
ok(r.ok && occ.length === 2 && occ[1] === zonedLocalToUtc('2026-11-03', '10:00:00', TZ), 'weekly series across Nov 1 DST: Nov 3 is still 10:00 AM in Miami (' + occ[1] + ')');
reset();
const sd = new Date(Date.now() + 10 * DAY).toLocaleDateString('en-CA', { timeZone: TZ });
const addD = (k, n) => new Date(Date.parse(k + 'T12:00:00Z') + n * DAY).toISOString().slice(0, 10);
for (let i = 0; i < 3; i++) T.bookings.push(B('ser' + i, 'ana', 'cut', at('10:00', addD(sd, 7 * i)), at('11:00', addD(sd, 7 * i)), { series_id: 'S', series_pos: i + 1 }));
T.blocked_slots = [{ id: 'blk', tenant_id: TID, staff_id: 'ana', blocked_date: addD(sd, 14), start_time: '12:00', end_time: '13:00' }];
r = await call(cal, { headers: { authorization: 'Bearer tok' }, body: { action: 'reschedule', booking_id: 'ser0', starts_at: at('12:00', sd), series_scope: 'following' } });
ok(r.status === 409 && r.moved_count === 0 && r.failed_at_occurrence === 3 && /blocked time/.test(r.error) && T.bookings.every((b) => b.start_time.includes('T14:00') || b.start_time.includes('T15:00')),
  'series move: the 3rd visit lands in a noon block (salon time, UTC server) → 409, NOTHING moved');
T.blocked_slots = [];
r = await call(cal, { headers: { authorization: 'Bearer tok' }, body: { action: 'reschedule', booking_id: 'ser0', starts_at: at('12:00', sd), series_scope: 'following' } });
ok(r.ok && r.series_moved === 2 && T.bookings.every((b) => b.start_time === at('12:00', b.start_time.slice(0, 10)) || new Date(b.start_time).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric' }) === '12 PM'), 'all clear → every occurrence moved to noon');

// ── 12. Dashboard cancel goes through the canonical path ──
reset();
T.bookings.push(B('pend', 'ana', 'cut', at('10:00'), at('11:00'), { status: 'pending' }));
r = await call(salon, { headers: { authorization: 'Bearer tok' }, body: { resource: 'appointment', action: 'cancel', id: 'pend' } });
await sleep(20);
ok(r.ok && r.cancelled === 1 && !net.texts.length && T.booking_status_history.some((x) => x.booking_id === 'pend' && x.to_status === 'cancelled'), 'dashboard cancel of a PENDING row: history written, no "Cancelled" text');
T.bookings.push(B('conf', 'ana', 'cut', at('12:00'), at('13:00')));
T.booking_waitlist = [{ id: 'w1', tenant_id: TID, status: 'active', client_phone: '+13055557777', sms_consent: true, service_id: 'cut', created_at: new Date().toISOString() }];
r = await call(salon, { headers: { authorization: 'Bearer tok' }, body: { resource: 'appointment', action: 'cancel', id: 'conf' } });
await sleep(20);
ok(r.ok && net.texts.filter((t) => /cancel/i.test(t.text || '')).length === 1 && r.waitlist_offer?.ok, 'a confirmed one: exactly one cancel text, and the freed slot goes to the waitlist');

// ── 13. Deposits: the salon's window, the real cancel time, only what's due ──
reset({ cancellation_window_hours: 48 });
const dep = await import(P + 'lib/deposits.js');
T.bookings.push(B('d1', 'ana', 'cut', new Date(Date.now() + 30 * 3600e3).toISOString(), new Date(Date.now() + 31 * 3600e3).toISOString(),
  { status: 'cancelled', cancelled_at: new Date(Date.now() - 3600e3).toISOString(), updated_at: new Date().toISOString() }));
T.deposits = [{ id: 'dp1', tenant_id: TID, booking_id: 'd1', amount: 20, status: 'paid', stripe_payment_intent_id: 'pi_1', created_at: new Date().toISOString() }];
const refunds = [];
let sw = await dep.runDepositSweep(new Date(), { send: async () => ({}), refund: async (pi) => { refunds.push(pi); } });
ok(sw.kept === 1 && !refunds.length && T.deposits[0].status === 'kept', 'cancelled 30h before with a 48h window → deposit kept (it used to refund on a 0-minute grace)');
T.bookings[0].start_time = new Date(Date.now() + 72 * 3600e3).toISOString(); T.deposits[0].status = 'paid';
sw = await dep.runDepositSweep(new Date(), { send: async () => ({}), refund: async (pi) => { refunds.push(pi); } });
ok(sw.refunded === 1 && refunds[0] === 'pi_1', 'cancelled 72h before (cancelled_at) → refunded');
reset();
for (let i = 0; i < 250; i++) { T.bookings.push(B('f' + i, 'bo', 'cut', new Date(Date.now() + (5 + i) * DAY).toISOString(), new Date(Date.now() + (5 + i) * DAY + 3600e3).toISOString())); T.deposits.push({ id: 'p' + String(i).padStart(3, '0'), tenant_id: TID, booking_id: 'f' + i, amount: 10, status: 'pending', created_at: new Date(Date.now() - 9 * DAY).toISOString() }); }
T.bookings.push(B('due', 'ana', 'cut', new Date(Date.now() - 60e3).toISOString(), new Date(Date.now() + 3600e3).toISOString()));
T.deposits.push({ id: 'zzz', tenant_id: TID, booking_id: 'due', amount: 10, status: 'pending', created_at: new Date().toISOString() });
sw = await dep.runDepositSweep(new Date(), { send: async () => ({}) });
ok(sw.flagged === 1 && T.deposits.find((d) => d.id === 'zzz').status === 'flagged', '250 not-yet-due deposits ahead of it never starve the one that IS due');
reset();
T.deposits = [{ id: 'hx', tenant_id: TID, booking_id: 'hb', amount: 10, status: 'pending', created_at: new Date(Date.now() - 30 * 60e3).toISOString() }];
T.booking_settings[0].metadata = { deposits: { enabled: true, percent: 20, hold_minutes: 10 } };
T.bookings.push(B('hb', 'ana', 'cut', at('15:00'), at('16:00')));
sw = await dep.runDepositSweep(new Date(), { send: async () => ({}) });
ok(sw.released === 1 && T.bookings.find((b) => b.id === 'hb').status === 'cancelled' && T.booking_status_history.some((x) => x.booking_id === 'hb' && x.reason === 'deposit_unpaid'), 'unpaid-deposit release goes through the canonical cancel (history, upstream, waitlist)');

// ── 14. Reminders: a real 2-hour window, fresh bookings skipped, only "sent" when sent ──
reset();
const rem = await import(P + 'lib/booking-reminders.js');
const mk = (id, inMin, createdMinAgo) => B(id, 'ana', 'cut', new Date(Date.now() + inMin * 60e3).toISOString(), new Date(Date.now() + (inMin + 60) * 60e3).toISOString(), { created_at: new Date(Date.now() - createdMinAgo * 60e3).toISOString() });
T.bookings.push(mk('r2h', 120, 600), mk('r3h', 180, 600), mk('rFresh', 120, 30));
let due = await rem.findDueBookings(new Date(), db(), rem.REMINDER_BANDS[1]);
ok(due.map((b) => b.id).join() === 'r2h', '2h band = 1h45–2h15 before (3h out is not "2 hours"); a booking made 30 min ago is skipped');
const sent = await rem.runReminders(new Date(), { send: async () => ({ skipped: true, failed: true, reason: 'opted_out' }) });
ok(sent.sent === 0 && sent.failed === 1 && T.booking_reminders.find((x) => x.booking_id === 'r2h')?.status === 'failed', 'Telnyx refused → reminder logged failed, never "sent"');
const tx = await repo.sendConfirmationSMS({ tenantId: TID, clientId: 'c1', serviceId: 'cut', startTime: at('10:00') });
ok(tx.sent === true, 'confirmation text: sent:true only when Telnyx accepted');
net.route = (u) => u.includes('/v2/messages') ? J({ errors: [{ detail: 'not enabled' }] }, 422) : null;
const tx2 = await repo.sendConfirmationSMS({ tenantId: TID, clientId: 'c1', serviceId: 'cut', startTime: at('10:00') });
ok(tx2.sent === false && /not enabled/.test(tx2.reason), 'a rejected confirmation text reports sent:false with the reason');

// ── 15. Gap fill: first "yes" wins, later ones go to the waitlist ──
reset();
const gap = await import(P + 'lib/gap-fill-booking.js');
T.clients.push({ id: 'c2', tenant_id: TID, name: 'Mia', phone: '+13055551212' });
const yes = await Promise.all(['c1', 'c2'].map((cid) => gap.bookGapFillSlot({ tenantId: TID, clientId: cid, startsAt: at('15:00'), durationMin: 60, serviceId: 'cut', staffId: 'bo' })));
ok(yes.filter((x) => x.ok).length === 1 && yes.filter((x) => x.taken).length === 1 && T.bookings.length === 1, 'two "yes" answers for one gap → one booking, the other gets { taken:true }');
const yes2 = await Promise.all(['c1', 'c2'].map((cid) => gap.bookGapFillSlot({ tenantId: TID, clientId: cid, startsAt: at('09:00'), durationMin: 45 })));
ok(yes2.filter((x) => x.ok).length === 1 && yes2.filter((x) => x.taken).length === 1, 'same without catalog ids (unassigned lane)');

// ── 16. Owner line: PIN guesses capped, salon-time labels ──
reset();
const opdb = await import(P + 'lib/operator-db.js');
T.tenants[0].operator_pin_hash = opdb.hashPin('4321');
T.bookings.push(B('ob', 'ana', 'cut', at('14:00'), at('15:00')));
const op = (await import(P + 'operator-tools.js')).default;
const OP = (body) => call(op, { query: { tenant: 'mma' }, body, headers: { 'x-lola-operator-secret': 'op-master' } });
r = await OP({ tool: 'cancel_appointment', date: day, time: '2pm' });
ok(r.needs_confirmation && /2:00\sPM/.test(r.speak), 'owner line speaks the salon time ("2:00 PM"), not UTC: ' + r.speak);
const token = r.confirm_token;
for (let i = 0; i < 5; i++) await OP({ tool: 'cancel_appointment', confirm: true, confirm_token: token, pin: '0000' });
r = await OP({ tool: 'cancel_appointment', confirm: true, confirm_token: token, pin: '4321' });
ok(r.locked && T.bookings[0].status === 'confirmed' && T.public_rate_hits.filter((x) => x.key === 'pin:' + TID).length === 5, '5 wrong PINs in an hour → even the right PIN is refused (shared counter)');
r = await OP({ tool: 'move_appointment', date: day, time: '2pm', new_date: 'tomorrow' });
ok(r.needs === 'new_time' && !r.confirm_token, 'owner "move it to tomorrow" with no time → Lola asks what time');

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
