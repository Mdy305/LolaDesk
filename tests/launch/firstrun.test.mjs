// First-run signal for Home: a salon with no calls, bookings or clients ever
// gets setup.isNew — and loses it the moment anything real happens.
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'service-key';
const { T } = await import('./fake-supabase.mjs');
const P = new URL('../../api/', import.meta.url).href;
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };

globalThis.__authUsers = { 'owner-token-0123456789': { id: 'u1', email: 'owner@new.salon' } };
T.tenants = [{ id: 't1', name: 'New Salon', slug: 'new-salon', owner_email: 'owner@new.salon', phone_number: '+13055550199', plan: 'starter', created_at: '2026-09-01' }];
T.tenant_users = []; T.clients = []; T.calls = []; T.bookings = []; T.services = []; T.usage_events = [];

const data = (await import(P + 'data-safe.js')).default;
const call = (resource = 'overview', token = 'owner-token-0123456789') => new Promise((resolve) => {
  const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(o) { resolve({ status: this.statusCode, body: o }); }, end(b) { resolve({ status: this.statusCode, body: b }); } };
  data({ method: 'GET', url: '/api/data-safe?resource=' + resource, headers: token ? { authorization: 'Bearer ' + token } : {} }, res);
});

let r = await call();
ok(r.status === 200 && r.body.setup, 'overview carries a setup block');
ok(r.body.setup?.isNew === true, 'brand-new salon → isNew (first-run guide shows)');
ok(r.body.setup?.phoneNumber === '+13055550199', "guide knows Lola's number");
ok(/\/book\?t=new-salon$/.test(r.body.setup?.bookingUrl || ''), 'guide knows the booking link: ' + r.body.setup?.bookingUrl);
ok(r.body.setup?.servicesCount === 0, 'no menu yet → "Add your menu" move');

T.services = [{ id: 's1', tenant_id: 't1', name: 'Cut' }];
r = await call();
ok(r.body.setup?.servicesCount === 1 && r.body.setup?.isNew === true, 'menu added → still new, but the menu move is done');

// The owner calls Lola to hear her — that call alone ends the first run,
// even though it's older than the 30-day KPI window would ever show.
T.calls = [{ id: 'c1', tenant_id: 't1', created_at: '2025-01-01T10:00:00Z' }];
r = await call();
ok(r.body.setup?.isNew === false, 'first real call (any date) → guide retires');

T.calls = []; T.bookings = [{ id: 'b1', tenant_id: 't1', start_time: '2025-02-01T15:00:00Z', total_amount: 80 }];
r = await call();
ok(r.body.setup?.isNew === false, 'a booking ever → not new');

T.bookings = []; T.clients = [{ id: 'cl1', tenant_id: 't1', first_name: 'Ana' }];
r = await call();
ok(r.body.setup?.isNew === false, 'an imported client → not new');

T.tenants[0].slug = null; T.tenants[0].booking_url = 'https://mma.salon/book'; T.clients = [];
r = await call();
ok(r.body.setup?.bookingUrl === 'https://mma.salon/book', "salon's own booking link wins when set");

r = await call('overview', null);
ok(r.status === 401 && !r.body.setup, 'signed out → 401, no setup data');

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
