// The trial actually ends — and every lost booking becomes a reason to pay.
// Off unless BILLING_ENFORCE=1. Paid salons and salons still in trial are
// never touched. Callers never hear about billing.
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'k';
delete process.env.LOLA_TOOL_SECRET; delete process.env.BILLING_ENFORCE; delete process.env.APP_URL;
const texts = [];
globalThis.fetch = async (url, init) => { if (/telnyx/.test(String(url))) texts.push(JSON.parse(init.body)); return new Response(JSON.stringify({ data: { id: 'm' } }), { status: 200, headers: { 'content-type': 'application/json' } }); };
const { T } = await import('./fake-supabase.mjs');
const P = new URL('../../api/', import.meta.url).href;
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };

const DAY = 864e5, now = Date.now();
const mk = (id, n, extra) => ({ id, name: n, slug: n.toLowerCase().replace(/\W+/g, '-'), phone_number: '+1305555' + id.slice(-4), operator_phone: '+1786555' + id.slice(-4), created_at: new Date(now - 20 * DAY).toISOString(), ...extra });
const EXPIRED = mk('00000000-0000-4000-8000-000000000001', 'Expired Salon', { subscription_status: 'trial', trial_ends_at: new Date(now - 2 * DAY).toISOString() });
const PAID = mk('00000000-0000-4000-8000-000000000002', 'Paid Salon', { subscription_status: 'active', trial_ends_at: new Date(now - 30 * DAY).toISOString() });
const TRIAL = mk('00000000-0000-4000-8000-000000000003', 'Trial Salon', { subscription_status: 'trial', trial_ends_at: new Date(now + 5 * DAY).toISOString() });
const LEGACY = mk('00000000-0000-4000-8000-000000000004', 'Legacy Salon', { subscription_status: 'trial', trial_ends_at: null });
const reset = () => { T.tenants = [EXPIRED, PAID, TRIAL, LEGACY].map((t) => ({ ...t })); T.tenant_numbers = []; T.usage_events = []; T.client_memories = []; T.clients = []; T.bookings = []; T.services = []; T.staff = []; T.calls = []; T.booking_settings = []; T.waitlist = []; texts.length = 0; };
reset();

const call = async (mod, body) => { const h = (await import(P + mod)).default; return new Promise((resolve) => { const res = { statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(o) { resolve({ status: this.statusCode, ...o }); }, end() { resolve({ status: this.statusCode }); } }; h({ method: 'POST', url: '/api/' + mod, headers: {}, body }, res); }); };
const avail = (t) => call('lola/check-availability.js', { to_number: t.phone_number, from_number: '+13055559999', service_id: 'svc' });
// Booking by phone is a write: only LolaDesk's own (signed k=…) Telnyx wiring may call it.
const { toolKey } = await import(P + 'lib/tool-key.js');
const book = async (t) => { const h = (await import(P + 'lola/book-appointment.js')).default; return new Promise((resolve) => { const res = { statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(o) { resolve({ status: this.statusCode, ...o }); }, end() { resolve({ status: this.statusCode }); } }; h({ method: 'POST', url: '/api/lola/book-appointment?k=' + toolKey(), query: { k: toolKey() }, headers: {}, body: { to_number: t.phone_number, from_number: '+13055559999', service_id: 'svc', start_iso: new Date(now + 3 * DAY).toISOString() } }, res); }); };
const widget = async (t, action, extra = {}) => { const h = (await import(P + 'public-booking.js')).default; return new Promise((resolve) => { const res = { statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(o) { resolve({ status: this.statusCode, ...o }); }, end() { resolve({ status: this.statusCode }); } }; h({ method: 'POST', url: '/api/public-booking', headers: {}, query: {}, body: { action, tenant: t.slug, ...extra } }, res); }); };

// ── Switch off (default): nothing changes for anyone ──
let r = await book(EXPIRED);
ok(!r.blocked, 'switch off: an expired trial still books by phone (no surprise shutdowns)');
r = await widget(EXPIRED, 'availability', { service_id: 'svc' });
ok(!r.blocked, 'switch off: website widget unchanged');

// ── Switch on ──
process.env.BILLING_ENFORCE = '1';
reset();
r = await avail(EXPIRED);
ok(r.blocked && r.ok === false, 'expired trial: phone availability paused');
const { CALLER_LINE, WIDGET_LINE } = await import(P + 'lib/billing-enforce.js');
ok(r.message === CALLER_LINE, 'caller hears the callback line: "' + r.message.slice(0, 60) + '…"');
ok(!/trial|billing|pay|subscri|plan/i.test(CALLER_LINE + WIDGET_LINE), 'callers and website visitors never hear about billing');
r = await book(EXPIRED);
ok(r.blocked && r.message === CALLER_LINE, 'expired trial: phone booking paused');
ok(T.usage_events.filter((e) => e.kind === 'paywall_turned_away' && e.tenant_id === EXPIRED.id).length === 2, 'every turned-away booking is logged for the owner');

r = await book(PAID);
ok(!r.blocked, 'paid salon: never paused, even with an old trial date');
r = await book(TRIAL);
ok(!r.blocked, 'salon still in its trial: never paused');
r = await book(LEGACY);
ok(!r.blocked, 'salon with no trial date (legacy / your own): never paused');

