process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k';
process.env.TELNYX_API_KEY = 'k';
const sent = []; const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => { sent.push({ url: String(url), body: init && init.body }); return new Response(JSON.stringify({ data: { id: 'msg1' } }), { status: 200, headers: { 'content-type': 'application/json' } }); };
const P = new URL('../../api/', import.meta.url).href;
const { T } = await import('./fake-supabase.mjs');
const { getAvailability, holdAvailability } = await import(P + 'lib/availability-engine-v2.js');
const cal = (await import(P + 'calendar.js')).default;
const pub = (await import(P + 'public-booking.js')).default;
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };

// ── a salon in Miami, two stylists, both 9–17 every day ──
const TID = '11111111-1111-4111-8111-111111111111';
const TZ = 'America/New_York';
T.tenants = [{ id: TID, slug: 'mma', name: 'MMA Salon', phone_number: '+13055550100', services: [] },
             { id: '22222222-2222-4222-8222-222222222222', slug: 'other', name: 'Other Salon', phone_number: '+13055550199' }];
T.booking_settings = [{ tenant_id: TID, timezone: TZ, slot_interval_minutes: 30, minimum_notice_minutes: 0, booking_horizon_days: 90,
  default_buffer_before_min: 0, default_buffer_after_min: 0, allow_processing_overlap: true, metadata: { deposits: { enabled: true, percent: 20 } } }];
T.services = [{ id: 'svc_cut', tenant_id: TID, name: 'Cut', duration_minutes: 60, price: 80, is_active: true, internal_cost: 12 }];
T.staff = [{ id: 'st_a', tenant_id: TID, name: 'Ana', is_active: true, phone: '+13055551111' }, { id: 'st_b', tenant_id: TID, name: 'Bo', is_active: true }];
T.staff_services = [];
T.staff_schedules = [];
for (const s of ['st_a', 'st_b']) for (let d = 0; d < 7; d++) T.staff_schedules.push({ tenant_id: TID, staff_id: s, day_of_week: d, start_time: '09:00', end_time: '17:00' });
T.staff_time_off = []; T.blocked_slots = []; T.bookings = []; T.availability_holds = []; T.clients = [];
T.locations = []; T.business_hours = [];

// a date a few days out, in salon time
const day = new Date(Date.now() + 3 * 86400e3).toLocaleDateString('en-CA', { timeZone: TZ });
const at = (hhmm) => { const d = new Date(`${day}T${hhmm}:00Z`); const off = (new Date(d.toLocaleString('en-US', { timeZone: 'UTC' })) - new Date(d.toLocaleString('en-US', { timeZone: TZ }))); return new Date(d.getTime() + off).toISOString(); };

// 1. all stylists, sorted, limit honored
let av = await getAvailability({ tenantId: TID, serviceId: 'svc_cut', date: day, limit: 500 });
ok(av.ok && av.slots.length === 30, `30 slots across 2 stylists (got ${av.slots.length})`);
ok(av.slots.every((s, i, a) => i === 0 || Date.parse(a[i - 1].starts_at) <= Date.parse(s.starts_at)), 'slots sorted by time across stylists');
ok(av.slots[0].starts_at === at('09:00'), `first slot is 9:00 salon time (${av.slots[0].starts_at} vs ${at('09:00')})`);
ok(av.slots.some(s => s.staff_id === 'st_b' && s.starts_at === at('16:00')), "Bo's 4pm slot shows (used to be cut at 12 of Ana's)");

// 2. back-to-back before an existing booking (Postgres "+00:00" timestamps)
const pg = (iso) => iso.replace('.000Z', '+00:00');
T.bookings.push({ id: 'bk1', tenant_id: TID, staff_id: 'st_a', service_id: 'svc_cut', start_time: pg(at('11:00')), end_time: pg(at('12:00')), status: 'confirmed' });
av = await getAvailability({ tenantId: TID, serviceId: 'svc_cut', date: day, staffId: 'st_a', limit: 500 });
const aT = av.slots.map(s => s.starts_at);
ok(aT.includes(at('10:00')), '10:00–11:00 fits right before an 11:00 booking');
ok(!aT.includes(at('10:30')) && !aT.includes(at('11:00')) && !aT.includes(at('11:30')), 'overlapping times blocked');
ok(aT.includes(at('12:00')), '12:00 open right after it ends');

// 3. booking longer than its service (multi-service) blocks its real length
T.bookings.push({ id: 'bk2', tenant_id: TID, staff_id: 'st_a', service_id: 'svc_cut', start_time: pg(at('14:00')), end_time: pg(at('16:00')), status: 'confirmed' });
av = await getAvailability({ tenantId: TID, serviceId: 'svc_cut', date: day, staffId: 'st_a', limit: 500 });
ok(!av.slots.some(s => s.starts_at === at('15:00')), 'a 2h booking blocks its whole 2 hours');

