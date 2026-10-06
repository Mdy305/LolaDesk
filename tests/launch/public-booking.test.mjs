// Public online booking + external sync: what a client sees is what happens.
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'k';
process.env.STRIPE_SECRET_KEY = 'sk_test_x';
process.env.INTEGRATION_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString('base64');
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const texts = [], zaps = []; let squareDown = false, squareBookings = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  if (u.includes('api.stripe.com')) return J({ id: 'plink_' + Math.random().toString(36).slice(2, 8), url: 'https://buy.stripe.com/test_link' });
  if (u.startsWith('https://hooks.zapier.com/')) { zaps.push(JSON.parse(init.body)); return J({ status: 'success' }); }
  if (u.includes('squareup')) {
    if (squareDown) throw new Error('ECONNRESET square');
    if (u.includes('/v2/locations')) return J({ locations: [{ id: 'L1' }] });
    return J({ bookings: squareBookings });
  }
  if (u.includes('/v2/messages')) { texts.push(JSON.parse(init.body || '{}')); return J({ data: { id: 'm' } }); }
  return J({ data: [] });
};
const { T } = await import('./fake-supabase.mjs');
const P = new URL('../../api/', import.meta.url).href;
const { db } = await import(P + 'lib/db.js');
const { resetRateLimits } = await import(P + 'lib/public-rate-limit.js');
const pub = (await import(P + 'public-booking.js')).default;
const cal = (await import(P + 'calendar.js')).default;
const TID = '44444444-4444-4444-8444-444444444444', TZ = 'America/New_York', DAY = 864e5;
const day = new Date(Date.now() + 3 * DAY).toLocaleDateString('en-CA', { timeZone: TZ });
const atOn = (d, hhmm) => { const x = new Date(`${d}T${hhmm}:00Z`); const off = (new Date(x.toLocaleString('en-US', { timeZone: 'UTC' })) - new Date(x.toLocaleString('en-US', { timeZone: TZ }))); return new Date(x.getTime() + off).toISOString(); };
const at = (h) => atOn(day, h);
const call = (handler, { method = 'POST', query = {}, body = {}, headers = {} }) => new Promise((resolve) => {
  const res = { statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(o) { resolve({ status: this.statusCode, ...o }); return this; }, end() { resolve({ status: this.statusCode }); return this; }, send(o) { resolve({ status: this.statusCode, body: o }); } };
  handler({ method, query, body, headers }, res);
});
const W = (action, extra = {}) => call(pub, { body: { action, tenant: 'mma', ...extra } });
const reset = (settings = {}) => {
  resetRateLimits();
  T.tenants = [{ id: TID, name: 'MMA Salon', slug: 'mma', subscription_status: 'active', phone_number: '+13055550100', operator_phone: '+17865550199' }];
  T.tenant_users = [{ user_id: 'u1', tenant_id: TID, role: 'owner', status: 'active' }];
  T.booking_settings = [{ tenant_id: TID, timezone: TZ, slot_interval_minutes: 30, minimum_notice_minutes: 0, booking_horizon_days: 90, default_buffer_before_min: 0, default_buffer_after_min: 0, allow_processing_overlap: true, metadata: {}, ...settings }];
  T.services = [
    { id: 'cut', tenant_id: TID, name: 'Cut', category: 'Hair', description: 'Wash, cut and style', duration_minutes: 45, price: 80, is_active: true },
    { id: 'gloss', tenant_id: TID, name: 'Gloss', category: 'Add-ons', duration_minutes: 30, price: 45, is_active: true },
    { id: 'bal', tenant_id: TID, name: 'Balayage', category: 'Color', duration_minutes: 180, price: 300, is_active: true },
  ];
  T.staff = [{ id: 'ana', tenant_id: TID, name: 'Ana Ruiz', is_active: true }, { id: 'bo', tenant_id: TID, name: 'Bo Lee', is_active: true }];
  T.staff_services = []; T.staff_schedules = [];
  for (const s of ['ana', 'bo']) for (let d = 0; d < 7; d++) T.staff_schedules.push({ tenant_id: TID, staff_id: s, day_of_week: d, start_time: '09:00', end_time: '17:00' });
  T.staff_time_off = []; T.blocked_slots = []; T.bookings = []; T.availability_holds = []; T.clients = []; T.locations = []; T.business_hours = [];
  T.cached_availability = []; T.provider_mappings = []; T.booking_outbox = []; T.integrations = []; T.client_memories = []; T.usage_events = [];
  T.deposits = []; T.tenant_channels = []; T.opt_outs = []; T.booking_services = []; T.booking_status_history = []; T.platform_settings = [];
  globalThis.__missing = null;
};
globalThis.__authUsers = { tok: { id: 'u1', email: 'o@mma.com' } };
const B = (id, staff, svc, s, e, extra = {}) => ({ id, tenant_id: TID, staff_id: staff, service_id: svc, start_time: s, end_time: e, status: 'confirmed', ...extra });

