// Booking honesty: on a call or the website Lola gets first + last name, mobile and email before she
// books, says "booked" only when the calendar says so, texts AND emails the confirmation, and never
// pretends when the salon can't be reached.
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'k';
process.env.SENDGRID_API_KEY = 'sg-test'; process.env.EMAIL_FROM = 'lola@loladesk.com'; process.env.TELNYX_LOLA_BRAIN_ID = 'assistant-lola';
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const mails = [], texts = [], updates = [];
const assistant = { id: 'assistant-lola', name: 'Lola', greeting: '{{lola_greeting}}', instructions: 'You are Lola. [LolaDesk compliance]',
  dynamic_variables: {}, telephony_settings: { supports_unauthenticated_web_calls: true },
  tools: [{ type: 'webhook', webhook: { name: 'book_appointment', description: 'Book', url: 'https://www.loladesk.com/api/lola-tools?tool=book_appointment', method: 'POST', body_parameters: { type: 'object', properties: { service: { type: 'string' }, date: { type: 'string' }, time: { type: 'string' } }, required: ['service'] } } }] };
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  if (u.includes('api.sendgrid.com')) { mails.push(JSON.parse(init.body)); return new Response('', { status: 202 }); }
  if (u.includes('/messages')) { texts.push(JSON.parse(init.body || '{}')); return J({ data: { id: 'm1' } }); }
  if (/\/ai\/assistants\/assistant-lola/.test(u)) { if (init.method === 'POST' || init.method === 'PATCH') { const b = JSON.parse(init.body); updates.push(b); Object.assign(assistant, b); } return J({ data: assistant }); }
  if (u.includes('/ai/assistants')) return J({ data: [assistant] });
  return J({ data: [] });
};
const { T } = await import('./fake-supabase.mjs');
const TID = '44444444-4444-4444-8444-444444444444', TZ = 'America/New_York';
const day = new Date(Date.now() + 3 * 864e5).toLocaleDateString('en-CA', { timeZone: TZ });
T.tenants = [{ id: TID, name: 'MMA Salon', slug: 'mma', subscription_status: 'active', phone_number: '+13055550100', services: [{ name: 'Cut', price: 80, duration: 60 }] }];
T.tenant_numbers = [{ tenant_id: TID, phone_number: '+13055550100', status: 'active' }];
T.booking_settings = [{ tenant_id: TID, timezone: TZ, slot_interval_minutes: 15, minimum_notice_minutes: 0, booking_horizon_days: 90, default_buffer_before_min: 0, default_buffer_after_min: 0, metadata: {} }];
T.services = [{ id: 'cut', tenant_id: TID, name: 'Cut', duration_minutes: 60, price: 80, is_active: true }];
T.staff = [{ id: 'ana', tenant_id: TID, name: 'Ana', is_active: true }]; T.staff_services = []; T.staff_schedules = [];
for (let d = 0; d < 7; d++) T.staff_schedules.push({ tenant_id: TID, staff_id: 'ana', day_of_week: d, start_time: '09:00', end_time: '17:00' });
for (const k of ['staff_time_off', 'blocked_slots', 'bookings', 'availability_holds', 'clients', 'locations', 'business_hours', 'cached_availability', 'provider_mappings', 'booking_outbox', 'integrations', 'client_memories', 'usage_events', 'deposits', 'tenant_channels', 'opt_outs', 'call_sessions']) T[k] = [];
const P = new URL('../../api/', import.meta.url).href;
const tools = (await import(P + 'lola-tools.js')).default;
const { toolKey } = await import(P + 'lib/tool-key.js');
const call = (query, body) => new Promise((resolve) => {
  const res = { statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(o) { resolve(o); }, end() { resolve({}); } };
  tools({ method: 'POST', query: { k: toolKey(), ...query }, headers: {}, body }, res);
});
const web = { tool: 'book_appointment', ch: 'web', salon: '+13055550100', call: 'v3:web-1' };

