// Any platform: Lola checks a real time, then hands the client the salon's own booking link to finish.
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'k';
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const sms = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  if (u.includes('/v2/messages')) { sms.push(JSON.parse(init.body)); return J({ data: { id: 'm' } }); }
  return J({ data: [] });
};
const { T } = await import('./fake-supabase.mjs');
const P = new URL('../../api/', import.meta.url).href;
const TZ = 'America/New_York', TID = '00000000-0000-4000-8000-0000000000c1', DAY = 864e5;
const day = new Date(Date.now() + 3 * DAY).toLocaleDateString('en-CA', { timeZone: TZ });
T.tenants = [{ id: TID, name: 'MMA Salon', slug: 'mma', subscription_status: 'active', phone_number: '+13055550100', booking_url: 'https://www.joinblvd.com/b/mmasalon/widget', services: [{ name: 'Cut', price: 80, duration: 60 }] }];
T.tenant_numbers = [{ tenant_id: TID, phone_number: '+13055550100', kind: 'primary', status: 'active' }];
T.tenant_users = [{ user_id: 'u1', tenant_id: TID, role: 'owner', status: 'active' }];
globalThis.__authUsers = { tok: { id: 'u1', email: 'o@mma.com' } };
T.booking_settings = [{ tenant_id: TID, timezone: TZ, slot_interval_minutes: 30, minimum_notice_minutes: 0, booking_horizon_days: 90, default_buffer_before_min: 0, default_buffer_after_min: 0, metadata: {} }];
T.services = [{ id: 'cut', tenant_id: TID, name: 'Cut', duration_minutes: 60, price: 80, is_active: true }];
T.staff = [{ id: 'ana', tenant_id: TID, name: 'Ana', is_active: true }];
T.staff_services = []; T.staff_schedules = []; for (let d = 0; d < 7; d++) T.staff_schedules.push({ tenant_id: TID, staff_id: 'ana', day_of_week: d, start_time: '09:00', end_time: '17:00' });
T.staff_time_off = []; T.blocked_slots = []; T.bookings = []; T.availability_holds = []; T.clients = []; T.locations = []; T.business_hours = [];
T.cached_availability = []; T.provider_mappings = []; T.booking_outbox = []; T.integrations = []; T.client_memories = []; T.usage_events = []; T.opt_outs = []; T.tenant_channels = [];
const run = async (mod, req) => { const h = (await import(P + mod)).default; return new Promise((resolve) => { const res = { statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(o) { resolve({ status: this.statusCode, ...o }); }, end() { resolve({ status: this.statusCode }); } }; h({ method: 'POST', headers: { authorization: 'Bearer tok' }, query: {}, ...req }, res); }); };
const { SKILLS } = await import(P + 'lola-tools.js');

let r = await SKILLS.book_appointment(T.tenants[0], { service: 'Cut', date: day, time: '11:00am', client_name: 'Sarah Kim', client_phone: '+13055554444' });
ok(r.booked && T.bookings.length === 1, 'default: Lola books straight into LolaDesk');
r = await run('lola/booking-mode.js', { body: { mode: 'link' } });
ok(r.ok && r.mode === 'link', 'owner chooses “Lola texts my booking link”');
T.tenants[0].booking_url = '';
r = await run('lola/booking-mode.js', { body: { mode: 'link' } });
ok(r.status === 400 && /booking link/.test(r.error), 'it asks for the booking link first');
T.tenants[0].booking_url = 'https://www.joinblvd.com/b/mmasalon/widget';

const before = T.bookings.length;
r = await SKILLS.book_appointment(T.tenants[0], { service: 'Cut', date: day, time: '2:00pm', client_name: 'Mia Lopez', client_phone: '+13055551212' });
ok(!r.booked && r.link_sent && T.bookings.length === before, 'on a call: no LolaDesk booking is made — the salon’s system stays the source of truth');
ok(sms.at(-1)?.to === '+13055551212' && sms.at(-1).from === '+13055550100' && /joinblvd\.com\/b\/mmasalon/.test(sms.at(-1).text) && /Cut/.test(sms.at(-1).text) && /2:00/.test(sms.at(-1).text) && /STOP/.test(sms.at(-1).text), 'she texts the Boulevard link with the exact service and time: ' + sms.at(-1)?.text);
ok(/texted you our booking link/.test(r.speak), 'and tells the caller: ' + r.speak);
ok(T.client_memories.some((m) => m.key === 'pending_booking' && m.client_phone === '+13055551212'), 'she remembers the booking she’s waiting on');

const n = sms.length;
r = await SKILLS.book_appointment(T.tenants[0], { service: 'Cut', date: day, time: '3:00pm', client_name: 'Jo', client_phone: '+13055557777', channel: 'sms' });
ok(sms.length === n && /joinblvd\.com/.test(r.speak), 'in a text or DM the link goes right in her reply (no second text)');
r = await SKILLS.book_appointment(T.tenants[0], { service: 'Cut', date: day, time: '4:00pm', channel: 'instagram' });
ok(/joinblvd\.com/.test(r.speak) && sms.length === n, 'Instagram (no phone): link in the DM');

const at = (hhmm) => { const d = new Date(`${day}T${hhmm}:00Z`); const off = (new Date(d.toLocaleString('en-US', { timeZone: 'UTC' })) - new Date(d.toLocaleString('en-US', { timeZone: TZ }))); return new Date(d.getTime() + off).toISOString(); };
T.cached_availability = [{ tenant_id: TID, provider: 'zapier', external_booking_id: 'b1', starts_at: at('10:00'), ends_at: at('11:00'), staff_id: null, status: 'booked' }];
r = await SKILLS.book_appointment(T.tenants[0], { service: 'Cut', date: day, time: '10:00am', client_name: 'Ann', client_phone: '+13055558888' });
ok(r.conflict && !r.link_sent && /taken/.test(r.speak), 'a time already taken in Boulevard is never offered: ' + r.speak);

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
