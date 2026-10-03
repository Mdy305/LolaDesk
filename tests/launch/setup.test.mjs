// Booking SETUP drives availability: what the owner sets on Services, Team
// (service picker, weekly hours, time off) and Booking settings (salon hours,
// closures) is exactly what the availability engine offers.
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'k';
globalThis.fetch = async () => new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const { T } = await import('./fake-supabase.mjs');
const P = new URL('../../api/', import.meta.url).href;
const { getAvailability } = await import(P + 'lib/availability-engine-v2.js');

const TZ = 'America/New_York';
const TID = '00000000-0000-4000-8000-0000000000a1', OTHER = '00000000-0000-4000-8000-0000000000b2';
T.tenants = [{ id: TID, name: 'MMA Salon', slug: 'mma', subscription_status: 'active' }, { id: OTHER, name: 'Other', slug: 'other' }];
T.tenant_users = [{ user_id: 'u1', tenant_id: TID, role: 'owner', status: 'active' }, { user_id: 'u2', tenant_id: OTHER, role: 'owner', status: 'active' }];
globalThis.__authUsers = { tok: { id: 'u1', email: 'o@mma.com' }, tok2: { id: 'u2', email: 'o@other.com' } };
T.booking_settings = [{ tenant_id: TID, timezone: TZ, slot_interval_minutes: 30, minimum_notice_minutes: 0, booking_horizon_days: 90, default_buffer_before_min: 0, default_buffer_after_min: 0, allow_processing_overlap: true, metadata: { deposits: { enabled: true } } }];
T.services = []; T.staff = []; T.staff_services = []; T.staff_schedules = []; T.staff_time_off = [];
T.blocked_slots = []; T.bookings = []; T.availability_holds = []; T.clients = []; T.locations = []; T.business_hours = [];
T.cached_availability = []; T.provider_mappings = [];

const run = async (mod, req, tok = 'tok') => { const h = (await import(P + mod)).default; return new Promise((resolve) => { const res = { statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(o) { resolve({ status: this.statusCode, ...o }); }, end() { resolve({ status: this.statusCode }); } }; h({ method: 'POST', headers: { authorization: 'Bearer ' + tok }, query: {}, body: {}, ...req }, res); }); };

// Dates in salon time: the next Sunday and the next Monday, ≥ 2 days out.
const DAY = 864e5;
const keyAt = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: TZ });
const dow = (key) => new Date(key + 'T12:00:00Z').getUTCDay();
let sunday = null, monday = null, tuesday = null;
for (let i = 2; i < 12; i++) { const k = keyAt(Date.now() + i * DAY); if (dow(k) === 0 && !sunday) sunday = k; if (dow(k) === 1 && !monday) monday = k; if (dow(k) === 2 && !tuesday) tuesday = k; }
const at = (day, hhmm) => { const d = new Date(`${day}T${hhmm}:00Z`); const off = (new Date(d.toLocaleString('en-US', { timeZone: 'UTC' })) - new Date(d.toLocaleString('en-US', { timeZone: TZ }))); return new Date(d.getTime() + off).toISOString(); };
const localHHMM = (iso) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });

// ── 1. services: create, edit doesn't duplicate, duration_minutes saved ──
let r = await run('services.js', { body: { name: 'Cut', duration_minutes: 45, price: 80, category: 'Hair' } });
ok(r.ok && r.service.duration_minutes === 45 && r.service.is_active === true, 'service created with duration_minutes 45');
const cutId = r.service.id;
r = await run('services.js', { body: { id: cutId, name: 'Cut & Style', duration_minutes: 60, price: 90 } });
ok(r.ok && T.services.filter(s => s.tenant_id === TID).length === 1, 'editing (POST with id) updates — no duplicate');
ok(T.services[0].name === 'Cut & Style' && T.services[0].duration_minutes === 60 && T.services[0].price === 90, 'edit saved name, duration_minutes, price');
r = await run('services.js', { body: { name: 'Trim', duration_min: 30 } });
ok(r.ok && r.service.duration_minutes === 30, 'legacy duration_min alias still works');
const trimId = r.service.id;
r = await run('services.js', { body: { id: cutId, name: 'Hijack' } }, 'tok2');
ok(r.status === 404 && T.services.find(s => s.id === cutId).name === 'Cut & Style', "another salon can't edit this service");

