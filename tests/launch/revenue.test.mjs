// LolaDesk revenue engine: per-appointment fees + Lola's 30-day fill plan.
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'k';
const texts = [];
globalThis.fetch = async (url, init) => { if (/telnyx/.test(String(url))) texts.push(JSON.parse(init.body)); return new Response(JSON.stringify({ data: { id: 'm' } }), { status: 200, headers: { 'content-type': 'application/json' } }); };
const { T } = await import('./fake-supabase.mjs');
const P = new URL('../../api/', import.meta.url).href;
const fees = await import(P + 'lib/booking-fees.js');
const repo = await import(P + 'lib/booking-repository.js');
const plan = await import(P + 'lib/fill-plan.js');
const { audience } = await import(P + 'lib/marketing.js');
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const DAY = 864e5, TZ = 'America/New_York';
const A = '11111111-1111-4111-8111-111111111111', TRIAL = '22222222-2222-4222-8222-222222222222';
const iso = (ms) => new Date(ms).toISOString();

function reset() {
  for (const k of Object.keys(T)) delete T[k];
  T.tenants = [
    { id: A, slug: 'mma', name: 'MMA Salon', phone_number: '+13055550100', subscription_status: 'active', stripe_customer_id: 'cus_1', knowledge: JSON.stringify({ tone: 'warm, Miami chic' }) },
    { id: TRIAL, slug: 'new', name: 'New Salon', phone_number: '+13055550199', subscription_status: 'trial' },
  ];
  T.booking_settings = [{ tenant_id: A, timezone: TZ }];
  T.services = [{ id: 'color', tenant_id: A, name: 'Balayage', category: 'Color', price: 240, duration_minutes: 180, is_active: true },
                { id: 'cut', tenant_id: A, name: 'Haircut', price: 80, duration_minutes: 60, is_active: true }];
  T.staff = [{ id: 'ana', tenant_id: A, name: 'Ana', is_active: true }, { id: 'bo', tenant_id: A, name: 'Bo', is_active: true }];
  T.staff_schedules = []; for (const s of ['ana', 'bo']) for (const d of [2, 3, 4, 5, 6]) T.staff_schedules.push({ tenant_id: A, staff_id: s, day_of_week: d, start_time: '10:00', end_time: '18:00' });
  T.staff_time_off = []; T.blocked_slots = []; T.bookings = []; T.clients = []; T.booking_fees = []; T.booking_history = [];
  T.lola_fill_plans = []; T.lola_campaigns = []; T.lola_campaign_recipients = []; T.availability_holds = [];
  texts.length = 0;
}

// ══ 1. LolaDesk earns on each appointment Lola books ══
reset();
const now = Date.now();
const bk = (id, o) => ({ id, tenant_id: A, client_id: 'c1', service_id: 'cut', staff_id: 'ana', start_time: iso(now + 2 * DAY), end_time: iso(now + 2 * DAY + 3600e3), status: 'confirmed', total_amount: 80, created_at: iso(now), ...o });
const tA = T.tenants[0], tTrial = T.tenants[1];
let r = await fees.recordFee(null, tA, bk('b0', { source: 'voice' }));
ok(r.skipped, 'no database → no-op');
r = await fees.recordFee(await import(P + 'lib/db.js').then(m => m.db()), tA, bk('b1', { source: 'voice' }));
const c = (await import(P + 'lib/db.js')).db();
ok(r.fee && r.fee.fee_cents === 100 && r.fee.status === 'pending', 'phone booking by Lola → $1.00 fee, pending until the visit');
r = await fees.recordFee(c, tA, bk('b1', { source: 'voice' }));
ok(T.booking_fees.length === 1, 'same booking never charged twice');
r = await fees.recordFee(c, tA, bk('b2', { source: 'dashboard' }));
ok(r.skipped === 'not_billable', 'a booking the owner adds is free');
r = await fees.recordFee(c, tA, bk('b3', { source: 'widget', external_id: 'sq_9' }));
ok(r.skipped === 'not_billable', 'a booking synced from another platform is free');
r = await fees.recordFee(c, tTrial, { ...bk('b4', { source: 'public' }), tenant_id: TRIAL });
ok(r.fee && r.fee.status === 'waived', 'during the free trial the fee is waived');
ok(fees.feeCents({ total_amount: 200 }, { ...fees.feePolicy({}), percent: 2, flatCents: 50 }) === 450, 'flat + % pricing: $0.50 + 2% of $200 = $4.50');
ok(fees.feeCents({ total_amount: 1000 }, { ...fees.feePolicy({}), percent: 5, flatCents: 0, maxCents: 1500 }) === 1500, 'per-appointment cap honored');

