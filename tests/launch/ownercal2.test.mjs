// Owner calendar 2 (bookings.html): the client card numbers
// (GET /api/calendar-owner?action=client_card), whole-salon and weekly-repeat
// blocks, block edit/delete (incl. "this + later weeks") through /api/salon,
// the owner's "Request deposit" action — all tenant-scoped.
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'k';
delete process.env.STRIPE_SECRET_KEY;
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
globalThis.fetch = async () => new Response(JSON.stringify({ id: 'plink_1', url: 'https://pay.example/x', data: { id: 'x' } }), { status: 200, headers: { 'content-type': 'application/json' } });
const { T } = await import('./fake-supabase.mjs');
const P = new URL('../../api/', import.meta.url).href;
const TID = '44444444-4444-4444-8444-444444444444', OTHER = '55555555-5555-4555-8555-555555555555', TZ = 'America/New_York', DAY = 864e5, H = 36e5;
const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();
const keyOf = (ms) => new Date(Date.now() + ms).toLocaleDateString('en-CA', { timeZone: TZ });
const reset = () => {
  T.tenants = [{ id: TID, name: 'MMA Salon', slug: 'mma', subscription_status: 'active', phone_number: '+13055550100' },
    { id: OTHER, name: 'Other Salon', slug: 'other', subscription_status: 'active', phone_number: '+13055550200' }];
  T.tenant_users = [{ user_id: 'u1', tenant_id: TID, role: 'owner', status: 'active' }, { user_id: 'u9', tenant_id: OTHER, role: 'owner', status: 'active' }];
  T.booking_settings = [{ tenant_id: TID, timezone: TZ, metadata: {} }, { tenant_id: OTHER, timezone: TZ, metadata: {} }];
  T.services = [{ id: 'cut', tenant_id: TID, name: 'Cut', duration_minutes: 60, price: 80, is_active: true },
    { id: 'color', tenant_id: TID, name: 'Color', duration_minutes: 120, price: 200, is_active: true }];
  T.staff = [{ id: 'ana', tenant_id: TID, name: 'Ana', is_active: true, color: '#ff6482' }, { id: 'bo', tenant_id: TID, name: 'Bo', is_active: true },
    { id: 'zed', tenant_id: OTHER, name: 'Zed', is_active: true }];
  T.staff_schedules = []; T.staff_time_off = []; T.blocked_slots = []; T.availability_holds = []; T.cached_availability = []; T.provider_mappings = [];
  T.clients = [{ id: 'c1', tenant_id: TID, name: 'Sarah Kim', phone: '+13055554444', is_vip: true },
    { id: 'c2', tenant_id: TID, name: 'New Face', phone: '+13055553333' },
    { id: 'cx', tenant_id: OTHER, name: 'Sarah Other', phone: '+13055559999' }];
  T.deposits = []; T.booking_status_history = []; T.booking_services = []; T.opt_outs = []; T.usage_events = []; T.tenant_channels = [];
  T.bookings = [
    // Sarah: 3 kept visits ($80 + $200 + $80), 1 no-show, 1 cancel, 2 upcoming.
    { id: 'p1', tenant_id: TID, client_id: 'c1', service_id: 'cut', staff_id: 'ana', start_time: iso(-60 * DAY), end_time: iso(-60 * DAY + H), status: 'completed', total_amount: 80 },
    { id: 'p2', tenant_id: TID, client_id: 'c1', service_id: 'color', staff_id: 'ana', start_time: iso(-30 * DAY), end_time: iso(-30 * DAY + 2 * H), status: 'completed', total_amount: 200 },
    { id: 'p3', tenant_id: TID, client_id: 'c1', service_id: 'cut', staff_id: 'bo', start_time: iso(-10 * DAY), end_time: iso(-10 * DAY + H), status: 'confirmed', total_amount: 80 },
    { id: 'p4', tenant_id: TID, client_id: 'c1', service_id: 'cut', staff_id: 'bo', start_time: iso(-20 * DAY), end_time: iso(-20 * DAY + H), status: 'no_show', total_amount: 80 },
    { id: 'p5', tenant_id: TID, client_id: 'c1', service_id: 'cut', staff_id: 'bo', start_time: iso(-5 * DAY), end_time: iso(-5 * DAY + H), status: 'cancelled', total_amount: 80 },
    { id: 'f1', tenant_id: TID, client_id: 'c1', service_id: 'cut', staff_id: 'ana', start_time: iso(2 * DAY), end_time: iso(2 * DAY + H), status: 'confirmed', total_amount: 80 },
    { id: 'f2', tenant_id: TID, client_id: 'c1', service_id: 'color', staff_id: 'bo', start_time: iso(9 * DAY), end_time: iso(9 * DAY + 2 * H), status: 'confirmed', total_amount: 200 },
    // Another salon's visit for "the same" person must never count.
    { id: 'x1', tenant_id: OTHER, client_id: 'cx', service_id: 'cut', staff_id: 'zed', start_time: iso(-3 * DAY), end_time: iso(-3 * DAY + H), status: 'completed', total_amount: 999 },
    { id: 'x2', tenant_id: OTHER, client_id: 'c1', service_id: 'cut', staff_id: 'zed', start_time: iso(-4 * DAY), end_time: iso(-4 * DAY + H), status: 'completed', total_amount: 777 },
  ];
};
reset();
globalThis.__authUsers = { tok: { id: 'u1', email: 'o@mma.com' }, othertok: { id: 'u9', email: 'o@other.com' } };
const run = async (mod, req, tok = 'tok') => { const h = (await import(P + mod)).default; return new Promise((resolve) => { const res = { statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(o) { resolve({ status: this.statusCode, ...o }); }, end() { resolve({ status: this.statusCode }); } }; h({ method: 'POST', headers: { authorization: 'Bearer ' + tok }, query: {}, ...req }, res); }); };
const ownerGet = (query, tok) => run('calendar-owner.js', { method: 'GET', query }, tok);
const owner = (body, tok) => run('calendar-owner.js', { body }, tok);
const salon = (body, tok) => run('salon.js', { body }, tok);