// ── 1. Reschedule keeps the current stylist ──
reset();
let r = await W('book', { service_id: 'cut', staff_id: 'bo', starts_at: at('10:00'), client_name: 'Sarah Kim', client_phone: '3055554444' });
const code = r.booking?.confirmation_code;
ok(r.ok && r.booking.staff_id === 'bo', 'booked with Bo');
T.bookings.push(B('anaBusy', 'ana', 'cut', at('13:00'), at('14:00')));
T.bookings.push(B('boBusy', 'bo', 'cut', at('15:00'), at('16:00')));
r = await W('availability', { service_id: 'cut', date: day, staff_id: 'bo' });
ok(r.ok && !r.slots.some((s) => s.starts_at === at('15:00')) && r.slots.every((s) => s.staff_id === 'bo'), 'keep-my-stylist availability shows only Bo’s free times (not 3pm, when only Ana is free)');
r = await W('reschedule', { code, client_phone: '(305) 555-4444', starts_at: at('13:00') });
ok(r.ok && T.bookings.find((b) => b.confirmation_code === code).staff_id === 'bo', 'reschedule without a stylist keeps Bo (1pm: Ana busy, Bo free)');

// ── 2. Deposit shown == deposit charged (percent, fixed, premium) ──
for (const [label, dep, svc, want] of [
  ['percent 20%', { enabled: true, percent: 20 }, 'cut', 1600],
  ['fixed $25', { enabled: true, type: 'fixed', fixed_cents: 2500 }, 'cut', 2500],
  ['premium 50% for $250+', { enabled: true, percent: 20, premium_value: 50, premium_threshold: 250 }, 'bal', 15000],
  ['percent with $20 minimum', { enabled: true, percent: 10, min_cents: 2000 }, 'cut', 2000],
]) {
  reset({ metadata: { deposits: dep } });
  const cat = await call(pub, { method: 'GET', query: { action: 'catalog', tenant: 'mma' } });
  const shown = cat.services.find((s) => s.id === svc).deposit_cents;
  const q = await W('deposit_quote', { service_ids: [svc] });
  r = await W('book', { service_id: svc, staff_id: 'ana', starts_at: at('09:00'), client_name: 'Dee Posit', client_phone: '+13055557777' });
  const row = T.deposits.find((d) => d.booking_id === r.booking_id);
  ok(shown === want && q.required && q.amount_cents === want && row && Math.round(row.amount * 100) === want && r.deposit?.amount_cents === want,
    `${label}: menu ${shown}¢ = quote ${q.amount_cents}¢ = charged ${row && Math.round(row.amount * 100)}¢`);
  ok(r.payment_link === 'https://buy.stripe.com/test_link' && T.deposits.filter((d) => d.booking_id === r.booking_id).length === 1, `${label}: pay link returned to the page, requested exactly once`);
}
// add-on raises the total → deposit on the total, same number both sides
// (a public hold needs the visitor's mobile — nobody can hold a day anonymously)
reset({ metadata: { deposits: { enabled: true, percent: 20 } } });
r = await W('hold', { service_id: 'cut', staff_id: 'ana', starts_at: at('09:00'), client_phone: '3055550001' });
const q2 = await W('deposit_quote', { service_ids: ['cut', 'gloss'] });
r = await W('book', { service_ids: ['cut', 'gloss'], hold_token: r.hold.hold_token, starts_at: at('09:00'), client_name: 'Two Things', client_phone: '3055550001' });
ok(r.ok && q2.amount_cents === 2500 && Math.round(T.deposits.find((d) => d.booking_id === r.booking_id).amount * 100) === 2500, 'cut + gloss: deposit on $125 total shown and charged ($25)');
// "who: risky" → a trusted regular owes nothing, the page never claims one
reset({ metadata: { deposits: { enabled: true, percent: 20, who: 'risky' } } });
T.clients = [{ id: 'reg', tenant_id: TID, first_name: 'Regular', phone: '+13055552000' }];
T.bookings.push(B('past', 'ana', 'cut', new Date(Date.now() - 20 * DAY).toISOString(), new Date(Date.now() - 20 * DAY + 3600e3).toISOString(), { client_id: 'reg', status: 'completed' }));
let cat = await call(pub, { method: 'GET', query: { action: 'catalog', tenant: 'mma' } });
const qa = await W('deposit_quote', { service_ids: ['cut'] });
const qb = await W('deposit_quote', { service_ids: ['cut'], client_phone: '(305) 555-2000' });
ok(cat.salon.deposit_required === false && cat.deposit_policy.who === 'risky' && qa.maybe && !qa.required && qb.required === false && qb.amount_cents === 0, 'policy for some clients → "may be required"; the regular’s number → none');
r = await W('book', { service_id: 'cut', staff_id: 'bo', starts_at: at('11:00'), client_name: 'Regular', client_phone: '3055552000' });
ok(r.ok && !r.payment_link && !r.deposit && !T.deposits.length, 'the regular books with no deposit and no payment link');