// through the real booking engine
const made = await repo.createCanonicalBooking({ tenantId: A, clientId: 'c1', serviceId: 'cut', staffId: 'bo', startTime: iso(now + 3 * DAY), endTime: iso(now + 3 * DAY + 3600e3), totalAmount: 80, source: 'public', sendConfirmation: false });
await wait(50);
ok(T.booking_fees.some(f => f.booking_id === made.id && f.status === 'pending'), 'widget booking through the engine records its fee');
await repo.updateCanonicalBooking(A, made.id, { status: 'cancelled' }, { sendCancellation: false });
await wait(50);
ok(T.booking_fees.find(f => f.booking_id === made.id).status === 'void', 'cancelled → the salon owes nothing');

// the daily run: sweep, settle, bill
T.bookings.push(bk('past1', { source: 'voice', start_time: iso(now - 2 * DAY), end_time: iso(now - 2 * DAY + 3600e3), created_at: iso(now - 3 * DAY) }));
T.bookings.push(bk('past2', { source: 'sms', start_time: iso(now - 2 * DAY), end_time: iso(now - 2 * DAY + 3600e3), created_at: iso(now - 3 * DAY), status: 'no-show' }));
T.bookings.push(bk('past3', { source: 'lola', start_time: iso(now - 2 * DAY), end_time: iso(now - 2 * DAY + 3600e3), created_at: iso(now - 3 * DAY) }));
T.bookings.push(bk('recent', { source: 'voice', start_time: iso(now - 3600e3), end_time: iso(now), created_at: iso(now - DAY) }));
await fees.recordFee(c, tA, T.bookings.find(b => b.id === 'past2'));   // recorded while it was still confirmed
T.booking_fees.find(f => f.booking_id === 'past2').status = 'pending';
const billed = [];
const stubBill = async (t, list) => { billed.push({ t: t.id, n: list.length, cents: list.reduce((s, f) => s + f.fee_cents, 0) }); return { id: 'ii_' + billed.length }; };
let run = await fees.runBookingFees(c, { policy: { ...fees.feePolicy({}), live: false }, bill: stubBill });
ok(run.recorded >= 3, `sweep catches bookings made by any path (${run.recorded})`);
ok(T.booking_fees.find(f => f.booking_id === 'past1').status === 'earned', 'appointment happened → earned');
ok(T.booking_fees.find(f => f.booking_id === 'past2').status === 'void', 'no-show → never charged');
ok(T.booking_fees.find(f => f.booking_id === 'recent').status === 'pending', 'owner gets a day to mark a no-show before it counts');
ok(!billed.length, 'BOOKING_FEES_LIVE off → nobody is charged');
run = await fees.runBookingFees(c, { policy: { ...fees.feePolicy({}), live: true }, bill: stubBill });
ok(billed.length === 1 && billed[0].t === A && billed[0].n === 2 && billed[0].cents === 200, `live → one invoice line per salon ($${billed[0] && billed[0].cents / 100} for ${billed[0] && billed[0].n})`);
ok(T.booking_fees.filter(f => f.status === 'billed').length === 2, 'marked billed');
run = await fees.runBookingFees(c, { policy: { ...fees.feePolicy({}), live: true }, bill: stubBill });
ok(billed.length === 1, 'next run bills nothing twice');
const sum = await fees.feeSummary(c, { tenantId: A, month: iso(now + 2 * DAY).slice(0, 7) });
ok(sum.ready && sum.lola_bookings >= 1 && sum.fees_cents >= 100, `owner summary: ${sum.lola_bookings} Lola bookings, $${sum.fees_cents / 100}`);