// ── 1. Client card numbers ──
let r = await ownerGet({ action: 'client_card', client_id: 'c1', booking_id: 'f1' });
ok(r.ok && r.client?.name === 'Sarah Kim' && r.client.is_vip === true, 'client card: name + VIP');
ok(r.stats?.visits === 3, 'visits = 2 completed + 1 past kept (no-show / cancelled excluded): ' + r.stats?.visits);
ok(r.stats?.lifetime_spend === 360, 'lifetime spend = $80 + $200 + $80 (other salon’s $777 ignored): ' + r.stats?.lifetime_spend);
ok(r.stats?.last_visit === T.bookings.find((b) => b.id === 'p3').start_time, 'last visit = the most recent kept visit (10 days ago)');
ok(r.stats?.no_shows === 1 && r.stats?.cancellations === 1, 'one no-show, one cancellation');
ok(r.next?.id === 'f2' && r.next.service_name === 'Color' && r.next.staff_name === 'Bo', 'next appointment skips the open booking (f1) → Color with Bo');
ok(r.stats?.upcoming === 1 && r.deposit === null, 'one other upcoming; no deposit on f1 yet');
r = await ownerGet({ action: 'client_card', client_id: 'c1' });
ok(r.ok && r.next?.id === 'f1' && r.stats.upcoming === 2, 'without booking_id the next visit is the soonest one (f1)');
r = await ownerGet({ action: 'client_card', client_id: 'c2' });
ok(r.ok && r.stats.visits === 0 && r.stats.lifetime_spend === 0 && r.stats.last_visit === null && r.next === null, 'a brand-new client: zeros, no next visit');
// ── 1b. Tenant isolation ──
r = await ownerGet({ action: 'client_card', client_id: 'cx' });
ok(!r.ok && r.status === 404, 'another salon’s client is refused (404)');
r = await ownerGet({ action: 'client_card', client_id: 'c1' }, 'othertok');
ok(!r.ok && r.status === 404, 'another salon’s owner cannot read this salon’s client');
r = await ownerGet({ action: 'client_card' });
ok(!r.ok && r.status === 400, 'client_id is required');
r = await ownerGet({ action: 'client_card', client_id: 'c1' }, 'nobody');
ok(!r.ok && r.status === 401, 'unauthenticated is refused');
T.deposits.push({ id: 'dx', tenant_id: OTHER, booking_id: 'f1', status: 'paid', amount: 5, created_at: iso(0) });
r = await ownerGet({ action: 'client_card', client_id: 'c1', booking_id: 'f1' });
ok(r.ok && r.deposit === null, 'a deposit row from another tenant is never shown');
T.deposits.push({ id: 'd1', tenant_id: TID, booking_id: 'f1', status: 'pending', amount: 20, created_at: iso(0) });
r = await ownerGet({ action: 'client_card', client_id: 'c1', booking_id: 'f1' });
ok(r.ok && r.deposit?.id === 'd1' && r.deposit.status === 'pending', 'the open booking’s deposit comes back with the card');

// ── 2. Request deposit ──
r = await owner({ action: 'request_deposit', booking_id: 'f1' });
ok(!r.ok && r.status === 409 && /already out/.test(r.error), 'a pending deposit is not requested twice: ' + r.error);
r = await owner({ action: 'request_deposit', booking_id: 'f2' });
ok(!r.ok && r.status === 409 && /Deposits are off/.test(r.error), 'deposits off → a clear message: ' + r.error);
T.booking_settings[0].metadata = { deposits: { enabled: true, percent: 25, who: 'risky' } };
r = await owner({ action: 'request_deposit', booking_id: 'f2' });
ok(!r.ok && /Connect Stripe/.test(r.error), 'no Stripe → tells the owner to connect it: ' + r.error);
r = await owner({ action: 'request_deposit', booking_id: 'p1' });
ok(!r.ok && r.status === 409, 'a completed past visit cannot get a deposit request');
r = await owner({ action: 'request_deposit', booking_id: 'x1' });
ok(!r.ok && r.status === 404, 'another salon’s booking is refused');
process.env.STRIPE_SECRET_KEY = 'sk_test_x';
r = await owner({ action: 'request_deposit', booking_id: 'f2' });
ok(r.ok && r.amount_cents === 5000 && T.deposits.some((d) => d.booking_id === 'f2' && d.tenant_id === TID && d.status === 'pending'),
  'owner asks on purpose (risk tiers skipped) → 25% of $200 requested (' + (r.error || r.amount_cents) + ')');
