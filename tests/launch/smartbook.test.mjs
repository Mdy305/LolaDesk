// The booking brain: packed days (no unsellable holes), the asked time first, the usual stylist,
// processing time filled, full days roll forward, a real add-on that fits, deposits only where they protect.
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'k';
process.env.STRIPE_SECRET_KEY = 'sk_test';
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
globalThis.fetch = async () => new Response(JSON.stringify({ data: { id: 'x' } }), { status: 200, headers: { 'content-type': 'application/json' } });
const { T } = await import('./fake-supabase.mjs');
const P = new URL('../../api/', import.meta.url).href;
const TID = '33333333-3333-4333-8333-333333333333', TZ = 'America/New_York', DAY = 864e5;
const day = new Date(Date.now() + 3 * DAY).toLocaleDateString('en-CA', { timeZone: TZ });
const nextDay = new Date(Date.now() + 4 * DAY).toLocaleDateString('en-CA', { timeZone: TZ });
const atOn = (d, hhmm) => { const x = new Date(`${d}T${hhmm}:00Z`); const off = (new Date(x.toLocaleString('en-US', { timeZone: 'UTC' })) - new Date(x.toLocaleString('en-US', { timeZone: TZ }))); return new Date(x.getTime() + off).toISOString(); };
const at = (h) => atOn(day, h);
const reset = () => {
  T.tenants = [{ id: TID, name: 'MMA Salon', slug: 'mma', subscription_status: 'active', phone_number: '+13055550100', services: [{ name: 'Cut', price: 80, duration: 60 }] }];
  T.booking_settings = [{ tenant_id: TID, timezone: TZ, slot_interval_minutes: 15, minimum_notice_minutes: 0, booking_horizon_days: 90, default_buffer_before_min: 0, default_buffer_after_min: 0, allow_processing_overlap: true, metadata: {} }];
  T.services = [
    { id: 'cut', tenant_id: TID, name: 'Cut', duration_minutes: 60, price: 80, is_active: true },
    { id: 'color', tenant_id: TID, name: 'Color', duration_minutes: 90, active_duration_1_min: 45, processing_duration_min: 30, active_duration_2_min: 15, price: 160, is_active: true },
    { id: 'gloss', tenant_id: TID, name: 'Gloss', duration_minutes: 30, price: 45, is_active: true },
    { id: 'blowout', tenant_id: TID, name: 'Blowout', duration_minutes: 45, price: 40, is_active: true },
  ];
  T.staff = [{ id: 'ana', tenant_id: TID, name: 'Ana', is_active: true }, { id: 'bo', tenant_id: TID, name: 'Bo', is_active: true }];
  T.staff_services = []; T.staff_schedules = [];
  for (const s of ['ana', 'bo']) for (let d = 0; d < 7; d++) T.staff_schedules.push({ tenant_id: TID, staff_id: s, day_of_week: d, start_time: '09:00', end_time: '17:00' });
  T.staff_time_off = []; T.blocked_slots = []; T.bookings = []; T.availability_holds = []; T.clients = []; T.locations = []; T.business_hours = [];
  T.cached_availability = []; T.provider_mappings = []; T.booking_outbox = []; T.integrations = []; T.client_memories = []; T.usage_events = []; T.deposits = []; T.tenant_channels = []; T.opt_outs = [];
};
reset();
const S = await import(P + 'lib/smart-slots.js');
const { SKILLS } = await import(P + 'lola-tools.js');
const B = (id, staff, svc, s, e, extra = {}) => ({ id, tenant_id: TID, staff_id: staff, service_id: svc, start_time: s, end_time: e, status: 'confirmed', ...extra });