// ── 3. A visitor never overwrites an existing client ──
reset();
T.clients = [{ id: 'sk', tenant_id: TID, first_name: 'Sarah', last_name: 'Kim', phone: '+13055554444', email: 'sarah@kim.com', preferences: {} },
             { id: 'ne', tenant_id: TID, first_name: 'Nina', last_name: null, phone: '+13055556666', email: null, preferences: {} }];
r = await W('book', { service_id: 'cut', staff_id: 'ana', starts_at: at('10:00'), client_name: 'Mallory Evil', client_email: 'evil@x.com', client_phone: '305-555-4444', sms_consent: 'transactional', consent_text_version: '2026-10-01' });
const sk = T.clients.find((c) => c.id === 'sk');
ok(r.ok && sk.first_name === 'Sarah' && sk.last_name === 'Kim' && sk.email === 'sarah@kim.com' && T.clients.length === 2, 'same phone, different name/email → Sarah’s record unchanged');
ok(sk.preferences?.sms_consent?.scope === 'transactional' && sk.preferences.sms_consent.text_version === '2026-10-01', 'SMS consent + copy version saved on the client');
r = await W('book', { service_id: 'cut', staff_id: 'bo', starts_at: at('10:00'), client_name: 'Nina Park', client_email: 'nina@park.com', client_phone: '3055556666' });
const ne = T.clients.find((c) => c.id === 'ne');
ok(r.ok && ne.email === 'nina@park.com' && ne.first_name === 'Nina', 'empty email gets filled, existing name kept');
r = await W('client_lookup', { client_phone: '305 555 4444' });
ok(r.ok && r.client?.first_name === 'Sarah' && Object.keys(r.client).length === 1, 'returning visitor lookup → first name only');

