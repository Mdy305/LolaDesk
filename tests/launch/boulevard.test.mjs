// Boulevard, live: Lola checks the salon's real Boulevard availability, books in Boulevard, reads the
// appointment back to verify it, then mirrors it into LolaDesk — and never says "booked" otherwise.
import crypto from 'node:crypto';
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'k';
process.env.INTEGRATION_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const TZ = 'America/New_York', BIZ = '312bf55a-b6c5-48f2-ab40-eef5d78277ac', KEY = 'blvd-key-0000000000000000';
const day = new Date(Date.now() + 3 * 864e5).toLocaleDateString('en-CA', { timeZone: TZ });
const at = (hhmm) => { const x = new Date(`${day}T${hhmm}:00Z`); const off = new Date(x.toLocaleString('en-US', { timeZone: 'UTC' })) - new Date(x.toLocaleString('en-US', { timeZone: TZ })); return new Date(x.getTime() + off).toISOString(); };
const B = { calls: [], auth: [], times: ['10:00', '14:00', '14:30', '16:00'], cardRequired: false, down: false, checkout: [], updates: [], items: [] };
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  if (u.startsWith('https://dashboard.boulevard.io/api/2020-01/')) {
    if (B.down) throw new Error('connect ECONNREFUSED');
    B.auth.push(init.headers.Authorization);
    if (init.headers.Authorization !== 'Basic ' + Buffer.from(KEY + ':').toString('base64') || !u.includes(BIZ + '/client')) return J({ errors: [{ message: 'unauthorized' }] }, 401);
    const { query, variables } = JSON.parse(init.body); const op = (query.match(/(?:query|mutation)\s*(\w+)?/) || [])[1] || 'Locations';
    B.calls.push(op);
    const cart = (extra = {}) => ({ id: 'cart-1', errors: [], summary: { paymentMethodRequired: B.cardRequired }, ...extra });
    if (/locations\(/.test(query)) return J({ data: { locations: { edges: [{ node: { id: 'loc-1', name: 'MMA Salon Miami Beach', tz: TZ, address: { city: 'Miami Beach' } } }] } } });
    if (op === 'CreateCart') return J({ data: { createCart: { cart: cart() } } });
    if (/availableCategories/.test(query)) return J({ data: { cart: { availableCategories: [{ id: 'cat', name: 'Hair', disabled: false, availableItems: [{ __typename: 'CartAvailableBookableItem', id: 'svc-cut', name: "Women's Haircut & Style", disabled: false, listDurationRange: { min: 60 } }, { __typename: 'CartAvailableBookableItem', id: 'svc-bal', name: 'Balayage', disabled: false }] }] } } });
    if (/staffVariants/.test(query)) return J({ data: { cart: { availableItem: { staffVariants: [{ id: 'sv-ana', staff: { firstName: 'Ana', displayName: 'Ana' } }, { id: 'sv-bo', staff: { firstName: 'Bo', displayName: 'Bo' } }] } } } });
    if (op === 'AddItem') { B.items.push(variables.input); return J({ data: { addCartSelectedBookableItem: { cart: cart() } } }); }
    if (op === 'T') return J({ data: { cartBookableTimes: B.times.map((h, i) => ({ id: 'bt-' + h, score: i, startTime: at(h) })) } });
    if (op === 'D') return J({ data: { cartBookableDates: [{ date: day }] } });
    if (op === 'R') return J({ data: { reserveCartBookableItems: { cart: cart() } } });
    if (op === 'U') { B.updates.push(variables.input); return J({ data: { updateCart: { cart: cart() } } }); }
    if (op === 'K') { B.checkout.push(variables.input); return J({ data: { checkoutCart: { cart: cart({ completedAt: new Date().toISOString() }), appointments: [{ appointmentId: 'appt-777', clientId: 'cl-1', forCartOwner: true }] } } }); }
    if (op === 'A') return J({ data: { appointment: { id: 'appt-777', state: 'BOOKED', startAt: at('14:30'), endAt: at('15:30'), cancelled: false, appointmentServices: [{ service: { name: "Women's Haircut & Style" }, staff: { firstName: 'Ana', displayName: 'Ana' } }] } } });
    return J({ errors: [{ message: 'unknown op ' + op }] });
  }
  if (u.includes('/messages')) return J({ data: { id: 'm' } });
  return J({ data: [] });
};
const { T } = await import('./fake-supabase.mjs');
const TID = '66666666-6666-4666-8666-666666666666';
T.tenants = [{ id: TID, name: 'MMA Salon', slug: 'mma', subscription_status: 'active', phone_number: '+13055550100', booking_url: 'https://www.joinblvd.com/b/mmasalon/widget#/visit-type', services: [] }];
T.tenant_numbers = [{ tenant_id: TID, phone_number: '+13055550100', status: 'active' }];
T.tenant_users = [{ user_id: 'u1', tenant_id: TID, role: 'owner' }];
globalThis.__authUsers = { tok: { id: 'u1', email: 'o@mma.com' } };
T.booking_settings = [{ tenant_id: TID, timezone: TZ, metadata: {} }];
for (const k of ['integrations', 'bookings', 'clients', 'services', 'staff', 'usage_events', 'booking_history', 'client_memories', 'call_sessions', 'opt_outs', 'deposits']) T[k] = [];
const P = new URL('../../api/', import.meta.url).href;
const run = async (mod, req) => { const h = (await import(P + mod)).default; return new Promise((resolve) => { const res = { statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(o) { resolve({ status: this.statusCode, ...o }); }, end() { resolve({ status: this.statusCode }); } }; h({ method: 'POST', headers: {}, query: {}, ...req }, res); }); };