// ══ 2. Lola, Marketing VP: the 30-day fill plan ══
reset();
const t0 = new Date('2026-10-05T14:00:00Z');   // Monday 10am in Miami
const day = (n, h = 14) => iso(Date.parse('2026-10-05T00:00:00Z') + n * DAY + h * 3600e3);
T.clients = [
  { id: 'due1', tenant_id: A, first_name: 'Maria', phone: '3055550001' },
  { id: 'due2', tenant_id: A, first_name: 'Lucia', phone: '3055550002' },
  { id: 'booked', tenant_id: A, first_name: 'Ines', phone: '3055550003' },
  { id: 'once', tenant_id: A, first_name: 'Nora', phone: '3055550004' },
  { id: 'lapsed', tenant_id: A, first_name: 'Rosa', phone: '3055550005' },
  { id: 'stop', tenant_id: A, first_name: 'Opted', phone: '3055550006', opted_out: true },
];
const visit = (cid, dAgo, svc = 'color') => T.bookings.push({ id: 'v' + T.bookings.length, tenant_id: A, client_id: cid, service_id: svc, staff_id: 'ana', start_time: day(-dAgo), end_time: day(-dAgo, 17), status: 'completed', total_amount: svc === 'color' ? 240 : 80, source: 'dashboard' });
visit('due1', 84); visit('due1', 42);                 // every 6 weeks → due now
visit('due2', 40);                                    // color, 40 days ago → due in ~2 days
visit('booked', 45); T.bookings.push({ id: 'fut', tenant_id: A, client_id: 'booked', service_id: 'color', staff_id: 'bo', start_time: day(3), end_time: day(3, 17), status: 'confirmed', total_amount: 240, source: 'voice' });
visit('once', 120, 'cut');
visit('lapsed', 200, 'cut');
visit('stop', 42);
// Fridays & Saturdays full for both stylists; the rest open
for (let n = 1; n <= 30; n++) {
  const dow = new Date(Date.parse('2026-10-05T12:00:00Z') + n * DAY).getUTCDay();
  if (dow === 5 || dow === 6) for (const s of ['ana', 'bo']) T.bookings.push({ id: `full${n}${s}`, tenant_id: A, client_id: null, service_id: 'cut', staff_id: s, start_time: day(n, 14), end_time: day(n, 22), status: 'confirmed', total_amount: 80, source: 'dashboard' });
}
const fc = await plan.forecast(c, T.tenants[0], { now: t0 });
const fri = fc.days.find(d => d.weekday === 'Friday'), tue = fc.days.find(d => d.weekday === 'Tuesday'), sun = fc.days.find(d => d.weekday === 'Sunday');
ok(fri.util === 1 && tue.util < 0.5 && sun.capacity_h === 0, `forecast: Friday full, Tuesday open (${tue.util}), Sunday closed`);
ok(fc.gap_days.length > 5 && !fc.gap_days.includes(fri.date), `open days found (${fc.gap_days.length}), full days excluded`);
ok(fc.revenue_at_stake > 0 && fc.per_hour > 0, `money on the table: $${fc.revenue_at_stake} (${fc.per_hour}/chair-hour)`);

const due = await audience(c, A, 'due', { now: t0 });
const dueNames = due.recipients.map(x => x.first_name).sort().join(',');
ok(dueNames === 'Lucia,Maria', `due-back audience from real visit rhythm: ${dueNames} (not the booked or opted-out client)`);
const once = await audience(c, A, 'second_visit', { now: t0 });
ok(once.recipients.map(x => x.first_name).join() === 'Nora', 'came-once audience');