// ── 4. Booking settings on public paths ──
reset({ public_booking_enabled: false });
cat = await call(pub, { method: 'GET', query: { action: 'catalog', tenant: 'MMA' } });
ok(cat.ok && cat.booking.enabled === false && cat.services.length === 0 && /isn't taking online bookings.*\+13055550100/.test(cat.booking.message), 'online booking off → catalog says so with the salon phone (slug matched case-insensitively)');
r = await W('book', { service_id: 'cut', staff_id: 'ana', starts_at: at('10:00'), client_name: 'X', client_phone: '3055551111' });
ok(!r.ok && r.error === 'booking_disabled' && !T.bookings.length, 'online booking off → book refused, nothing written');
reset({ require_email: true, allow_any_staff: false });
r = await W('book', { service_id: 'cut', staff_id: 'ana', starts_at: at('10:00'), client_name: 'X', client_phone: '3055551111' });
ok(!r.ok && r.error === 'email_required', 'require_email honored');
r = await W('book', { service_id: 'cut', starts_at: at('10:00'), client_name: 'X', client_phone: '3055551111', client_email: 'x@y.co' });
ok(!r.ok && r.needs === 'staff', 'allow_any_staff off → “anyone” refused');
reset({ allow_staff_choice: false });
cat = await call(pub, { method: 'GET', query: { action: 'catalog', tenant: 'mma' } });
r = await W('book', { service_id: 'cut', staff_id: 'bo', starts_at: at('10:00'), client_name: 'X', client_phone: '+44 20 7946 0958' });
ok(cat.staff.length === 0 && r.ok, 'allow_staff_choice off → no stylist list; an international phone (+44) books fine');
r = await W('book', { service_id: 'cut', starts_at: at('11:00'), client_name: 'X', client_phone: '12' });
ok(!r.ok && r.error === 'phone_invalid', 'a too-short phone is refused');

// ── 5. Cancellation window ──
reset({ cancellation_window_hours: 24 });
T.clients = [{ id: 'c1', tenant_id: TID, first_name: 'Lia', phone: '+13055553333' }];
T.bookings.push(B('soon', 'ana', 'cut', new Date(Date.now() + 10 * 3600e3).toISOString(), new Date(Date.now() + 11 * 3600e3).toISOString(), { client_id: 'c1', confirmation_code: 'SOON22' }));
T.bookings.push(B('later', 'ana', 'cut', at('12:00'), at('13:00'), { client_id: 'c1', confirmation_code: 'LATE33' }));
r = await W('cancel', { code: 'SOON22', client_phone: '3055553333' });
ok(!r.ok && r.error === 'within_policy_window' && r.code === 'within_policy_window' && r.salon_phone === '+13055550100' && T.bookings.find((b) => b.id === 'soon').status === 'confirmed', '10h away with a 24h window → cancel refused, call the salon');
r = await W('reschedule', { code: 'SOON22', client_phone: '3055553333', starts_at: at('15:00') });
ok(!r.ok && r.error === 'within_policy_window', 'and reschedule refused too');
r = await W('lookup', { code: 'SOON22', client_phone: '3055553333' });
ok(r.ok && r.policy.can_change_online === false && r.policy.cancellation_window_hours === 24, 'lookup tells the page it can’t be changed online');
r = await W('cancel', { code: 'LATE33', client_phone: '3055553333' });
ok(r.ok && T.bookings.find((b) => b.id === 'later').status === 'cancelled', '3 days away → cancel works');

// ── 6. "Anyone" goes to the stylist whose day it packs ──
reset();
T.bookings.push(B('boEarly', 'bo', 'cut', at('09:00'), at('11:00')));
r = await W('book', { service_id: 'cut', starts_at: at('11:00'), client_name: 'Any One', client_phone: '3055558888' });
ok(r.ok && r.booking.staff_id === 'bo', `anyone at 11:00 → Bo (right after his client), not Ana's empty morning (got ${r.booking?.staff_id})`);
r = await W('hold', { service_id: 'cut', starts_at: at('14:00'), client_phone: '3055559999' });
ok(r.ok && r.hold.hold_token && r.hold.staff_name && Date.parse(r.hold.expires_at) - Date.now() > 4 * 60e3 && !('client_id' in r.hold), 'picking a time holds it ~5 minutes (public hold has no internal fields)');
const r2 = await W('availability', { service_id: 'cut', date: day, one_per_time: 1 });
ok(!r2.slots.some((s) => s.starts_at === at('14:00') && s.staff_id === r.hold.staff_id), 'the held time is off the held stylist’s list');
await W('release_hold', { hold_token: r.hold.hold_token });
ok(T.availability_holds.find((h) => h.hold_token === r.hold.hold_token).status === 'released', 'release_hold frees it');

// ── 7. Evening times survive the limit ──
reset();
for (let i = 0; i < 12; i++) { T.staff.push({ id: 's' + i, tenant_id: TID, name: 'Stylist ' + i, is_active: true }); for (let d = 0; d < 7; d++) T.staff_schedules.push({ tenant_id: TID, staff_id: 's' + i, day_of_week: d, start_time: '09:00', end_time: '20:00' }); }
r = await W('availability', { service_id: 'cut', date: day, limit: 200, one_per_time: 1 });
const times = r.slots.map((s) => s.starts_at);
ok(r.ok && times.includes(at('19:00')) && new Set(times).size === times.length, `14 stylists (282 stylist-rows > the 200 limit) × a long day: 7pm still offered, each time once (${times.length} times)`);
r = await W('availability', { service_id: 'cut', date: day, limit: 200 });
ok(r.slots.some((s) => s.starts_at === at('19:00')), 'older embeds (every stylist per time) also keep the evening');
T.blocked_slots = [{ tenant_id: TID, blocked_date: day, staff_id: null, start_time: null, end_time: null }];
r = await W('availability', { service_id: 'cut', date: day });
ok(r.ok && !r.slots.length && r.next_open?.date > day && r.next_open.times.length > 0, 'a full day suggests the next open day: ' + r.next_open?.date);
r = await W('open_days', { service_id: 'cut', days: 5 });
ok(r.ok && r.days.length === 5 && r.days.some((d) => d.date === day && !d.open) && r.days.some((d) => d.open), '14-day strip knows which days are open');

// ── 8. Add-ons: real menu, same stylist, back to back ──
reset();
r = await W('hold', { service_id: 'cut', staff_id: 'ana', starts_at: at('10:00'), client_phone: '3055551212' });
const ad = await W('addons', { hold_token: r.hold.hold_token });
ok(ad.ok && ad.addons.length === 1 && ad.addons[0].id === 'gloss' && ad.addons[0].price === 45, 'after a 45-min cut (ends 10:45, off the 30-min grid) Ana can add the Gloss');
let bk = await W('book', { service_ids: ['cut', 'gloss'], hold_token: r.hold.hold_token, starts_at: at('10:00'), client_name: 'Mia', client_phone: '3055551212' });
ok(bk.ok && Date.parse(bk.booking.end_time) === Date.parse(at('11:15')) && Number(bk.booking.total_amount) === 125 && T.booking_services.filter((x) => x.booking_id === bk.booking_id).length === 2, 'one booking 10:00–11:15, $125, two booking_services rows');
globalThis.__missing = new Set(['booking_services']);
r = await W('hold', { service_id: 'cut', staff_id: 'bo', starts_at: at('10:00'), client_phone: '3055551313' });
bk = await W('book', { service_ids: ['cut', 'gloss'], hold_token: r.hold.hold_token, starts_at: at('10:00'), client_name: 'Jo', client_phone: '3055551313' });
const jo = T.bookings.filter((b) => b.staff_id === 'bo').sort((a, b) => Date.parse(a.start_time) - Date.parse(b.start_time));
ok(bk.ok && jo.length === 2 && jo[1].service_id === 'gloss' && Date.parse(jo[1].start_time) === Date.parse(at('10:45')), 'no booking_services table → the add-on is its own booking right after, same stylist');
globalThis.__missing = null;
ok(typeof bk.texted === 'boolean' && /\/api\/calendar\.ics\?code=/.test(bk.calendar_path), 'book says whether it texted, and gives the add-to-calendar link');

// ── 9. Dashboard paths reach the salon's own system ──
reset();
T.tenant_channels = [];
const { setZapUrl } = await import(P + 'lib/zapier-bridge.js');
await setZapUrl(db(), TID, 'https://hooks.zapier.com/hooks/catch/1/x/');
T.provider_mappings.push({ id: 'pm1', tenant_id: TID, provider: 'boulevard', entity_type: 'staff', local_id: 'ana', external_id: 'blvd_staff_ana' });
r = await call(cal, { headers: { authorization: 'Bearer tok' }, body: { action: 'book', service_id: 'cut', staff_id: 'ana', starts_at: at('12:00'), client_name: 'Desk Client', client_phone: '3055550123' } });
ok(r.ok && T.booking_outbox.some((o) => o.booking_id === r.booking_id && o.op === 'create'), 'dashboard book → outbox row (write-through to the salon’s platform)');
const { processOutbox } = await import(P + 'lib/booking-outbox.js');
await new Promise((res) => setTimeout(res, 200)); await processOutbox(db(), { now: Date.now() + 1000 });
const created = zaps.find((z) => z.event === 'booking.created' && z.booking_id === r.booking_id);
ok(created && created.staff_id === 'ana' && created.external_staff_id === 'blvd_staff_ana' && /\/api\/zap-callback\?t=/.test(created.callback_url), 'Zap payload carries local + Boulevard staff ids and the callback link');
const cb = new URL(created.callback_url);
const zcb = (await import(P + 'zap-callback.js')).default;
let z = await call(zcb, { query: { t: TID, k: 'x'.repeat(32) }, body: { booking_id: r.booking_id, timeblock_id: 'tb_1' } });
ok(z.status === 401, 'callback with a forged key refused');
z = await call(zcb, { query: { t: TID, k: cb.searchParams.get('k') }, body: { booking_id: r.booking_id, timeblock_id: 'tb_1' } });
ok(z.ok && T.provider_mappings.some((m) => m.provider === 'zapier' && m.entity_type === 'booking' && m.local_id === r.booking_id && m.external_id === 'tb_1'), 'Zap posts back its time block id → stored');
zaps.length = 0;
const resch = await call(cal, { headers: { authorization: 'Bearer tok' }, body: { action: 'reschedule', booking_id: r.booking_id, starts_at: at('14:00') } });
await new Promise((res) => setTimeout(res, 100));
ok(resch.ok && zaps.some((x) => x.event === 'booking.rescheduled' && x.external_id === 'tb_1'), 'dashboard reschedule → Zap hears booking.rescheduled with the time block id');
const canc = await call(cal, { headers: { authorization: 'Bearer tok' }, body: { action: 'cancel', booking_id: r.booking_id } });
await new Promise((res) => setTimeout(res, 100));
ok(canc.ok && zaps.some((x) => x.event === 'booking.cancelled' && x.external_id === 'tb_1'), 'dashboard cancel → booking.cancelled with the time block id');

// ── 10. Inbound: only unique stylist matches ──
reset();
T.staff.push({ id: 'ana2', tenant_id: TID, name: 'Ana Lopez', is_active: true });
const { inboundEvent } = await import(P + 'lib/zapier-bridge.js');
let ib = await inboundEvent(db(), T.tenants[0], { event: 'new', id: 'x1', start: at('10:00'), duration: 60, staff: 'Ana' }, { tz: TZ });
ok(ib.ok && ib.staff_matched === false && T.cached_availability.find((x) => x.external_booking_id === 'x1').staff_id === null, 'two Anas, “Ana” → unmapped (takes a chair), never the wrong Ana');
ib = await inboundEvent(db(), T.tenants[0], { event: 'new', id: 'x2', start: at('10:00'), duration: 60, staff: 'Ana Lopez' }, { tz: TZ });
ok(T.cached_availability.find((x) => x.external_booking_id === 'x2').staff_id === 'local:ana2', 'full name → the right Ana');
ib = await inboundEvent(db(), T.tenants[0], { event: 'new', id: 'x3', start: at('10:00'), duration: 60, staff: 'Bo' }, { tz: TZ });
ok(T.cached_availability.find((x) => x.external_booking_id === 'x3').staff_id === 'local:bo', 'a unique first name still matches');
T.provider_mappings.push({ id: 'pm2', tenant_id: TID, provider: 'boulevard', entity_type: 'staff', local_id: 'ana', external_id: 'blvd_ana' });
ib = await inboundEvent(db(), T.tenants[0], { event: 'new', id: 'x4', start: at('10:00'), duration: 60, staff: 'Ana', staff_id: 'blvd_ana' }, { tz: TZ });
ok(T.cached_availability.find((x) => x.external_booking_id === 'x4').staff_id === 'local:ana', 'a mapped Boulevard staff id wins over the name');

// ── 11. A failed provider fetch never wipes its busy time ──
reset();
const { syncTenantAvailability } = await import(P + 'lib/booking-sync.js');
T.integrations = [{ id: 'i1', tenant_id: TID, provider: 'square', status: 'connected', access_token: null, refresh_token: null }];
squareBookings = [{ id: 'sq1', start_at: at('10:00'), appointment_segments: [{ duration_minutes: 60 }] }, { id: 'sq2', start_at: at('12:00'), appointment_segments: [{ duration_minutes: 60 }] }];
let sy = await syncTenantAvailability(db(), TID);
ok(sy.ok && T.cached_availability.length === 2, 'square synced: two busy blocks cached');
squareDown = true;
sy = await syncTenantAvailability(db(), TID);
ok(sy.provider_errors.length === 1 && sy.stale_removed === 0 && T.cached_availability.length === 2, 'square down → busy time kept (no double bookings)');
squareDown = false; squareBookings = squareBookings.slice(0, 1);
sy = await syncTenantAvailability(db(), TID);
ok(sy.stale_removed === 1 && T.cached_availability.length === 1 && T.cached_availability[0].external_booking_id === 'sq1', 'square back up → the appointment it no longer lists is pruned');

// ── 12. The sync cron reaches every tenant ──
reset();
T.tenants = Array.from({ length: 120 }, (_, i) => ({ id: 'ten' + String(i).padStart(3, '0'), name: 'S' + i }));
process.env.CRON_SECRET = 'cs';
const cron = (await import(P + 'cron/sync-availability.js')).default;
const starts = [];
for (let i = 0; i < 3; i++) {
  const c = await call(cron, { method: 'GET', headers: { authorization: 'Bearer cs' } });
  starts.push(c.started_at_index);
  ok(c.ok && c.synced === 50, `cron run ${i + 1}: 50 tenants, starting at #${c.started_at_index}`);
}
ok(starts[1] === (starts[0] + 50) % 120 && starts[2] === (starts[1] + 50) % 120, `each run starts where the last stopped (${starts.join(' → ')}) — tenant #51+ no longer starved`);
const { readCursor } = await import(P + 'cron/sync-availability.js');
ok((await readCursor(db(), 120)).start === (starts[2] + 50) % 120, 'the cursor is saved for the next run: 3 runs covered all 120 tenants');

// ── 13. Beacon reads URL params ──
reset();
T.telemetry_events = [];
const beacon = (await import(P + 'widget-beacon.js')).default;
await call(beacon, { method: 'POST', query: { tenant: 'mma', kind: 'widget_load', host: 'mmasalon.com' }, body: '' });
ok(T.telemetry_events[0]?.tenant_slug === 'mma' && T.telemetry_events[0].kind === 'widget_load' && T.telemetry_events[0].source === 'mmasalon.com', 'widget beacon (sendBeacon with URL params) is recorded');

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
