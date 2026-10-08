// LolaDesk's own booking system: a salon with NO booking software goes live in
// minutes. Readiness lists what's missing, each step is doable in one place,
// gaps are filled only where data is missing, and every answer is per salon.
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'k';
process.env.APP_URL = 'https://www.loladesk.com';
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
globalThis.fetch = async () => new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
const fs = await import('node:fs');
const R = (f) => fs.readFileSync(new URL('../../' + f, import.meta.url), 'utf8');
const { T } = await import('./fake-supabase.mjs');
const P = new URL('../../api/', import.meta.url).href;
const { resetRateLimits } = await import(P + 'lib/public-rate-limit.js');
const { ensureBookingBaseline, PLACEHOLDER_STAFF } = await import(P + 'lib/booking-seed.js');
const { readinessFrom } = await import(P + 'lib/booking-readiness.js');

const SOLO = '00000000-0000-4000-8000-0000000b0001', GLOW = '00000000-0000-4000-8000-0000000b0002', TZ = 'America/New_York';
T.tenants = [
  { id: SOLO, name: 'Solo Studio', slug: 'solo', subscription_status: 'active', phone_number: '+13055550111' },
  { id: GLOW, name: 'Glow Spa', slug: 'glow', subscription_status: 'active', phone_number: '+13055550222' },
];
T.tenant_users = [{ user_id: 'u1', tenant_id: SOLO, role: 'owner', status: 'active' }, { user_id: 'u2', tenant_id: GLOW, role: 'owner', status: 'active' }];
globalThis.__authUsers = { tok: { id: 'u1', email: 'o@solo.com' }, tok2: { id: 'u2', email: 'o@glow.com' } };
for (const k of ['booking_settings', 'services', 'staff', 'staff_schedules', 'staff_services', 'staff_time_off', 'blocked_slots', 'bookings',
  'availability_holds', 'cached_availability', 'provider_mappings', 'integrations', 'clients', 'usage_events', 'booking_services', 'platform_settings']) T[k] = [];
// Glow already runs its book in LolaDesk: its stylist must never show up in Solo's answers.
T.booking_settings.push({ tenant_id: GLOW, timezone: TZ, metadata: { hours_confirmed_at: '2026-01-01T00:00:00Z' },
  business_hours: { mon: { open: '09:00', close: '17:00', closed: false } }, public_booking_enabled: true });
T.services.push({ id: 'g-facial', tenant_id: GLOW, name: 'Facial', duration_minutes: 60, price: 120, is_active: true });
T.staff.push({ id: 'g-mia', tenant_id: GLOW, name: 'Mia Glow', is_active: true });
T.staff_schedules.push({ tenant_id: GLOW, staff_id: 'g-mia', day_of_week: 1, start_time: '09:00', end_time: '17:00' });

const run = async (mod, req) => {
  const h = (await import(P + mod)).default;
  return new Promise((resolve) => {
    const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(o) { resolve({ status: this.statusCode, ...o }); return this; }, end(t) { resolve({ status: this.statusCode, text: t }); return this; } };
    h({ method: 'GET', headers: {}, query: {}, ...req }, res);
  });
};
const auth = (t = 'tok') => ({ authorization: 'Bearer ' + t });
const ready = (t = 'tok', query = {}) => run('booking-settings.js', { headers: auth(t), query: { action: 'readiness', ...query } });
const step = (r, id) => (r.steps || []).find((s) => s.id === id) || {};
const todo = (r) => (r.steps || []).filter((s) => !s.done).map((s) => s.id).join(',');
// Salon-local date N days out that falls on weekday `dow` (0=Sun).
const dayOn = (dow) => { for (let i = 2; i < 12; i++) { const d = new Date(Date.now() + i * 864e5); const key = d.toLocaleDateString('en-CA', { timeZone: TZ }); if (new Date(key + 'T12:00:00Z').getUTCDay() === dow) return key; } };
const localHM = (iso) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const avail = (service_id, date, tenant = 'solo') => { resetRateLimits(); return run('public-booking.js', { method: 'POST', body: { action: 'availability', tenant, service_id, date } }); };

// ── 1. Auth ──
let r = await run('booking-settings.js', { query: { action: 'readiness' } });
ok(r.status === 401 && !r.steps, 'no sign-in → 401, nothing about any salon');