let prompt = null;
const llm = async ({ system, messages }) => { prompt = system + '\n' + messages[0].content; const n = (messages[0].content.match(/^\d+\./gm) || []).length; return { ok: true, text: JSON.stringify({ messages: Array.from({ length: n }, (_, i) => `Hi {first_name}, message ${i + 1} from MMA Salon. Book: https://www.loladesk.com/book?t=mma`) }) }; };
let built = await plan.buildFillPlan(c, T.tenants[0], { now: t0, llm });
ok(built.ok && built.plan.status === 'proposed', 'plan built, waiting for the owner’s OK');
const p1 = built.plan;
ok(/Miami chic/.test(prompt) && /NEVER invent discounts/.test(prompt), 'copy written in the salon’s voice, no invented discounts');
ok(p1.items.every(it => /\{first_name\}/.test(it.message) && it.message.includes('/book?t=mma')), 'every text is personal and has the booking link');
ok(p1.items[0].segment === 'due' && p1.items[0].send_on === '2026-10-05' && p1.items[0].audience === 2, 'first move: the 2 clients due back, today');
ok(p1.items.every(it => !it.target_days.includes(fri.date)), 'campaigns aim at open days, never the full ones');
ok(p1.strategy.levers.some(l => /due back/.test(l)) && p1.strategy.levers.some(l => /quietest/.test(l)), 'strategy explains the levers');
ok(p1.strategy.projected_bookings >= 0 && typeof p1.strategy.projected_revenue === 'number', 'projected bookings and revenue');

const bad = await plan.buildFillPlan(c, T.tenants[0], { now: t0, llm: async () => ({ ok: false }) });
ok(bad.ok && bad.plan.items.every(it => it.written_by === 'template' && !/%|off|discount/i.test(it.message)), 'brain unavailable → safe templates');
ok(T.lola_fill_plans.find(x => x.id === p1.id).status === 'replaced', 'a rebuild replaces the old plan');

// nothing goes out before approval
let res = await plan.runFillPlans(c, { now: t0, llm });
ok(res.sent === 0 && !T.lola_campaigns.length, 'unapproved plan sends nothing');
const cur = await plan.latestPlan(c, A);
await plan.setPlanStatus(c, T.tenants[0], cur.id, 'approve');
res = await plan.runFillPlans(c, { now: new Date('2026-10-05T11:30:00Z'), llm });
ok(res.sent === 0, 'before 10am salon time: waits');
res = await plan.runFillPlans(c, { now: t0, llm });
await wait(50);
const camp = T.lola_campaigns[0];
ok(res.sent === 1 && camp && camp.segment === 'due' && camp.created_by === 'lola_plan', 'on its day at 10am: the due-back campaign goes out');
const to = texts.map(x => x.to).sort().join(',');
ok(to === '+13055550001,+13055550002', `texted only Maria & Lucia (${to})`);
ok(texts.every(x => /Reply STOP/.test(x.text) && /Maria|Lucia/.test(x.text)), 'personalized, with the opt-out line');
res = await plan.runFillPlans(c, { now: new Date(t0.getTime() + 3600e3), llm });
ok(res.sent === 0, 'never sent twice');

// a campaign whose target days filled up is skipped
const p2 = await plan.latestPlan(c, A);
const later = p2.items.find(it => it.status === 'planned' && it.target_days.length);
for (const d of later.target_days) for (const s of ['ana', 'bo']) T.bookings.push({ id: `fill${d}${s}`, tenant_id: A, service_id: 'cut', staff_id: s, start_time: d + 'T14:00:00.000Z', end_time: d + 'T22:00:00.000Z', status: 'confirmed', source: 'voice' });
res = await plan.runFillPlans(c, { now: new Date(Date.parse(later.send_on + 'T15:00:00Z')), llm });
const after = (await plan.latestPlan(c, A)).items.find(it => it.key === later.key);
ok(after.status === 'skipped' && after.reason === 'already_full', `"${later.name}" skipped — its days filled up first`);

// weekly roll keeps it running and never re-texts the same audience within 3 weeks
const rolled = await plan.runFillPlans(c, { now: new Date(t0.getTime() + 8 * DAY), llm });
const p3 = await plan.latestPlan(c, A);
const dueAgain = p3.items.find(it => it.segment === 'due');
ok(rolled.rebuilt === 1 && p3.status === 'active', 'weekly rebuild: fresh numbers, still running');
ok(!dueAgain || Date.parse(dueAgain.send_on) >= t0.getTime() + 20 * DAY, `due-back audience rests 3 weeks (${dueAgain ? dueAgain.send_on : 'not in this plan'})`);

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
