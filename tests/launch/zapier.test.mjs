// Boulevard (or any system Zapier speaks to) ↔ Lola, both ways, no partner approval.
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'k';
process.env.INTEGRATION_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString('base64');
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const zaps = []; let zapStatus = 200;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  if (u.startsWith('https://hooks.zapier.com/')) { zaps.push(JSON.parse(init.body)); return J({ status: 'success' }, zapStatus); }
  if (u.includes('/v2/messages')) return J({ data: { id: 'm' } });
  return J({ data: [] });
};
const { T } = await import('./fake-supabase.mjs');
const P = new URL('../../api/', import.meta.url).href;
const { db } = await import(P + 'lib/db.js');
const TZ = 'America/New_York', TID = '00000000-0000-4000-8000-0000000000z1', DAY = 864e5;
const day = new Date(Date.now() + 3 * DAY).toLocaleDateString('en-CA', { timeZone: TZ });
const at = (hhmm) => { const d = new Date(`${day}T${hhmm}:00Z`); const off = (new Date(d.toLocaleString('en-US', { timeZone: 'UTC' })) - new Date(d.toLocaleString('en-US', { timeZone: TZ }))); return new Date(d.getTime() + off).toISOString(); };
T.tenants = [{ id: TID, name: 'MMA Salon', slug: 'mma', subscription_status: 'active', phone_number: '+13055550100', operator_phone: '+17865550199' }];
T.tenant_users = [{ user_id: 'u1', tenant_id: TID, role: 'owner', status: 'active' }];
globalThis.__authUsers = { tok: { id: 'u1', email: 'o@mma.com' } };
T.booking_settings = [{ tenant_id: TID, timezone: TZ, slot_interval_minutes: 30, minimum_notice_minutes: 0, booking_horizon_days: 90, default_buffer_before_min: 0, default_buffer_after_min: 0 }];
T.services = [{ id: 'cut', tenant_id: TID, name: 'Cut', duration_minutes: 60, price: 80, is_active: true }];
T.staff = [{ id: 'ana', tenant_id: TID, name: 'Ana Ruiz', is_active: true }, { id: 'bo', tenant_id: TID, name: 'Bo Lee', is_active: true }];
T.staff_services = []; T.staff_schedules = []; for (const s of ['ana', 'bo']) for (let d = 0; d < 7; d++) T.staff_schedules.push({ tenant_id: TID, staff_id: s, day_of_week: d, start_time: '09:00', end_time: '17:00' });
T.staff_time_off = []; T.blocked_slots = []; T.bookings = []; T.availability_holds = []; T.clients = []; T.locations = []; T.business_hours = [];
T.cached_availability = []; T.provider_mappings = []; T.booking_outbox = []; T.integrations = []; T.tenant_channels = []; T.client_memories = []; T.usage_events = [];
const run = async (mod, req) => { const h = (await import(P + mod)).default; return new Promise((resolve) => { const res = { statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(o) { resolve({ status: this.statusCode, ...o }); }, end() { resolve({ status: this.statusCode }); } }; h({ method: 'POST', headers: { authorization: 'Bearer tok' }, query: {}, ...req }, res); }); };
const { getAvailability } = await import(P + 'lib/availability-engine-v2.js');
const free = async (hhmm) => (await getAvailability({ tenantId: TID, serviceId: 'cut', date: at(hhmm), limit: 500 })).slots.filter((s) => s.starts_at === at(hhmm)).map((s) => s.staff_id).sort().join();