r = await widget(EXPIRED, 'availability', { service_id: 'svc' });
ok(r.ok === true && r.blocked && r.slots.length === 0, 'expired trial: website shows no times → its waitlist appears (a lead the salon keeps)');
r = await widget(EXPIRED, 'hold', { service_id: 'svc', staff_id: 'st', starts_at: new Date(now + DAY).toISOString(), client_phone: '+13055551234' });
ok(r.ok === false && r.error === WIDGET_LINE, 'expired trial: website hold refused with a human sentence');
r = await widget(EXPIRED, 'waitlist_add', { client_name: 'Ana', client_phone: '+13055551234', service_id: 'svc' });
ok(!r.blocked, 'waitlist stays open, so no client is ever turned away empty-handed');
r = await widget(PAID, 'availability', { service_id: 'svc' });
ok(!r.blocked, 'paid salon: website booking untouched');

// ── Owner texts: immediate, rate-limited, polite hours ──
const { turnedAway, runTrialReminders } = await import(P + 'lib/billing-enforce.js');
const { default: db0 } = { default: null };
const { db } = await import(P + 'lib/db.js');
const at = (h, dayOffset = 0) => { const d = new Date(now + dayOffset * DAY); const s = d.toLocaleString('en-US', { timeZone: 'America/New_York' }); const local = new Date(s); return new Date(d.getTime() + (h - local.getHours()) * 3600e3 - local.getMinutes() * 60e3); };
reset();
let o = await turnedAway(db(), T.tenants[0], { channel: 'voice', caller: '+13055559999', when: 'Friday, October 3, 2:00 PM', now: at(14) });
ok(o.texted && texts.length === 1 && texts[0].to === EXPIRED.operator_phone, 'owner texted right away, from the salon line to the owner');
ok(/\(305\) 555-9999/.test(texts[0].text) && /Friday, October 3/.test(texts[0].text) && /\/subscription/.test(texts[0].text), 'text says who, when, and links to keep Lola: ' + texts[0].text.slice(0, 90) + '…');
o = await turnedAway(db(), T.tenants[0], { channel: 'voice', caller: '+13055558888', now: at(15) });
ok(!o.texted && texts.length === 1 && o.logged, 'second turn-away within 4 hours: logged, no second text');
o = await turnedAway(db(), T.tenants[0], { channel: 'voice', caller: '+13055558888', now: at(19) });
ok(o.texted && texts.length === 2, 'after 4 hours: texted again');
reset();
o = await turnedAway(db(), T.tenants[0], { channel: 'voice', now: at(23) });
ok(!o.texted && o.logged, 'never texts the owner at night (logged for the morning)');
reset(); T.tenants[0].operator_phone = T.tenants[0].phone_number;
o = await turnedAway(db(), T.tenants[0], { channel: 'voice', now: at(14) });
ok(!o.texted, 'never texts the salon line itself');

// ── Trial-ending reminders with proof ──
reset();
T.tenants[2].trial_ends_at = new Date(at(14).getTime() + 2.5 * DAY).toISOString(); // → 3 days left (ceil)
T.calls = [1, 2, 3, 4].map((i) => ({ id: 'c' + i, tenant_id: TRIAL.id, created_at: new Date(now - DAY).toISOString() }));
T.bookings = [
  { id: 'b1', tenant_id: TRIAL.id, source: 'voice', total_amount: 90, status: 'confirmed', created_at: new Date(now - DAY).toISOString() },
  { id: 'b2', tenant_id: TRIAL.id, source: 'widget', total_amount: 60, status: 'confirmed', created_at: new Date(now - DAY).toISOString() },
  { id: 'b3', tenant_id: TRIAL.id, source: 'dashboard', total_amount: 500, status: 'confirmed', created_at: new Date(now - DAY).toISOString() },
  { id: 'b4', tenant_id: TRIAL.id, source: 'voice', total_amount: 70, status: 'cancelled', created_at: new Date(now - DAY).toISOString() },
];
let rr = await runTrialReminders(db(), { now: at(14) });
const sent3 = texts.filter((t) => t.to === TRIAL.operator_phone);
ok(sent3.length === 1 && /ends in 3 days/.test(sent3[0].text), '3 days left: one reminder');
ok(/answered 4 calls and booked 2 appointments \(\$150\)/.test(sent3[0].text), 'proof counts only what Lola booked (not owner-entered, not cancelled): ' + sent3[0].text.slice(0, 110) + '…');
rr = await runTrialReminders(db(), { now: at(14.5) });
ok(texts.filter((t) => t.to === TRIAL.operator_phone).length === 1, 'never the same reminder twice');
T.tenants[2].trial_ends_at = new Date(at(14).getTime() + 0.5 * DAY).toISOString();
rr = await runTrialReminders(db(), { now: at(14) });
ok(texts.filter((t) => t.to === TRIAL.operator_phone && /ends tomorrow/.test(t.text)).length === 1, '1 day left: "ends tomorrow" reminder');
ok(!texts.some((t) => t.to === PAID.operator_phone || t.to === LEGACY.operator_phone || t.to === EXPIRED.operator_phone), 'paid, legacy and already-expired salons get no trial reminder');
reset(); T.tenants[2].trial_ends_at = new Date(at(8).getTime() + 2.5 * DAY).toISOString();
await runTrialReminders(db(), { now: at(8) });
ok(texts.length === 0, 'reminders only 10 a.m.–7 p.m. salon time');
delete process.env.BILLING_ENFORCE; reset(); T.tenants[2].trial_ends_at = new Date(at(14).getTime() + 2.5 * DAY).toISOString();
await runTrialReminders(db(), { now: at(14) });
ok(texts.length === 0, 'switch off: no reminders');

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
