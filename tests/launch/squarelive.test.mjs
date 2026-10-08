// Square, live: Lola asks Square itself for open times, books inside Square, reads it back, mirrors it into
// LolaDesk — the same front-desk flow as Boulevard. A Square account without appointments stays on LolaDesk's calendar.
import crypto from 'node:crypto';
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'k';
process.env.INTEGRATION_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64'); process.env.SQUARE_ENV = 'production';
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const TZ = 'America/New_York';
const day = new Date(Date.now() + 3 * 864e5).toLocaleDateString('en-CA', { timeZone: TZ });
const at = (hhmm, d = day) => { const x = new Date(`${d}T${hhmm}:00Z`); const off = new Date(x.toLocaleString('en-US', { timeZone: 'UTC' })) - new Date(x.toLocaleString('en-US', { timeZone: TZ })); return new Date(x.getTime() + off).toISOString(); };
const S = { open: ['10:00', '14:00', '14:30', '16:00'], services: true, bookings: [], customers: [], token: 'tok-1', refreshed: 0, taken: false };
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  if (!u.startsWith('https://connect.squareup.com')) { if (u.includes('/messages')) return J({ data: { id: 'm' } }); return J({ data: [] }); }
  const path = u.replace('https://connect.squareup.com', ''); const body = init.body ? JSON.parse(init.body) : {};
  if (path === '/oauth2/token') { S.refreshed++; S.token = 'tok-2'; return J({ access_token: 'tok-2', refresh_token: 'r-2', expires_at: '2099-01-01T00:00:00Z' }); }
  if ((init.headers?.Authorization || '') !== 'Bearer ' + S.token) return J({ errors: [{ code: 'UNAUTHORIZED', detail: 'expired' }] }, 401);
  if (path.startsWith('/v2/locations')) return J({ locations: [{ id: 'L1', status: 'ACTIVE' }] });
  if (path === '/v2/catalog/search-catalog-items') return J({ items: S.services ? [
    { id: 'I1', item_data: { name: "Women's Haircut", variations: [{ id: 'V-CUT', version: 7, item_variation_data: { name: 'Regular', service_duration: 3600000, available_for_booking: true } }] } },
    { id: 'I2', item_data: { name: 'Balayage', variations: [{ id: 'V-BAL', version: 3, item_variation_data: { name: 'Balayage', service_duration: 10800000 } }] } }] : [] });
  if (path.startsWith('/v2/bookings/team-member-booking-profiles')) return J({ team_member_booking_profiles: [{ team_member_id: 'TM-ANA', display_name: 'Ana Ruiz', is_bookable: true }, { team_member_id: 'TM-BO', display_name: 'Bo Lee', is_bookable: true }] });
  if (path === '/v2/bookings/availability/search') {
    const f = body.query.filter; const tm = f.segment_filters[0].team_member_id_filter?.any?.[0] || 'TM-ANA';
    const from = Date.parse(f.start_at_range.start_at), to = Date.parse(f.start_at_range.end_at);
    const d0 = new Date(from).toLocaleDateString('en-CA', { timeZone: TZ });
    const list = d0 === day ? S.open.map((h) => at(h)) : [at('11:00', d0)];
    return J({ availabilities: list.filter((t) => Date.parse(t) >= from && Date.parse(t) < to).map((t) => ({ start_at: t, location_id: 'L1', appointment_segments: [{ team_member_id: tm, service_variation_id: f.segment_filters[0].service_variation_id, duration_minutes: 60 }] })) });
  }
  if (path === '/v2/customers/search') return J({ customers: S.customers.filter((c) => c.phone_number === body.query.filter.phone_number.exact) });
  if (path === '/v2/customers') { const c = { id: 'C' + (S.customers.length + 1), ...body }; S.customers.push(c); return J({ customer: c }); }
  if (path === '/v2/bookings' && init.method === 'POST') {
    if (S.taken) return J({ errors: [{ code: 'BAD_REQUEST', detail: 'The requested time slot is not available' }] }, 400);
    const b = { id: 'BK' + (S.bookings.length + 1), version: 0, status: 'ACCEPTED', ...body.booking }; S.bookings.push(b); return J({ booking: b });
  }
  const m = path.match(/^\/v2\/bookings\/(BK\d+)$/); if (m) return J({ booking: S.bookings.find((b) => b.id === m[1]) });
  return J({ errors: [{ code: 'NOT_FOUND', detail: path }] }, 404);
};
const { T } = await import('./fake-supabase.mjs');
const TID = '55555555-5555-4555-8555-555555555555';
T.tenants = [{ id: TID, name: 'MMA Salon', slug: 'mma', subscription_status: 'active', phone_number: '+13055550100', services: [] }];
T.tenant_numbers = [{ tenant_id: TID, phone_number: '+13055550100', status: 'active' }];
T.booking_settings = [{ tenant_id: TID, timezone: TZ, metadata: {} }];
for (const k of ['bookings', 'clients', 'services', 'staff', 'usage_events', 'booking_history', 'client_memories', 'call_sessions', 'opt_outs', 'deposits', 'provider_mappings', 'booking_outbox']) T[k] = [];
const { encrypt } = await import('../../api/lib/crypto.js');
T.integrations = [{ id: 'int-sq', tenant_id: TID, provider: 'square', status: 'connected', access_token: encrypt('tok-1'), refresh_token: encrypt('r-1'), metadata: { tz: TZ } }];
const P = new URL('../../api/', import.meta.url).href;
const { liveProviderFor } = await import(P + 'lib/live-booking.js');
const { SKILLS } = await import(P + 'lola-tools.js');
const tenant = T.tenants[0];