// processing time + add-on + per-service buffer
r = await run('services.js', { body: { name: 'Color', category: 'Color', active_duration_1_min: 30, processing_duration_min: 45, active_duration_2_min: 15, buffer_after_min: 15, is_addon: false, price: 150 } });
const colorId = r.service.id;
ok(r.ok && r.service.processing_duration_min === 45 && r.service.active_duration_1_min === 30 && r.service.active_duration_2_min === 15 && r.service.duration_minutes === 90 && r.service.buffer_after_min === 15, 'processing time saved (30/45/15 → 90 min total) with buffer after 15');
r = await run('services.js', { body: { name: 'Gloss add-on', is_addon: true, duration_minutes: 15 } });
ok(r.ok && r.service.is_addon === true, 'add-on flag saved');

// ── 2. team: picker → staff_services, hours → staff_schedules ──
const MON_SAT = [1, 2, 3, 4, 5, 6].map(d => ({ day_of_week: d, start_time: '09:00', end_time: '17:00' }));
r = await run('staff.js', { body: { first_name: 'Ana', name: 'Ana', color: '#5ac8fa', phone: '+13055551111', email: 'ana@mma.com', active: true, services: [cutId], hours: MON_SAT } });
ok(r.ok && r.staff.is_active === true && r.staff.color === '#5ac8fa' && r.staff.phone === '+13055551111', 'stylist saved with is_active, color, phone');
const ana = r.staff.id;
ok(T.staff_services.some(l => l.staff_id === ana && l.service_id === cutId && l.tenant_id === TID), 'service picker wrote staff_services (tenant_id, staff_id, service_id)');
ok(T.staff_schedules.filter(x => x.staff_id === ana).length === 6, 'weekly hours wrote 6 staff_schedules rows (Sunday off)');
r = await run('staff.js', { body: { name: 'Bo', services: [], hours: [0, 1, 2, 3, 4, 5, 6].map(d => ({ day_of_week: d, start_time: '09:00', end_time: '17:00' })) } });
const bo = r.staff.id;
r = await run('staff.js', { body: { name: 'Cy', services: [{ service_id: colorId, custom_price: 175, custom_duration_minutes: 100 }, 'not-our-service'], hours: MON_SAT } });
const cy = r.staff.id;
ok(T.staff_services.filter(l => l.staff_id === cy).length === 1 && T.staff_services.find(l => l.staff_id === cy).custom_price === 175, 'per-stylist custom price saved; foreign service ids ignored');

let av = await getAvailability({ tenantId: TID, serviceId: cutId, date: monday, limit: 500 });
let who = new Set(av.slots.map(s => s.staff_id));
ok(who.has(ana) && who.has(bo) && !who.has(cy), `Cut: Ana (picked it) + Bo (does everything), not Cy (${[...who]})`);
av = await getAvailability({ tenantId: TID, serviceId: colorId, date: monday, limit: 500 });
who = new Set(av.slots.map(s => s.staff_id));
ok(who.has(cy) && who.has(bo) && !who.has(ana), 'Color: Cy (picked it) + Bo, never Ana (she only does Cut)');
ok(av.slots.find(s => s.staff_id === cy).price === 175 && av.slots.find(s => s.staff_id === bo).price === 150, 'Cy\'s custom price used for Color; Bo gets the menu price');
av = await getAvailability({ tenantId: TID, serviceId: trimId, date: monday, limit: 500 });
who = new Set(av.slots.map(s => s.staff_id));
ok(who.size === 1 && who.has(bo), 'Trim (nobody picked it): only Bo — Ana and Cy only do what they picked');
// once Bo picks too, a service is offered ONLY by the stylists who picked it
await run('staff.js', { body: { id: bo, name: 'Bo', services: [trimId] } });
av = await getAvailability({ tenantId: TID, serviceId: colorId, date: monday, limit: 500 });
who = new Set(av.slots.map(s => s.staff_id));
ok(who.size === 1 && who.has(cy), 'Color: only Cy once everyone has picks');
av = await getAvailability({ tenantId: TID, serviceId: cutId, date: monday, limit: 500 });
who = new Set(av.slots.map(s => s.staff_id));
ok(who.size === 1 && who.has(ana), 'Cut: only Ana');
await run('staff.js', { body: { id: bo, name: 'Bo', services: [] } });