// 4. time off with starts_at/ends_at columns
T.staff_time_off.push({ tenant_id: TID, staff_id: 'st_b', starts_at: at('09:00'), ends_at: at('13:00') });
av = await getAvailability({ tenantId: TID, serviceId: 'svc_cut', date: day, staffId: 'st_b', limit: 500 });
ok(av.slots[0].starts_at === at('13:00'), "Bo's time off until 1pm respected");

// 5. staff_services table missing → everyone does everything (no crash)
globalThis.__missing = new Set(['staff_services']);
av = await getAvailability({ tenantId: TID, serviceId: 'svc_cut', date: day, limit: 500 });
ok(av.ok && av.slots.length > 0, 'missing staff_services table degrades safely');
globalThis.__missing = null;

// ── public widget, through the real handlers ──
function call(handler, { method = 'POST', query = {}, body = {} }) {
  return new Promise((resolve) => {
    const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; },
      json(o) { resolve({ status: this.statusCode, body: o }); return this; }, end() { resolve({ status: this.statusCode, body: null }); return this; }, send(o) { resolve({ status: this.statusCode, body: o }); } };
    handler({ method, query, body, headers: {} }, res);
  });
}
let r = await call(pub, { method: 'GET', query: { action: 'catalog', tenant: 'mma' } });
ok(r.body.ok && r.body.salon.name === 'MMA Salon' && r.body.salon.timezone === TZ, 'public catalog: salon name + time zone');
ok(!('internal_cost' in r.body.services[0]) && !('phone' in r.body.staff[0]), 'public catalog hides cost and stylist phones');
ok(r.body.deposit_policy && r.body.deposit_policy.amount === 20, 'public catalog carries the real deposit policy');

r = await call(pub, { method: 'GET', query: { action: 'catalog', tenant: 'typo-salon' } });
ok(r.status === 404, `unknown slug is 404, never the demo salon (got ${r.status})`);

r = await call(pub, { method: 'GET', query: { action: 'availability', tenant: 'mma', service_id: 'svc_cut', date: day, limit: 200 } });
ok(r.body.ok && r.body.slots.length > 12 && !r.body.settings, `public availability: full day, no settings leaked (${r.body.slots && r.body.slots.length})`);

// any available at 11:00 → Ana is busy, Bo is on time off → no one
r = await call(pub, { body: { action: 'book', tenant: 'mma', service_id: 'svc_cut', starts_at: at('11:00'), client_name: 'Test Client', client_phone: '3055552222', total_amount: 0.01 } });
ok(r.body.ok === false && r.body.conflict, '11:00 "any available" refused when nobody is free');

// any available at 13:00 → Bo (Ana free too) — someone gets it, price from the menu
r = await call(pub, { body: { action: 'book', tenant: 'mma', service_id: 'svc_cut', starts_at: at('13:00'), client_name: 'Test Client', client_phone: '3055552222', total_amount: 0.01 } });
const bk = r.body.booking;
ok(r.body.ok && bk && ['st_a', 'st_b'].includes(bk.staff_id), `"any available" booked with a free stylist (${bk && bk.staff_id})`);
ok(bk && Number(bk.total_amount) === 80, `price comes from the menu, not the browser (${bk && bk.total_amount})`);
ok(bk && !!bk.confirmation_code, 'confirmation code issued');

// double-book the same stylist at the same time → refused
r = await call(pub, { body: { action: 'book', tenant: 'mma', service_id: 'svc_cut', staff_id: bk.staff_id, starts_at: at('13:00'), client_name: 'Other', client_phone: '3055553333' } });
ok(r.body.ok === false, 'same stylist, same time → refused');

// reschedule keeps length and ignores itself
const code = bk.confirmation_code;
r = await call(pub, { body: { action: 'reschedule', tenant: 'mma', code, client_phone: '3055552222', starts_at: at('12:30'), staff_id: bk.staff_id } });
ok(r.body.ok, `reschedule 30 min earlier, overlapping its own old time, works (${JSON.stringify(r.body).slice(0, 120)})`);


const moved = T.bookings.find(b => b.id === bk.id);
ok(moved && Date.parse(moved.start_time) === Date.parse(at('12:30')) && Date.parse(moved.end_time) === Date.parse(at('13:30')), 'moved booking keeps its 1h length');

// cross-tenant: code from MMA can't be looked up via another salon
r = await call(pub, { body: { action: 'lookup', tenant: 'other', code, client_phone: '3055552222' } });
ok(r.body.ok === false, 'another salon cannot see this booking');

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