let lp = await liveProviderFor(TID);
ok(lp && lp.provider === 'square', 'a Square account that takes appointments is Lola’s live book');

let r = await SKILLS.check_availability(tenant, { service: 'haircut', date: day, time: '2pm' });
ok(r.source === 'square' && r.exact && /2 PM .*Women's Haircut/.test(r.speak), 'asked 2pm, Square has it → yes: ' + r.speak);
r = await SKILLS.check_availability(tenant, { service: 'haircut', date: day, time: '3pm' });
ok(!r.exact && /2:30 PM/.test(r.speak.replace(/ /g, ' ')), 'asked 3pm, not open in Square → the closest real times: ' + r.speak);
r = await SKILLS.check_availability(tenant, { service: 'balayage', date: day, stylist: 'Bo' });
ok(/Balayage/.test(r.speak) && / with Bo Lee/.test(r.speak), 'the stylist they ask for is the one Square checks: ' + r.speak);
r = await SKILLS.check_availability(tenant, { service: 'eyebrow threading', date: day });
ok(r.needs_service && /Women's Haircut/.test(r.speak), 'a service Square doesn’t sell → the real menu: ' + r.speak);

const tools = (await import(P + 'lola-tools.js')).default;
const { toolKey } = await import(P + 'lib/tool-key.js');
const call = (body) => new Promise((resolve) => { const res = { setHeader() {}, status() { return this; }, json: resolve, end: resolve }; tools({ method: 'POST', query: { k: toolKey(), tool: 'book_appointment', ch: 'web', salon: '+13055550100' }, headers: {}, body }, res); });
r = await call({ service: 'haircut', date: day, time: '2:30pm', client_name: 'Jerome' });
ok(r.booked === false && !S.bookings.length, 'no last name / mobile / email yet → nothing sent to Square');
r = await call({ service: 'haircut', date: day, time: '2:30pm', client_name: 'Jerome Martin', client_phone: '305-555-0199', client_email: 'jerome@example.com', stylist: 'Ana' });
ok(r.booked === true && r.verified === true && r.provider === 'square' && r.appointment_id === 'BK1', 'booked IN Square and read back to verify: ' + r.speak);
const b = S.bookings[0];
ok(b.start_at === at('14:30') && b.appointment_segments[0].service_variation_id === 'V-CUT' && b.appointment_segments[0].service_variation_version === 7 && b.appointment_segments[0].team_member_id === 'TM-ANA', 'Square gets the right time, service (current version) and stylist');
ok(S.customers.length === 1 && S.customers[0].family_name === 'Martin' && S.customers[0].email_address === 'jerome@example.com' && b.customer_id === 'C1', 'the client is created in Square with first + last name, mobile and email');
const mirror = T.bookings.find((x) => x.external_id === 'BK1');
ok(mirror && mirror.external_provider === 'square' && !T.booking_outbox.length, 'it appears in LolaDesk, linked to the Square booking — and is never pushed to Square a second time');
r = await call({ service: 'haircut', date: day, time: '3pm', client_name: 'Jerome Martin', client_phone: '305-555-0199', client_email: 'jerome@example.com' });
ok(r.booked === false && r.conflict && S.bookings.length === 1, 'a time Square doesn’t have → not booked, real alternatives: ' + r.speak);
S.taken = true;
r = await call({ service: 'haircut', date: day, time: '4pm', client_name: 'Jerome Martin', client_phone: '305-555-0199', client_email: 'jerome@example.com' });
ok(r.booked === false && r.conflict && S.bookings.length === 1, 'taken between the check and the booking → not booked, alternatives offered: ' + r.speak);
S.taken = false;

S.token = 'tok-2'; // Square expired the old token; the refresh endpoint hands out tok-2
lp = await liveProviderFor(TID);
const { liveCheck } = await import(P + 'lib/live-booking.js');
lp.integration.access_token = 'tok-old';
const chk = await liveCheck(lp, { service: 'haircut', date: day, wantAt: at('10:00'), tz: TZ });
ok(chk.ok && chk.exact && S.refreshed >= 1 && lp.integration.access_token === 'tok-2', 'an expired Square token is renewed and the request goes through');

S.services = false;
const sq = await import(P + 'lib/connectors/square.js');
ok(!(await sq.liveReady({ id: 'int-other', access_token: S.token, metadata: {} })), 'a Square account with no appointment services is not treated as a booking system (LolaDesk’s calendar stays the book)');
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