// ── 2. A brand-new salon with nothing connected ──
r = await ready();
ok(r.ok && r.ready === false && Array.isArray(r.steps) && r.steps.length === 5, 'an empty salon is not ready, with five steps');
ok(todo(r) === 'hours,services,staff,staff_hours', 'it lists exactly what is missing: hours, services, team, team hours (online booking is on by default)');
ok(r.steps.every((s) => s.label && /^\/(booking-settings|services|team|settings#booking)$/.test(s.href)), 'every step has a plain label and one page that fixes it');
ok(r.booking_url === 'https://www.loladesk.com/book?t=solo', 'its booking link is already known: ' + r.booking_url);
ok(T.booking_settings.some((s) => s.tenant_id === SOLO), 'booking_settings defaults now exist (ensureBookingBaseline)');
ok(T.staff.some((s) => s.tenant_id === SOLO && s.name === PLACEHOLDER_STAFF && s.is_active !== false), 'the day-one stand-in exists so Lola can book — but it does not count as a team');
ok(step(r, 'services').done === false && T.services.some((s) => s.tenant_id === SOLO && s.name === 'Consultation'), 'a $0 placeholder Consultation does not count as a priced service');

// ── 3. Hours → service → team, each in one place ──
const OPEN = { open: '10:00', close: '19:00', closed: false }, SHUT = { open: '10:00', close: '19:00', closed: true };
r = await run('booking-settings.js', { method: 'POST', headers: auth(), body: { tenant_id: GLOW, business_hours: { sun: SHUT, mon: SHUT, tue: OPEN, wed: OPEN, thu: OPEN, fri: OPEN, sat: OPEN } } });
ok(r.ok && !T.booking_settings.find((s) => s.tenant_id === GLOW).business_hours.tue, 'hours save to the signed-in salon (a tenant_id in the body is ignored)');
r = await ready();
ok(step(r, 'hours').done && todo(r) === 'services,staff,staff_hours', 'opening hours → that step is done');

r = await run('services.js', { method: 'POST', headers: auth(), body: { name: 'Haircut', duration_minutes: 60, price: 85 } });
const CUT = r.service?.id || T.services.find((s) => s.tenant_id === SOLO && s.name === 'Haircut')?.id;
ok(CUT, 'a service is added on Services');
r = await ready();
ok(step(r, 'services').done && /1 bookable/.test(step(r, 'services').detail), 'a service with a length and price → done');

r = await run('staff.js', { method: 'POST', headers: auth(), body: { name: 'Ana Lopez', services: [CUT] } });
const ANA = r.staff?.id;
const anaWeek = T.staff_schedules.filter((x) => x.staff_id === ANA).sort((a, b) => a.day_of_week - b.day_of_week);
ok(ANA && anaWeek.map((x) => x.day_of_week).join() === '2,3,4,5,6' && anaWeek.every((x) => String(x.start_time).startsWith('10:00') && String(x.end_time).startsWith('19:00')),
  'a stylist saved without hours gets the salon’s opening hours (Tue–Sat 10–7), not a made-up week');
r = await ready();
ok(r.ready === true && todo(r) === '' && r.booking_url === 'https://www.loladesk.com/book?t=solo', 'hours + service + stylist → ready, with the booking link');
ok(T.staff.find((s) => s.tenant_id === SOLO && s.name === PLACEHOLDER_STAFF)?.is_active === false, 'the stand-in stepped aside once a real stylist has hours');

// ── 4. The public page offers real times ──
const TUE = dayOn(2), MON = dayOn(1);
r = await avail(CUT, TUE);
ok(r.ok && r.slots.length > 0, `the public booking page offers real times on ${TUE}: ${r.slots?.length}`);
ok(r.slots.every((s) => s.staff_id === ANA) && r.slots.every((s) => localHM(s.starts_at) >= '10:00' && localHM(s.ends_at) <= '19:00'), '…all with Ana, inside opening hours');
r = await avail(CUT, MON);
ok(r.ok && r.slots.length === 0, 'a closed day (Monday) offers nothing');

// ── 5. A service nobody picked is still bookable (one stylist / "any available") ──
r = await run('services.js', { method: 'POST', headers: auth(), body: { name: 'Gloss', duration_minutes: 30, price: 40 } });
const GLOSS = r.service?.id || T.services.find((s) => s.tenant_id === SOLO && s.name === 'Gloss')?.id;
r = await avail(GLOSS, TUE);
ok(r.ok && r.slots.length > 0 && r.slots.every((s) => s.staff_id === ANA), 'Ana only picked Haircut, but as the only stylist she is offered for Gloss');
r = await run('staff.js', { method: 'POST', headers: auth(), body: { name: 'Ben Cruz', services: [CUT], hours: [{ day_of_week: 3, start_time: '12:00', end_time: '18:00' }] } });
const BEN = r.staff?.id;
await run('booking-settings.js', { method: 'POST', headers: auth(), body: { allow_any_staff: false } });
r = await ready();
ok(r.ready === false && step(r, 'staff_hours').done === false && /Nobody takes Gloss/.test(step(r, 'staff_hours').detail), 'two specialists, "any available" off → readiness says nobody takes Gloss');
r = await avail(GLOSS, TUE);
ok(r.ok && r.slots.length === 0, '…and the engine agrees (no times)');
await run('booking-settings.js', { method: 'POST', headers: auth(), body: { allow_any_staff: true } });
r = await ready();
ok(r.ready === true, '"any available" on → the team takes the unpicked service, ready again');

// ── 6. Defaults never overwrite what the owner set ──
const benBefore = JSON.stringify(T.staff_schedules.filter((x) => x.staff_id === BEN));
await run('staff.js', { method: 'POST', headers: auth(), body: { id: BEN, name: 'Ben Cruz', role: 'Colorist' } });
await ensureBookingBaseline(SOLO);
ok(JSON.stringify(T.staff_schedules.filter((x) => x.staff_id === BEN)) === benBefore, 'Ben’s Wednesday-only hours survive a save without hours and the baseline');
r = await run('staff.js', { method: 'POST', headers: auth(), body: { name: 'Cleo Off', hours: [] } });
const CLEO = r.staff?.id;
await ensureBookingBaseline(SOLO);
const cleo = T.staff_schedules.filter((x) => x.staff_id === CLEO);
ok(cleo.length === 1 && String(cleo[0].end_time).startsWith('00:00'), 'a stylist the owner set off every day stays off (no default week)');
r = await ready();
ok(r.ready === false && /Cleo has no weekly hours/.test(step(r, 'staff_hours').detail), '…and readiness names her: "Cleo has no weekly hours"');
await run('staff.js', { method: 'DELETE', headers: auth(), query: { id: CLEO } });
const bh = JSON.stringify(T.booking_settings.find((s) => s.tenant_id === SOLO).business_hours);
await run('booking-settings.js', { method: 'POST', headers: auth(), body: { public_booking_enabled: false } });
await ensureBookingBaseline(SOLO); r = await ready();
const mine = T.booking_settings.find((s) => s.tenant_id === SOLO);
ok(mine.public_booking_enabled === false && JSON.stringify(mine.business_hours) === bh && todo(r) === 'online', 'online booking off stays off, hours untouched — readiness shows the one step left');
await run('booking-settings.js', { method: 'POST', headers: auth(), body: { public_booking_enabled: true } });
r = await ready();
ok(r.ready === true, 'switch it back on → ready');
const DEF = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: '10:00', close: '20:00', closed: d === 'sun' }]));
const pure = readinessFrom({ tenant: { id: SOLO, slug: 'solo' }, settings: { business_hours: DEF }, services: [], staff: [], schedules: [], links: [] });
ok(pure.steps[0].done === false, 'the schema’s untouched default hours (10–8, never saved) don’t count…');
const pure2 = readinessFrom({ tenant: { id: SOLO, slug: 'solo' }, settings: { business_hours: DEF, metadata: { hours_confirmed_at: 'x' } }, services: [], staff: [], schedules: [], links: [] });
ok(pure2.steps[0].done === true, '…the same hours, saved by the owner, do');

