process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'k';
process.env.LOLA_TOOL_SECRET = 'tool-secret';
const sent = [];
globalThis.fetch = async (url, init) => { sent.push({ url: String(url), body: init && init.body }); return new Response(JSON.stringify({ data: { id: 'm' } }), { status: 200, headers: { 'content-type': 'application/json' } }); };
const { T } = await import('./fake-supabase.mjs');
const P = new URL('../../api/', import.meta.url).href;
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const TZ = 'America/New_York';
const A = '11111111-1111-4111-8111-111111111111', A2 = '33333333-3333-4333-8333-333333333333', B = '22222222-2222-4222-8222-222222222222';
// MMA twice (duplicate signup, same number) + another salon
T.tenants = [
  { id: A2, slug: 'mma-2', name: 'MMA Salon', phone_number: '+13055550100', status: 'active', subscription_status: 'trial', created_at: '2026-09-10T00:00:00Z' },
  { id: A, slug: 'mma', name: 'MMA Salon', phone_number: '+13055550100', status: 'active', subscription_status: 'active', stripe_subscription_id: 'sub_1', created_at: '2026-08-01T00:00:00Z' },
  { id: B, slug: 'other', name: 'Other Salon', phone_number: '+17865550199', status: 'active', created_at: '2026-08-02T00:00:00Z' }];
T.tenant_numbers = [];
T.booking_settings = [{ tenant_id: A, timezone: TZ, slot_interval_minutes: 30, minimum_notice_minutes: 0, booking_horizon_days: 60 }, { tenant_id: B, timezone: 'America/Los_Angeles', slot_interval_minutes: 30, minimum_notice_minutes: 0 }];
T.services = [{ id: 'svcA', tenant_id: A, name: 'Blowout', duration_minutes: 45, price: 55, is_active: true }, { id: 'svcB', tenant_id: B, name: 'Cut', duration_minutes: 30, price: 40, is_active: true }];
T.staff = [{ id: 'sa', tenant_id: A, name: 'Ana', is_active: true }, { id: 'sb', tenant_id: B, name: 'Zed', is_active: true }];
T.staff_schedules = []; for (let d = 0; d < 7; d++) { T.staff_schedules.push({ tenant_id: A, staff_id: 'sa', day_of_week: d, start_time: '10:00', end_time: '18:00' }); T.staff_schedules.push({ tenant_id: B, staff_id: 'sb', day_of_week: d, start_time: '10:00', end_time: '18:00' }); }
T.staff_services = []; T.staff_time_off = []; T.blocked_slots = []; T.bookings = []; T.availability_holds = []; T.clients = [];
function call(handler, body, headers = { 'x-lola-tool-secret': 'tool-secret' }) {
  return new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(o) { resolve({ status: this.statusCode, body: o }); return this; }, setHeader() {}, end() { resolve({ status: this.statusCode }); }, send(o) { resolve({ status: this.statusCode, body: o }); } };
    handler({ method: 'POST', body, headers, query: {} }, res);
  });
}
const check = (await import(P + 'lola/check-availability.js')).default;
const book = (await import(P + 'lola/book-appointment.js')).default;
let r = await call(check, { to_number: '+13055550100', service_id: 'svcA' }, {});
ok(r.status === 401, 'voice tool without the secret header is refused');
r = await call(check, { to_number: '(305) 555-0100', service_id: 'svcA' });
ok(r.status === 200 && r.body.count === 3 && /AM|PM/.test(r.body.message), `MMA's number answers with MMA's openings: "${r.body.message}"`);
r = await call(check, { to_number: '+13055550100', service_id: 'svcB' });
ok(r.status === 404, "MMA's line can't see another salon's service");
r = await call(check, { to_number: '+19995550000', service_id: 'svcA' });
ok(r.status === 404, 'unknown number → not found (never the demo salon)');
const day = new Date(Date.now() + 2 * 86400e3).toLocaleDateString('en-CA', { timeZone: TZ });
r = await call(check, { to_number: '+13055550100', service_id: 'svcA', date: day });
const slot = r.body.slots[1];
r = await call(book, { to_number: '+13055550100', from_number: '+13055557777', service_id: 'svcA', start_iso: slot.iso, client_name: 'Maria' });
const bk = T.bookings[0];
ok(r.status === 200 && bk && bk.tenant_id === A, `voice booking lands on the paying MMA row (${bk && bk.tenant_id === A ? 'A' : bk && bk.tenant_id})`);
ok(bk && bk.staff_id === 'sa' && Number(bk.total_amount) === 55, 'any stylist resolved, menu price');
await new Promise(r => setTimeout(r, 300)); const sms = sent.filter(x => /telnyx/.test(x.url)).map(x => String(x.body));
ok(sms.some(b => b.includes('+13055557777') && /AM|PM/.test(b)), 'confirmation text sent to the caller with salon-time');
r = await call(book, { to_number: '+13055550100', from_number: '+13055558888', service_id: 'svcA', start_iso: slot.iso, client_name: 'Late' });
ok(!(r.body && r.body.success) && T.bookings.length === 1, 'second caller for the same slot is not double-booked');
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