// ── 1. Packing: no unsellable holes ──
T.bookings.push(B('b1', 'ana', 'cut', at('10:00'), at('11:00')));
T.bookings.push(B('b2', 'bo', 'cut', at('09:00'), at('12:00')));
let r = await S.findSmartSlots({ tenantId: TID, serviceId: 'cut', date: day, tz: TZ });
const times = r.offers.map((o) => o.starts_at);
ok(r.ok && r.offers.length === 3 && new Set(times).size === 3, 'three different times offered (never "11, 11, 11:30")');
ok(!r.ranked.slice(0, 6).some((o) => o.staff_id === 'ana' && [at('09:15'), at('09:30'), at('11:15'), at('11:30')].includes(o.starts_at)), 'never a time that strands 15–30 unsellable minutes in Ana’s morning');
ok(r.ranked[0].reasons.some((x) => /right (after|before) another client|first of the shift/.test(x)), 'the top pick touches another appointment: ' + r.ranked[0].reasons.join(', '));
const day1 = (await S.rankDay({ tenantId: TID, serviceId: 'cut', date: day, staffId: 'ana' })).slots;
const eleven = day1.find((o) => o.starts_at === at('11:00')), elevenFifteen = day1.find((o) => o.starts_at === at('11:15'));
ok(eleven && elevenFifteen && eleven.score > elevenFifteen.score && elevenFifteen.reasons.some((x) => /15 unsellable minutes before/.test(x)), `11:00 (right after Ana’s 10:00) beats 11:15 (strands 15 minutes): ${eleven?.score} > ${elevenFifteen?.score}`);

// ── 2. The time they asked for ──
r = await S.findSmartSlots({ tenantId: TID, serviceId: 'cut', date: day, wantAt: at('14:00'), tz: TZ });
ok(r.exact && r.offers.length === 1 && r.offers[0].starts_at === at('14:00'), 'asked for 2pm and it’s free → exactly 2pm');
r = await SKILLS.check_availability(T.tenants[0], { service: 'Cut', date: day, time: '2pm' });
ok(r.exact && /^Yes — 2\sPM .* works/.test(r.speak), 'Lola: ' + r.speak);
T.bookings.push(B('b3', 'ana', 'cut', at('14:00'), at('15:00')), B('b4', 'bo', 'cut', at('14:00'), at('15:00')));
r = await SKILLS.check_availability(T.tenants[0], { service: 'Cut', date: day, time: '2pm' });
const near = r.slots.map((s) => Math.abs(Date.parse(s) - Date.parse(at('14:00'))) / 60000);
ok(!r.exact && /2pm is taken — the closest I have/.test(r.speak) && Math.max(...near) <= 120, 'taken → the closest times, not the morning: ' + r.speak);

// ── 3. A full day rolls to the next ──
T.blocked_slots = [{ tenant_id: TID, blocked_date: day, staff_id: null, start_time: null, end_time: null }];
r = await SKILLS.check_availability(T.tenants[0], { service: 'Cut', date: day });
ok(r.rolled_days === 1 && r.slots.every((s) => new Date(s).toLocaleDateString('en-CA', { timeZone: TZ }) === nextDay) && /fully booked — the next openings are/.test(r.speak), 'full day → next openings the following day: ' + r.speak);
T.blocked_slots = [];

// ── 4. The usual stylist ──
T.clients = [{ id: 'c1', tenant_id: TID, name: 'Sarah Kim', phone: '+13055554444' }];
T.bookings.push(B('old1', 'bo', 'cut', new Date(Date.now() - 30 * DAY).toISOString(), new Date(Date.now() - 30 * DAY + 3600e3).toISOString(), { client_id: 'c1', status: 'completed' }));
const best = await S.bestStaffAt({ tenantId: TID, serviceId: 'cut', startsAt: at('16:00'), clientId: 'c1' });
ok(best?.staff_id === 'bo' && best.reasons.includes('their usual stylist'), 'no stylist named → Sarah gets Bo, her usual');
r = await SKILLS.book_appointment(T.tenants[0], { service: 'Cut', date: day, time: '4pm', client_name: 'Sarah Kim', client_phone: '+13055554444' });
const sarah = T.bookings.find((b) => b.client_id === 'c1' && b.start_time === at('16:00'));
ok(r.booked && sarah?.staff_id === 'bo' && /with Bo/.test(r.speak), 'and the booking lands with Bo: ' + r.speak);

// ── 5. Processing time sold ──
T.bookings.push(B('col', 'ana', 'color', at('12:00'), at('13:30')));
r = await S.findSmartSlots({ tenantId: TID, serviceId: 'gloss', date: day, tz: TZ });
const proc = r.ranked.find((o) => o.staff_id === 'ana' && o.starts_at === at('12:45'));
ok(proc && proc.reasons.includes('fills processing time') && r.ranked.indexOf(proc) < 3, 'a 30-min gloss is placed inside Ana’s color processing (12:45) — extra revenue, same chair');