// ── 7. Another salon never sees Solo (and vice versa) ──
r = await ready('tok2', { tenant_id: SOLO, tenant: 'solo' });
ok(r.ok && r.booking_url === 'https://www.loladesk.com/book?t=glow', 'Glow’s owner gets Glow’s page even when asking for Solo');
ok(!JSON.stringify(r).match(/Ana|Ben|Haircut|Gloss|solo/i), 'nothing of Solo’s (staff, services, link) appears in Glow’s answer');
ok(T.staff.find((s) => s.id === 'g-mia').is_active === true && T.staff_schedules.filter((x) => x.staff_id === 'g-mia').length === 1, 'Solo’s setup never touched Glow’s stylist or her hours');

// ── 8. Nothing connected → Lola uses LolaDesk's own engine ──
const { liveProviderFor } = await import(P + 'lib/live-booking.js');
ok(await liveProviderFor(SOLO) === null, 'no booking system connected → liveProviderFor is null (Lola books in LolaDesk)');
T.integrations.push({ id: 'i1', tenant_id: SOLO, provider: 'boulevard', status: 'disconnected', metadata: {} });
ok(await liveProviderFor(SOLO) === null, 'a disconnected integration still falls back to LolaDesk');

// ── 9. The card ──
const js = R('booking-ready.js');
ok(/action=readiness/.test(js) && /data-mode/.test(js) && /Copy/.test(js) && /Open/.test(js) && !/#[0-9a-f]{6}\b/i.test(js.split('textContent = `')[1] || ''), 'booking-ready.js reads readiness, shows Copy + Open, uses theme tokens only');
ok(/data-booking-ready data-mode="setup"/.test(R('dashboard.html')) && /booking-ready\.js/.test(R('dashboard.html')), 'dashboard shows the card only while not ready');
ok(/data-booking-ready/.test(R('settings.html')) && /booking-ready\.js/.test(R('settings.html')), 'settings → Booking shows it always');

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
