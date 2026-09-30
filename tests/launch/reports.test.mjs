// Reports read real bookings: Revenue's range read, staff performance,
// and a client's visit history. Owner-only — never through the public widget.
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'k';
globalThis.fetch = async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
const { T } = await import('./fake-supabase.mjs');
const P = new URL('../../api/', import.meta.url).href;
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const TID = '00000000-0000-4000-8000-0000000000aa', DAY = 864e5, now = Date.now();
globalThis.__authUsers = { tok: { id: 'u1', email: 'owner@salon.com' } };
T.tenants = [{ id: TID, name: 'Salon', slug: 'salon', owner_email: 'owner@salon.com', subscription_status: 'active' }];
T.tenant_users = [{ user_id: 'u1', tenant_id: TID, role: 'owner', status: 'active' }];
T.booking_settings = [{ tenant_id: TID, timezone: 'America/New_York' }];
T.tenant_onboarding = [{ tenant_id: TID, status: 'complete' }];
T.services = [{ id: 's1', tenant_id: TID, name: 'Balayage', price: 250, duration_minutes: 180, is_active: true }, { id: 's2', tenant_id: TID, name: 'Blowout', price: 55, duration_minutes: 45, is_active: true }];
T.staff = [{ id: 'st1', tenant_id: TID, name: 'Priya', is_active: true }, { id: 'st2', tenant_id: TID, name: 'Ana', is_active: true }];
T.staff_schedules = []; T.clients = [{ id: 'c1', tenant_id: TID, first_name: 'Nia', phone: '+13055550001' }];
const bk = (id, d, staff, svc, amt, status, client = 'c9') => ({ id, tenant_id: TID, client_id: client, staff_id: staff, service_id: svc, total_amount: amt, status, start_time: new Date(now + d * DAY).toISOString(), end_time: new Date(now + d * DAY + 3600e3).toISOString(), duration_min: 60 });
T.bookings = [bk('b1', -3, 'st1', 's1', 250, 'completed', 'c1'), bk('b2', -2, 'st1', 's2', 55, 'confirmed'), bk('b3', -1, 'st2', 's2', 55, 'completed', 'c1'), bk('b4', -1, 'st2', 's1', 250, 'cancelled'), bk('b5', 3, 'st1', 's1', 250, 'confirmed', 'c1'), bk('b6', -200, 'st1', 's1', 250, 'completed', 'c1')];

const run = async (mod, { query = {}, headers = { authorization: 'Bearer tok' }, pub = false, method = 'GET' } = {}) => {
  const h = (await import(P + mod)).default;
  return new Promise((resolve) => { const res = { statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(o) { resolve({ status: this.statusCode, ...o }); }, end() { resolve({ status: this.statusCode }); } };
    const req = { method, url: '/api/' + mod, headers, query, body: {} }; if (pub) req.__publicBooking = true; h(req, res); });
};
const key = (d) => new Date(now + d * DAY).toISOString().slice(0, 10);

let r = await run('calendar.js', { query: { action: 'range', from: key(-30), to: key(0) } });
ok(r.ok && Array.isArray(r.bookings), 'owner can read a date range');
ok(r.bookings.length === 3 && !r.bookings.some(b => b.id === 'b4') && !r.bookings.some(b => b.id === 'b6'), `range holds the 30 days, cancelled left out (${r.bookings.map(b => b.id).join(',')})`);
const b1 = r.bookings.find(b => b.id === 'b1');
ok(b1 && b1.service_name === 'Balayage' && b1.staff_name === 'Priya' && b1.total_amount === 250, 'rows carry service, stylist and dollars');
r = await run('calendar.js', { query: { action: 'range', from: key(-3650), to: key(365), client_id: 'c1' } });
ok(r.ok && r.bookings.map(b => b.id).sort().join(',') === 'b1,b3,b5,b6', 'client history spans years for one client only');
r = await run('calendar.js', { query: { action: 'range', from: key(-30), to: key(0), tenant: 'salon' }, headers: {}, pub: true });
ok(r.status === 404 && !r.bookings, 'the public widget can never read the book');
r = await run('calendar.js', { query: { action: 'range', from: key(-30), to: key(0) }, headers: {} });
ok(r.status === 401 && !r.bookings, 'signed-out requests are refused');

r = await run('revenue/staff.js', { query: { range: '30d' } });
const pr = (r.staff || []).find(s => s.name === 'Priya'), an = (r.staff || []).find(s => s.name === 'Ana');
ok(pr && pr.bookings === 2 && pr.revenue === 305 && pr.revenue_cents === 30500, 'staff performance counts real bookings by status (Priya: 2, $305)');
ok(an && an.bookings === 1 && an.revenue_cents === 5500, 'cancelled and future bookings are not counted (Ana: 1, $55)');
ok(pr.hours === 2, 'hours come from real durations');

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