// ── 6. A real add-on that fits ──
reset();
T.clients = [{ id: 'c2', tenant_id: TID, name: 'Mia Lopez', phone: '+13055551212' }];
r = await SKILLS.book_appointment(T.tenants[0], { service: 'Cut', date: day, time: '3pm', stylist: 'Ana', client_name: 'Mia Lopez', client_phone: '+13055551212' });
ok(r.booked && r.upsell?.service === 'Gloss' && r.upsell.price === 45 && /Ana has time right after — want me to add a Gloss for \$45\? It's 30 minutes\./.test(r.speak), 'after a cut: a real Gloss from the menu, real price, Ana free right after: ' + r.speak);
ok(/date \d{4}-\d{2}-\d{2} and time 4:00\sPM/.test(r.upsell.how), 'she knows exactly how to book it if they say yes');
r = await SKILLS.book_appointment(T.tenants[0], { service: 'Gloss', date: day, time: '4:00 PM', stylist: 'Ana', client_name: 'Mia Lopez', client_phone: '+13055551212' });
ok(r.booked && !r.upsell && T.bookings.filter((b) => b.client_id === 'c2').length === 2, 'yes → the gloss is booked, and she doesn’t stack another offer');
T.bookings.push(B('blk', 'ana', 'cut', at('11:00'), at('12:00')));
r = await SKILLS.book_appointment(T.tenants[0], { service: 'Cut', date: day, time: '10am', stylist: 'Ana', client_name: 'Jo', client_phone: '+13055557777' });
ok(r.booked && !r.upsell && /Anything else\?/.test(r.speak), 'no room after → no upsell (never pushes what doesn’t fit)');

// ── 7. Deposits only where they protect ──
const D = await import(P + 'lib/deposits.js');
T.booking_settings[0].metadata = { deposits: { enabled: true, type: 'fixed', fixed_cents: 2500, who: 'risky' } };
T.clients.push({ id: 'reg', tenant_id: TID, name: 'Reg Ular', phone: '+13055550001' }, { id: 'flk', tenant_id: TID, name: 'Fla Ky', phone: '+13055550002' });
for (let i = 1; i <= 3; i++) T.bookings.push(B('r' + i, 'ana', 'cut', new Date(Date.now() - i * 20 * DAY).toISOString(), new Date(Date.now() - i * 20 * DAY + 3600e3).toISOString(), { client_id: 'reg', status: 'completed' }));
T.bookings.push(B('ns', 'ana', 'cut', new Date(Date.now() - 10 * DAY).toISOString(), new Date(Date.now() - 10 * DAY + 3600e3).toISOString(), { client_id: 'flk', status: 'no_show' }));
ok((await D.clientRisk(TID, 'reg')).level === 'trusted' && (await D.clientRisk(TID, 'flk')).level === 'flaky' && (await D.clientRisk(TID, 'c2')).level === 'new', 'risk from real history: regular = trusted, no-show = flaky, first visit = new');
r = await SKILLS.book_appointment(T.tenants[0], { service: 'Cut', date: day, time: '9am', stylist: 'Bo', client_name: 'Reg Ular', client_phone: '+13055550001' });
ok(r.booked && !r.deposit_required && !/deposit/.test(r.speak), '“new + risky” policy: the regular books with zero friction');
r = await SKILLS.book_appointment(T.tenants[0], { service: 'Cut', date: day, time: '1pm', stylist: 'Bo', client_name: 'Fla Ky', client_phone: '+13055550002' });
ok(r.booked && r.deposit_required && /\$25 deposit/.test(r.speak), 'the client who no-showed is asked for the real $25 deposit: ' + r.speak);
T.booking_settings[0].metadata.deposits.who = 'flaky';
const plan = await D.depositPlan({ tenantId: TID, booking: { total_amount: 80, client_id: 'brand-new' } });
ok(!plan.required && plan.reason === 'trusted_client', '“only no-shows” policy: a brand-new client isn’t charged');
T.booking_settings[0].metadata.deposits.who = 'everyone';
ok((await D.depositPlan({ tenantId: TID, booking: { total_amount: 80, client_id: 'reg' } })).required, '“everyone”: every booking (unchanged default)');

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