delete process.env.STRIPE_SECRET_KEY;

// ── 3. Blocks: whole salon, weekly repeat, edit, delete this + later weeks ──
const d0 = keyOf(3 * DAY);
const addKey = (k, n) => { const [y, m, d] = k.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
r = await salon({ resource: 'block', staff_id: null, date: d0, start_time: '09:00', end_time: '10:00', reason: 'Team meeting' });
ok(r.ok && r.count === 1 && r.blocked_slot.staff_id === null && r.blocked_slot.tenant_id === TID, 'an “Everyone (whole salon)” block saves with no stylist');
r = await salon({ resource: 'block', staff_id: 'ana', date: d0, start_time: '12:00', end_time: '13:00', reason: 'Lunch', repeat_weeks: 4 });
const lunches = T.blocked_slots.filter((b) => b.reason === 'Lunch').map((b) => b.blocked_date).sort();
ok(r.ok && r.count === 4 && lunches.join() === [0, 7, 14, 21].map((n) => addKey(d0, n)).join(), 'repeat weekly × 4 → four lunches, one week apart: ' + lunches.join(' '));
r = await salon({ resource: 'block', staff_id: 'ana', date: d0, start_time: '12:00', end_time: '13:00', repeat_weeks: 500, reason: 'Cap' });
ok(r.ok && r.count === 52, 'repeat is capped at 52 weeks');
T.blocked_slots = T.blocked_slots.filter((b) => b.reason !== 'Cap');
r = await salon({ resource: 'block', staff_id: 'zed', date: d0, start_time: '12:00', end_time: '13:00', reason: 'x' });
ok(!r.ok && r.status === 404, 'another salon’s stylist is refused');
r = await salon({ resource: 'block', staff_id: 'ana', date: d0, start_time: '14:00', end_time: '13:00' });
ok(!r.ok && r.status === 400, 'end before start is refused');
r = await salon({ resource: 'block', staff_id: 'ana', date: 'tomorrow', start_time: '14:00', end_time: '15:00' });
ok(!r.ok && r.status === 400, 'a bad date is refused');
const meet = T.blocked_slots.find((b) => b.reason === 'Team meeting');
r = await salon({ resource: 'block', action: 'update', id: meet.id, start_time: '09:30', end_time: '10:30', reason: 'Huddle' });
ok(r.ok && meet.start_time === '09:30' && meet.reason === 'Huddle' && meet.staff_id === null, 'edit a block: new times + reason, still whole-salon');
r = await salon({ resource: 'block', action: 'update', id: meet.id, start_time: '11:00' });
ok(!r.ok && r.status === 400 && meet.start_time === '09:30', 'edit that would end before it starts is refused');
const other = { id: 'ob', tenant_id: OTHER, staff_id: null, blocked_date: d0, start_time: '08:00', end_time: '09:00', reason: 'Theirs' };
T.blocked_slots.push(other);
r = await salon({ resource: 'block', action: 'update', id: 'ob', reason: 'Hacked' });
ok(!r.ok && r.status === 404 && other.reason === 'Theirs', 'another salon’s block cannot be edited');
r = await salon({ resource: 'block', action: 'delete', id: 'ob' });
ok(!r.ok && r.status === 404 && T.blocked_slots.includes(other), 'another salon’s block cannot be deleted');
const second = T.blocked_slots.find((b) => b.reason === 'Lunch' && b.blocked_date === addKey(d0, 7));
T.blocked_slots.push({ id: 'bo-lunch', tenant_id: TID, staff_id: 'bo', blocked_date: addKey(d0, 14), start_time: '12:00', end_time: '13:00', reason: 'Lunch' });
r = await salon({ resource: 'block', action: 'delete', id: second.id, scope: 'following' });
const left = T.blocked_slots.filter((b) => b.reason === 'Lunch' && b.staff_id === 'ana').map((b) => b.blocked_date);
ok(r.ok && r.deleted === 3 && left.length === 1 && left[0] === d0, 'remove + later weeks: weeks 2–4 gone, week 1 stays');
ok(T.blocked_slots.some((b) => b.id === 'bo-lunch'), 'Bo’s lunch (different stylist) is untouched');
r = await salon({ resource: 'block', action: 'delete', id: meet.id });
ok(r.ok && r.deleted === 1 && !T.blocked_slots.includes(meet), 'single delete still works');

// ── 4. Existing context still carries deposits_enabled for the card button ──
r = await ownerGet({ action: 'context', date: d0, days: 7 });
ok(r.ok && r.deposits_enabled === true, 'context reports deposits_enabled');

console.log(fails ? `\n${fails} FAILED` : '\nall ownercal2 tests passed');
process.exit(fails ? 1 : 0);