let r = await call(web, { service: 'Cut', date: day, time: '2pm', client_name: 'Jerome' });
ok(r.booked === false && r.needs.includes('first and last name') && r.needs.includes('mobile number') && r.needs.includes('email'), 'website: a first name alone books nothing — she asks for last name, mobile and email: ' + r.speak);
ok(T.bookings.length === 0, 'and nothing lands in the calendar yet');

r = await call(web, { service: 'Cut', date: day, time: '2pm', client_name: 'Jerome Martin', client_phone: '(305) 555-0199' });
ok(r.booked === false && r.needs.length === 1 && r.needs[0] === 'email' && /email/.test(r.speak), 'only the email left → she asks for it (or skip): ' + r.speak);

r = await call(web, { service: 'Cut', date: day, time: '2pm', client_name: 'Jerome Martin', client_phone: '(305) 555-0199', client_email: 'Jerome@Example.com' });
ok(r.booked === true && T.bookings.length === 1, 'all details → really booked: ' + r.speak);
const cl = T.clients.find((c) => c.phone === '+13055550199');
ok(cl && cl.first_name === 'Jerome' && cl.last_name === 'Martin' && cl.email === 'jerome@example.com', 'the client lands in LolaDesk with first, last name, mobile and email');
ok(mails.length === 1 && mails[0].personalizations[0].to[0].email === 'jerome@example.com' && /Confirmed: Cut/.test(mails[0].personalizations[0].subject) && mails[0].from.email === 'lola@loladesk.com', 'the confirmation email goes out from lola@loladesk.com');
ok(r.confirmation?.email_to === 'jerome@example.com' && r.confirmation?.text_to && /text and email you a confirmation/.test(r.speak), 'and she says a text and an email are on their way a text and an email are on their way');

// A returning client calling from their phone: details on file fill themselves in.
r = await call({ tool: 'book_appointment', to: '+13055550100', from: '+13055550199' }, { service: 'Cut', date: day, time: '4pm' });
ok(r.booked === true && mails.length === 2, 'a returning caller isn’t asked again for what LolaDesk already knows: ' + r.speak);

// Skipping the email is fine.
r = await call(web, { service: 'Cut', date: day, time: '11am', client_name: 'Ana Lopez', client_phone: '3055550123', no_email: true });
ok(r.booked === true && !r.confirmation?.email_to && mails.length === 2, 'no email (they said skip) → still booked, text only');

// The salon unknown (widget pasted without LolaDesk's salon header): never a fake booking.
r = await call({ tool: 'book_appointment', ch: 'web' }, { service: 'Cut', date: day, time: '3pm', client_name: 'Jo Doe', client_phone: '3055550144', client_email: 'jo@x.com' });
ok(r.booked === false && r.error === 'salon_unknown' && /nothing is booked/.test(r.speak), 'no salon on the call → she says plainly nothing is booked: ' + r.speak);

// The salon books from the dashboard / Zapier: no client-detail interview.
const { SKILLS } = await import(P + 'lola-tools.js');
r = await SKILLS.book_appointment(T.tenants[0], { service: 'Cut', date: day, time: '9am', client_name: 'Walk-in' });
ok(r.booked === true, 'the salon’s own bookings are never blocked by the client questions');

// Her Telnyx assistant is taught the same: the tool asks for the details, the rules forbid pretending.
const W = await import(P + 'lib/assistant-wiring.js');
const w = await W.wireAssistant({ heal: true });
const bt = assistant.tools.find((t) => t.webhook?.name === 'book_appointment');
ok(!w.error && bt.webhook.body_parameters.properties.client_email && /LAST/.test(bt.webhook.body_parameters.properties.client_name.description) && bt.webhook.body_parameters.required.includes('client_phone'), 'book_appointment on Telnyx now asks for first + last name, mobile and email');
ok(assistant.instructions.includes('[LolaDesk booking]') && /Only say an appointment is booked when book_appointment answers booked: true/.test(assistant.instructions), 'her instructions forbid saying “booked” unless it is');
const w2 = await W.wireAssistant({ heal: true });
ok(assistant.instructions.split('[LolaDesk booking]').length === 2 && w2.booking.asks_full_details, 'taught once — never duplicated');
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