// ── IN: Boulevard → Lola within seconds ──
const zb = await import(P + 'lib/zapier-bridge.js');
let r = await run('zapier.js', { method: 'GET' });
const url = new URL(r.inbound_url);
ok(url.pathname === '/api/hooks/booking' && url.searchParams.get('t') === TID && url.searchParams.get('k').length === 32, 'Settings shows the salon’s private hook link');
const q = { t: TID, k: url.searchParams.get('k') };
r = await run('hooks/booking.js', { method: 'GET', query: q });
ok(r.ok && r.salon === 'MMA Salon', 'Zapier’s “test” GET succeeds');
r = await run('hooks/booking.js', { query: { t: TID, k: 'x'.repeat(32) }, body: { id: 'a' } });
ok(r.status === 401, 'a forged link is refused');
r = await run('hooks/booking.js', { query: q, body: { event: 'new', id: 'blvd_1', start: `${day} 10:00`, end: `${day} 11:00`, staff: 'Ana Ruiz', service: 'Balayage', client: 'Kim' } });
ok(r.ok && r.action === 'blocked' && r.staff_matched && (await free('10:00')) === 'bo', 'New Appointment (Boulevard, salon time) → Ana is busy for Lola at once');
r = await run('hooks/booking.js', { query: q, body: { event: 'rescheduled', id: 'blvd_1', start: at('13:00'), duration: 60, staff: 'ana' } });
ok(r.action === 'moved' && (await free('10:00')) === 'ana,bo' && (await free('13:00')) === 'bo', 'Appointment Rescheduled → the old time frees, the new time blocks (first name matches too)');
r = await run('hooks/booking.js', { query: q, body: { event: 'new', id: 'blvd_2', start: at('15:00'), duration: 60 } });
r = await run('hooks/booking.js', { query: q, body: { event: 'new', id: 'blvd_3', start: at('15:00'), duration: 60, staff: 'Someone New' } });
ok((await free('15:00')) === '', 'unassigned appointments take chairs (two at 3pm → nobody free)');
r = await run('hooks/booking.js', { query: q, body: { event: 'cancelled', id: 'blvd_2' } });
ok(r.action === 'freed' && (await free('15:00')) !== '', 'Appointment Cancelled → the chair opens up');
r = await run('hooks/booking.js', { query: q, body: { event: 'new', id: 'x', start: 'not a date' } });
ok(r.status === 400 && /start/.test(r.error), 'a bad field mapping says what’s wrong');

// ── OUT: Lola → Boulevard (Create Timeblock) ──
r = await run('zapier.js', { body: { url: 'https://evil.example.com/hook' } });
ok(r.status === 400, 'only real Zapier hook URLs are accepted');
r = await run('zapier.js', { body: { url: 'https://hooks.zapier.com/hooks/catch/123/abc/' } });
ok(r.ok && zaps.at(-1)?.event === 'test' && T.tenant_channels.some((x) => x.channel === 'zapier' && x.status === 'active' && !/hooks\.zapier/.test(x.access_token || 'hooks.zapier')), 'Connect sends Zapier a test booking (to map fields) and saves the hook');
const { SKILLS } = await import(P + 'lola-tools.js');
zaps.length = 0;
const bk = await SKILLS.book_appointment(T.tenants[0], { service: 'Cut', date: day, time: '11:30am', client_name: 'Sarah Kim', client_phone: '+13055554444' });
const outbox = await import(P + 'lib/booking-outbox.js');
await new Promise((r) => setTimeout(r, 300));   // the write-through runs right after the reply
await outbox.processOutbox(db(), { now: Date.now() + 1000 });
const ev = zaps.find((z) => z.event === 'booking.created');
ok(bk.booked && ev && ev.client_name === 'Sarah Kim' && ev.service === 'Cut' && ev.duration_min === 60 && /^Lola: Sarah Kim — Cut$/.test(ev.title) && ev.start_local.endsWith('11:30'), 'Lola books → Boulevard gets a time block with who, what, when: ' + (ev && ev.title + ' @ ' + ev.start_local));
ok(T.booking_outbox[0]?.status === 'done' && T.booking_outbox[0]?.provider === 'zapier', 'the write-through is marked done through Zapier');
await outbox.processOutbox(db(), { now: Date.now() + 120e3 });
ok(zaps.filter((z) => z.event === 'booking.created').length === 1, 'never sent twice');
zapStatus = 500; zaps.length = 0;
const bk2 = await SKILLS.book_appointment(T.tenants[0], { service: 'Cut', date: day, time: '2:00pm', client_name: 'Mia', client_phone: '+13055551212' });
await new Promise((r) => setTimeout(r, 300));
await outbox.processOutbox(db(), { now: Date.now() + 1000 });
const row2 = T.booking_outbox.find((x) => x.status !== 'done');
ok(bk2.booked && row2 && row2.status === 'pending' && /Zapier answered 500/.test(row2.last_error), 'Zapier down → retried later, the booking is safe in LolaDesk');
zapStatus = 200;
const cl = T.clients.find((c) => c.phone === '+13055554444');
const b1 = T.bookings.find((b) => b.client_id === cl.id);
zaps.length = 0;
await zb.emitBooking(db(), T.tenants[0], b1.id, 'booking.cancelled');
ok(zaps[0]?.event === 'booking.cancelled' && zaps[0].booking_id === b1.id, 'Lola cancels → the Zap hears booking.cancelled');

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