// ── Connecting: the keys are proven against Boulevard before anything is saved ──
let r = await run('boulevard.js', { headers: { authorization: 'Bearer tok' }, body: { business_id: BIZ, api_key: 'wrong-key-000000000000' } });
ok(r.status === 400 && /refused/.test(r.error) && !T.integrations.length, 'a wrong key is refused, nothing saved: ' + r.error);
r = await run('boulevard.js', { headers: { authorization: 'Bearer tok' }, body: { business_id: BIZ, api_key: KEY } });
ok(r.ok && r.connected && /MMA Salon Miami Beach/.test(r.say), 'the right Business ID + API key → connected: ' + r.say);
const row = T.integrations.find((x) => x.provider === 'boulevard_client');
ok(row && row.access_token !== KEY && row.metadata.business_id === BIZ && row.metadata.location_id === 'loc-1', 'the API key is stored encrypted, with the location');
r = await run('boulevard.js', { method: 'GET', headers: { authorization: 'Bearer tok' } });
ok(r.connected && !String(JSON.stringify(r)).includes(KEY), 'Settings shows it connected — never the key');

const { SKILLS } = await import(P + 'lola-tools.js');
const tenant = T.tenants[0];

// ── Availability is Boulevard's own ──
r = await SKILLS.check_availability(tenant, { service: 'haircut', date: day, time: '2pm' });
ok(r.source === 'boulevard' && r.exact && /Yes — 2 PM .* works for Women's Haircut & Style/.test(r.speak), 'asked 2pm, Boulevard has it → yes: ' + r.speak);
r = await SKILLS.check_availability(tenant, { service: 'haircut', date: day, time: '3pm' });
ok(!r.exact && /3pm is taken — the closest I have .* 2:30 PM/.test(r.speak.replace(/ /g, ' ')), 'asked 3pm, not open in Boulevard → the closest real times: ' + r.speak);
r = await SKILLS.check_availability(tenant, { service: 'balayage with Ana', date: day, stylist: 'Ana' });
ok(B.items.at(-1).itemId === 'svc-bal' && B.items.at(-1).itemStaffVariantId === 'sv-ana' && / with Ana/.test(r.speak), 'the stylist they ask for is the one Boulevard checks: ' + r.speak);

// ── Booking: details first, then Boulevard, then verified ──
const tools = (await import(P + 'lola-tools.js')).default;
const { toolKey } = await import(P + 'lib/tool-key.js');
const call = (body) => new Promise((resolve) => { const res = { setHeader() {}, status() { return this; }, json: resolve, end: resolve }; tools({ method: 'POST', query: { k: toolKey(), tool: 'book_appointment', ch: 'web', salon: '+13055550100' }, headers: {}, body }, res); });
r = await call({ service: 'haircut', date: day, time: '2:30pm', client_name: 'Jerome' });
ok(r.booked === false && !B.calls.includes('K'), 'no last name / mobile / email yet → nothing sent to Boulevard');
r = await call({ service: 'haircut', date: day, time: '2:30pm', client_name: 'Jerome Martin', client_phone: '305-555-0199', client_email: 'jerome@example.com', stylist: 'Ana' });
ok(r.booked === true && r.verified === true && r.provider === 'boulevard' && r.appointment_id === 'appt-777', 'booked IN Boulevard and read back to verify: ' + r.speak);
ok(B.updates.at(-1).clientInformation.firstName === 'Jerome' && B.updates.at(-1).clientInformation.lastName === 'Martin' && B.updates.at(-1).clientInformation.email === 'jerome@example.com' && /305/.test(B.updates.at(-1).clientInformation.phoneNumber), 'Boulevard gets first name, last name, mobile and email');
const mirror = T.bookings.find((b) => b.external_id === 'appt-777');
ok(mirror && mirror.external_provider === 'boulevard' && mirror.start_time === at('14:30') && T.clients.some((c) => c.last_name === 'Martin'), 'and it appears in LolaDesk (calendar + client card), linked to the Boulevard appointment');
ok(/confirmed in our book/.test(r.speak) && / with Ana/.test(r.speak), 'she says it the way it is: ' + r.speak);

// Taken between the question and the booking.
r = await call({ service: 'haircut', date: day, time: '3pm', client_name: 'Jerome Martin', client_phone: '305-555-0199', client_email: 'jerome@example.com' });
ok(r.booked === false && r.conflict && /just taken/.test(r.speak), 'a time Boulevard no longer has → not booked, real alternatives: ' + r.speak);

// Boulevard wants a card on file.
B.cardRequired = true; const before = B.checkout.length;
r = await call({ service: 'haircut', date: day, time: '4pm', client_name: 'Jerome Martin', client_phone: '305-555-0199', client_email: 'jerome@example.com' });
ok(r.booked === false && r.card_required && B.checkout.length === before && /not booked|isn't booked|not booked until/i.test(r.speak.replace(/It's not/,'not')), 'card required → never checked out, never claimed: ' + r.speak);
B.cardRequired = false;

// Boulevard unreachable.
B.down = true;
r = await call({ service: 'haircut', date: day, time: '10am', client_name: 'Jerome Martin', client_phone: '305-555-0199', client_email: 'jerome@example.com' });
ok(r.booked === false && /NOT booked/.test(r.speak), 'Boulevard down → she says it’s not booked yet: ' + r.speak);
B.down = false;

// Disconnect → back to LolaDesk's calendar.
r = await run('boulevard.js', { method: 'DELETE', headers: { authorization: 'Bearer tok' } });
const { boulevardCreds } = await import(P + 'lib/connectors/boulevard-client.js');
ok(r.ok && !(await boulevardCreds(TID)), 'disconnect → Lola books in LolaDesk again');
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