// ── 3. weekly hours drive availability ──
av = await getAvailability({ tenantId: TID, serviceId: cutId, date: sunday, limit: 500 });
ok(av.ok && !av.slots.some(s => s.staff_id === ana), 'Ana is off Sunday → no Sunday slots for her');
r = await run('staff-hours.js', { body: { staff_id: bo, hours: [{ day_of_week: 1, start_time: '12:00', end_time: '15:00' }] } });
ok(r.ok && r.hours.length === 1, 'staff-hours replaced Bo\'s week');
av = await getAvailability({ tenantId: TID, serviceId: cutId, date: sunday, limit: 500 });
ok(av.slots.length === 0, 'nobody works Sunday now → no Sunday slots');
av = await getAvailability({ tenantId: TID, serviceId: cutId, date: monday, staffId: bo, limit: 500 });
ok(av.slots.length && localHHMM(av.slots[0].starts_at) === '12:00' && localHHMM(av.slots.at(-1).starts_at) === '14:00', 'Bo only 12:00–15:00 on Monday');
r = await run('staff-hours.js', { body: { staff_id: bo, hours: [{ day_of_week: 1, start_time: '15:00', end_time: '12:00' }] } });
ok(r.status === 400, 'end before start is refused');
r = await run('staff-hours.js', { body: { staff_id: bo, hours: [] } });
ok(T.staff_schedules.filter(x => x.staff_id === bo).length === 1, 'all days off keeps a marker row (seeder won\'t re-open them)');
av = await getAvailability({ tenantId: TID, serviceId: cutId, date: monday, staffId: bo, limit: 500 });
ok(av.slots.length === 0, 'stylist off every day → no slots');
r = await run('staff.js', { method: 'GET' });
ok(r.ok && r.staff.find(s => s.id === bo).has_hours === false && r.staff.find(s => s.id === ana).has_hours === true, 'GET /api/staff flags who has no hours');
r = await run('staff-hours.js', { body: { staff_id: ana, hours: MON_SAT } }, 'tok2');
ok(r.status === 404, "another salon can't change Ana's hours");

// time off
r = await run('staff-hours.js', { body: { staff_id: ana, action: 'time_off', start_date: tuesday, reason: 'Vacation' } });
ok(r.ok && r.time_off.id && T.staff_time_off.length === 1 && T.staff_time_off[0].starts_at === at(tuesday, '00:00'), 'time off saved as salon-local whole day');
av = await getAvailability({ tenantId: TID, serviceId: cutId, date: tuesday, staffId: ana, limit: 500 });
ok(av.slots.length === 0, 'Ana on time off Tuesday → no slots');
r = await run('staff-hours.js', { method: 'DELETE', query: { time_off_id: T.staff_time_off[0].id } });
av = await getAvailability({ tenantId: TID, serviceId: cutId, date: tuesday, staffId: ana, limit: 500 });
ok(r.ok && av.slots.length > 0, 'removing time off reopens her day');

// ── 4. deactivate + reactivate, delete hides service ──
await run('staff.js', { method: 'DELETE', query: { id: cy } });
r = await run('staff.js', { method: 'GET' });
const cyRow = r.staff.find(s => s.id === cy);
ok(cyRow && cyRow.is_active === false && cyRow.active === false, 'inactive stylist still listed, flagged inactive');
av = await getAvailability({ tenantId: TID, serviceId: colorId, date: monday, limit: 500 });
ok(av.slots.length === 0, 'inactive stylist offers nothing');
r = await run('staff.js', { body: { id: cy, name: 'Cy', is_active: true } });
ok(r.ok && T.staff.find(s => s.id === cy).is_active === true, 'stylist re-activated');
ok(T.staff_services.some(l => l.staff_id === cy), 'save without services[] keeps their picks');

r = await run('services.js', { method: 'DELETE', query: { id: trimId } });
ok(r.ok && T.services.find(s => s.id === trimId).is_active === false, 'delete sets is_active=false');
av = await getAvailability({ tenantId: TID, serviceId: trimId, date: monday, limit: 500 });
ok(!av.ok && av.slots.length === 0, 'deleted service is gone from availability');

// ── 5. processing time used ──
av = await getAvailability({ tenantId: TID, serviceId: colorId, date: monday, staffId: cy, limit: 500 });
const s0 = av.slots[0];
ok(s0 && s0.processing_minutes === 45 && s0.duration_minutes === 90 && Date.parse(s0.ends_at) - Date.parse(s0.starts_at) === 90 * 60e3, 'Color slot is 30 + 45 processing + 15 = 90 min');
// a Cut can sit inside Cy's processing gap
await run('staff.js', { body: { id: cy, name: 'Cy', services: [colorId, cutId], hours: MON_SAT } });
T.bookings.push({ id: 'bk1', tenant_id: TID, staff_id: cy, service_id: colorId, start_time: at(monday, '10:00'), end_time: at(monday, '11:30'), status: 'confirmed' });
// Cut is 60 min — too long for the 45-min gap; make a 30-min service
r = await run('services.js', { body: { name: 'Blowout', duration_minutes: 30, buffer_after_min: 0 } });
await run('staff.js', { body: { id: cy, name: 'Cy', services: [colorId, cutId, r.service.id], hours: MON_SAT } });
av = await getAvailability({ tenantId: TID, serviceId: r.service.id, date: monday, staffId: cy, limit: 500 });
ok(av.slots.some(s => s.starts_at === at(monday, '10:30')), 'processing gap is bookable (10:30 blowout during 10:00 color)');
// per-service buffer after: Color has 15 min → no Color may start so its buffer runs past 17:00
av = await getAvailability({ tenantId: TID, serviceId: colorId, date: monday, staffId: cy, limit: 500 });
const last = av.slots.at(-1);
ok(last && localHHMM(last.starts_at) === '15:00', `per-service 15-min buffer: last Color starts 15:00 (90+15 ≤ 17:00), got ${last && localHHMM(last.starts_at)}`);
T.bookings = [];

// ── 6. salon hours + closures ──
r = await run('booking-settings.js', { method: 'GET' });
ok(r.ok && r.settings.timezone === TZ, 'settings load');
const bh = { mon: { open: '10:00', close: '16:00', closed: false }, tue: { open: '10:00', close: '20:00', closed: false }, wed: { open: '10:00', close: '20:00', closed: false }, thu: { open: '10:00', close: '20:00', closed: false }, fri: { open: '10:00', close: '20:00', closed: false }, sat: { open: '10:00', close: '20:00', closed: true }, sun: { open: '10:00', close: '20:00', closed: true } };
r = await run('booking-settings.js', { body: { business_hours: bh, closures: [tuesday, 'junk'], reminder_lead_hours: 48, rebook_followup_days: 35, timezone: TZ } });
const row = T.booking_settings[0];
ok(r.ok && row.business_hours.mon.close === '16:00' && row.closures.length === 1 && row.reminder_lead_hours === 48 && row.rebook_followup_days === 35, 'business_hours, closures, reminder_lead_hours, rebook_followup_days persisted');
ok(row.metadata.deposits && row.metadata.deposits.enabled === true && row.metadata.hours_confirmed_at, 'metadata merged (deposits kept) + hours confirmed');
r = await run('booking-settings.js', { method: 'GET' });
ok(r.settings.business_hours.mon.close === '16:00' && r.settings.closures[0] === tuesday, 'GET returns the saved hours');

av = await getAvailability({ tenantId: TID, serviceId: cutId, date: monday, staffId: ana, limit: 500 });
ok(av.slots.length && localHHMM(av.slots[0].starts_at) === '10:00' && localHHMM(av.slots.at(-1).starts_at) === '15:00', `stylist 9–17 clamped to salon 10–16 (${av.slots.length && localHHMM(av.slots[0].starts_at)}–${av.slots.length && localHHMM(av.slots.at(-1).starts_at)})`);
av = await getAvailability({ tenantId: TID, serviceId: cutId, date: tuesday, limit: 500 });
ok(av.ok && av.slots.length === 0 && av.closed === 'closure', 'closure date → no slots');
T.booking_settings[0].closures = [];
av = await getAvailability({ tenantId: TID, serviceId: cutId, date: tuesday, limit: 500 });
ok(av.slots.length > 0, 'without the closure Tuesday is open again');
const sat = keyAt(Date.parse(monday + 'T12:00:00Z') + 5 * DAY);
av = await getAvailability({ tenantId: TID, serviceId: cutId, date: sat, limit: 500 });
ok(av.slots.length === 0 && av.closed === 'business_hours', 'salon closed Saturday → no Saturday slots even though stylists work');

// untouched schema-default hours are not enforced until the owner saves them
T.booking_settings[0].metadata = {};
T.booking_settings[0].business_hours = { mon: { open: '10:00', close: '20:00', closed: false }, tue: { open: '10:00', close: '20:00', closed: false }, wed: { open: '10:00', close: '20:00', closed: false }, thu: { open: '10:00', close: '20:00', closed: false }, fri: { open: '10:00', close: '20:00', closed: false }, sat: { open: '10:00', close: '20:00', closed: false }, sun: { open: '10:00', close: '20:00', closed: true } };
av = await getAvailability({ tenantId: TID, serviceId: cutId, date: monday, staffId: ana, limit: 500 });
ok(localHHMM(av.slots[0].starts_at) === '09:00', 'never-saved default hours do not clamp (9:00 still offered)');

// bad hours refused
r = await run('booking-settings.js', { body: { business_hours: { mon: { open: '18:00', close: '09:00', closed: false } } } });
ok(r.status === 400, 'closing before opening is refused');

// metadata fallback when the columns are missing
const { flattenSettings } = await import(P + 'booking-settings.js');
const flat = flattenSettings({ metadata: { business_hours: { mon: { open: '11:00', close: '12:00' } }, closures: ['2030-01-01'] } });
ok(flat.business_hours.mon.open === '11:00' && flat.closures[0] === '2030-01-01', 'metadata fallback flattens for the page');

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
