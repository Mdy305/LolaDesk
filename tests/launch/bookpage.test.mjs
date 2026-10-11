// The client booking page: the salon's own link (/b/<slug>), its look (logo or
// monogram, accent, a real Google rating), stylist/service photos, "Next: Tue
// 2:30 PM" from ONE next_open call, and the hold that brings its add-ons along.
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'k';
process.env.STRIPE_SECRET_KEY = 'sk_test_x';
import fs from 'node:fs';
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
globalThis.fetch = async () => new Response(JSON.stringify({ data: { id: 'x' } }), { status: 200, headers: { 'content-type': 'application/json' } });
const { T } = await import('./fake-supabase.mjs');
const P = new URL('../../api/', import.meta.url).href;
const R = (f) => fs.readFileSync(new URL('../../' + f, import.meta.url), 'utf8');
const { resetRateLimits } = await import(P + 'lib/public-rate-limit.js');
const pub = (await import(P + 'public-booking.js')).default;
const TID = '55555555-5555-4555-8555-555555555555', TZ = 'America/New_York', DAY = 864e5;
const key = (n) => new Date(Date.now() + n * DAY).toLocaleDateString('en-CA', { timeZone: TZ });
const atOn = (d, hhmm) => { const x = new Date(`${d}T${hhmm}:00Z`); const off = (new Date(x.toLocaleString('en-US', { timeZone: 'UTC' })) - new Date(x.toLocaleString('en-US', { timeZone: TZ }))); return new Date(x.getTime() + off).toISOString(); };
const call = (handler, { method = 'POST', query = {}, body = {}, headers = {} }) => new Promise((resolve) => {
  const res = { statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(o) { resolve({ status: this.statusCode, ...o }); return this; }, end() { resolve({ status: this.statusCode }); return this; } };
  handler({ method, query, body, headers }, res);
});
const W = (action, extra = {}) => call(pub, { body: { action, tenant: 'glow', ...extra } });
const G = (action, extra = {}) => call(pub, { method: 'GET', query: { action, tenant: 'glow', ...extra } });
const D0 = key(0), D1 = key(1), D2 = key(2), D3 = key(3);
const reset = (settings = {}, tenant = {}) => {
  resetRateLimits();
  T.tenants = [{ id: TID, name: 'Glow Studio', slug: 'glow', subscription_status: 'active', phone_number: '+13055550111', location: 'Miami Beach', ...tenant }];
  // Closed today and tomorrow — the page must land on the day after, not "today".
  T.booking_settings = [{ tenant_id: TID, timezone: TZ, slot_interval_minutes: 30, minimum_notice_minutes: 0, booking_horizon_days: 90, default_buffer_before_min: 0, default_buffer_after_min: 0, allow_processing_overlap: true, metadata: { closures: [D0, D1] }, ...settings }];
  T.services = [
    { id: 'cut', tenant_id: TID, name: 'Cut', category: 'Hair', duration_minutes: 45, price: 80, is_active: true, photo_url: 'https://cdn.example.com/cut.jpg' },
    { id: 'gloss', tenant_id: TID, name: 'Gloss', category: 'Add-ons', duration_minutes: 30, price: 45, is_active: true, photo_url: 'javascript:alert(1)' },
  ];
  T.staff = [
    { id: 'ana', tenant_id: TID, name: 'Ana Ruiz', role: 'Colorist', is_active: true, photo_url: 'https://cdn.example.com/ana.jpg', bio: 'Lived-in blondes and glossy brunettes. Ten years behind the chair in Miami.', phone: '+13055550000', email: 'ana@x.com' },
    { id: 'bo', tenant_id: TID, name: 'Bo Lee', role: 'Stylist', is_active: true },
  ];
  T.staff_services = []; T.staff_schedules = [];
  for (const s of ['ana', 'bo']) for (let d = 0; d < 7; d++) T.staff_schedules.push({ tenant_id: TID, staff_id: s, day_of_week: d, start_time: '09:00', end_time: '17:00' });
  T.staff_time_off = []; T.blocked_slots = []; T.bookings = []; T.availability_holds = []; T.clients = []; T.locations = []; T.business_hours = [];
  T.cached_availability = []; T.provider_mappings = []; T.booking_outbox = []; T.integrations = []; T.client_memories = []; T.usage_events = [];
  T.deposits = []; T.tenant_channels = []; T.opt_outs = []; T.booking_services = []; T.booking_status_history = []; T.platform_settings = [];
  globalThis.__missing = null;
};

// ── 1. Catalog: photos, bio, branding, rating — and nothing private ──
reset({}, { branding: { logo_url: 'https://cdn.example.com/glow-logo.png' }, business_profile: { gmb_avg_rating: 4.86, gmb_review_count: 212 } });
T.booking_settings[0].metadata.branding = { accent: '#8A5A44' };
let r = await G('catalog');
const cut = r.services?.find((s) => s.id === 'cut'), gloss = r.services?.find((s) => s.id === 'gloss');
const ana = r.staff?.find((s) => s.id === 'ana'), bo = r.staff?.find((s) => s.id === 'bo');
ok(r.ok && cut?.photo_url === 'https://cdn.example.com/cut.jpg' && gloss && gloss.photo_url === null, 'services carry photo_url (https only — a javascript: URL never reaches the page)');
ok(ana?.photo_url === 'https://cdn.example.com/ana.jpg' && /Lived-in blondes/.test(ana.bio) && ana.role === 'Colorist' && bo?.photo_url === null && bo.bio === '', 'stylists carry photo_url + short bio');
ok(!('phone' in ana) && !('email' in ana), 'stylists’ phones and emails stay private');
ok(r.salon?.logo_url === 'https://cdn.example.com/glow-logo.png' && r.salon.accent === '#8A5A44' && r.salon.slug === 'glow', 'salon branding: logo + accent from what the salon stored');
ok(r.salon?.rating?.value === 4.9 && r.salon.rating.count === 212 && r.salon.rating.source === 'Google', 'the Google rating read at onboarding is shown (4.9 · 212 reviews)');
reset();
r = await G('catalog');
ok(r.ok && r.salon.logo_url === null && r.salon.accent === null && r.salon.rating === null, 'nothing stored → no logo, no accent, and never an invented rating');
reset({}, { business_profile: { gmb_avg_rating: 4.7, gmb_review_count: 0 }, brand_color: 'red' });
r = await G('catalog');
ok(r.salon.rating === null && r.salon.accent === null, 'zero reviews → no rating; a non-hex color is ignored');

// ── 2. next_open: earliest per stylist, closed days skipped ──
reset();
T.bookings.push({ id: 'b1', tenant_id: TID, staff_id: 'bo', service_id: 'cut', start_time: atOn(D2, '09:00'), end_time: atOn(D2, '10:00'), status: 'confirmed' });
T.staff_time_off.push({ tenant_id: TID, staff_id: 'ana', start_time: atOn(D2, '00:00'), end_time: atOn(D3, '00:00') });
r = await W('next_open', { service_id: 'cut' });
const sa = r.staff?.find((s) => s.staff_id === 'ana'), sb = r.staff?.find((s) => s.staff_id === 'bo');
ok(r.ok && r.days?.length === 14 && r.days[0].date === D0 && !r.days[0].open && !r.days[1].open && r.days[2].open, 'closed today + tomorrow are marked closed; the day after is open');
ok(r.earliest?.date === D2 && r.earliest.starts_at === atOn(D2, '10:00') && r.earliest.staff_id === 'bo', 'earliest overall: ' + r.earliest?.starts_at + ' (Bo, after his 9–10 booking)');
ok(sb?.starts_at === atOn(D2, '10:00') && sa?.starts_at === atOn(D3, '09:00') && sa.date === D3, 'per stylist: Bo ' + sb?.starts_at + ', Ana (off that day) ' + sa?.starts_at);
ok(r.staff[0].staff_id === 'bo' && Array.isArray(sa.open_days) && !sa.open_days.includes(D2) && sa.open_days.includes(D3) && sb.open_days.includes(D2), 'sorted soonest first, with each stylist’s own open days');
r = await W('next_open', { service_id: 'cut', staff_id: 'ana' });
ok(r.ok && r.staff.length === 1 && r.staff[0].staff_id === 'ana' && r.earliest.date === D3, 'one stylist asked → only her times');
r = await G('next_open', { service_id: 'cut', days: '3' });
ok(r.ok && r.days.length === 3, 'GET works too, days capped by the caller');
r = await W('next_open', {});
ok(r.ok === false && r.error === 'service_id_required', 'service required');
r = await W('next_open', { service_id: 'nope' });
ok(r.ok === false && r.error === 'service_not_found', 'unknown service → service_not_found');
T.bookings = []; T.staff_time_off = [];
T.booking_settings[0].metadata.closures = Array.from({ length: 15 }, (_, i) => key(i));
r = await W('next_open', { service_id: 'cut' });
ok(r.ok && r.earliest === null && r.staff.length === 0 && r.days.every((d) => !d.open), 'salon closed for two weeks → no earliest (the page says so), never a made-up time');

// ── 3. next_open obeys the same rules gate as availability ──
reset({ public_booking_enabled: false });
r = await W('next_open', { service_id: 'cut' });
ok(r.ok === false && r.error === 'booking_disabled', 'online booking off → next_open is gated like availability');
reset({ allow_staff_choice: false });
r = await W('next_open', { service_id: 'cut', staff_id: 'ana' });
ok(r.ok && r.staff.length === 0 && r.earliest && !('staff_id' in r.earliest) && r.earliest.date === D2, 'clients can’t pick a stylist → no stylist ids leak, staff_id ignored');
reset();
T.tenants[0].subscription_status = 'canceled'; T.tenants[0].trial_ends_at = new Date(Date.now() - 30 * DAY).toISOString();
const avail = await W('availability', { service_id: 'cut', date: D2 });
r = await W('next_open', { service_id: 'cut' });
ok(avail.blocked ? (r.ok && r.blocked && r.earliest === null) : r.ok, 'billing gate: when availability shows no times, next_open shows none either');
reset();
r = await call(pub, { body: { action: 'range', tenant: 'glow' } });
ok(r.status === 405, 'the public allow-list still refuses owner actions');

// ── 4. Hold + add-ons in one answer (old addons action intact) ──
reset();
r = await W('hold', { service_id: 'cut', staff_id: 'ana', starts_at: atOn(D2, '10:00'), with_addons: true });
ok(r.ok && r.hold?.hold_token && Array.isArray(r.addons) && r.addons.length === 1 && r.addons[0].id === 'gloss' && r.addons[0].price === 45 && 'deposit_cents' in r.addons[0], 'hold with_addons returns the Gloss that fits right after');
const old = await W('addons', { hold_token: r.hold.hold_token });
ok(old.ok && old.addons.length === 1 && old.addons[0].id === 'gloss', 'the separate addons action still answers the same');
r = await W('hold', { service_id: 'cut', staff_id: 'bo', starts_at: atOn(D2, '11:00') });
ok(r.ok && r.hold && !('addons' in r), 'without the flag the hold answer is unchanged');

// ── 5. The page: /b/<slug>, branding hooks, fixes ──
const vj = JSON.parse(R('vercel.json'));
ok(vj.rewrites.some((x) => x.source === '/b/:slug' && /\/book(\.html)?$/.test(x.destination)) && vj.rewrites.some((x) => x.source === '/api/calendar.ics'), 'vercel.json rewrites /b/:slug → the booking page (existing rewrites kept)');
const bw = R('booking-widget.js'), bh = R('book.html');
ok(/\^\\\/b\\\/\(/.test(bw) && /Q\.get\('t'\)/.test(bw), 'widget reads the salon from /b/<slug> or ?t=');
ok(/property="og:title"/.test(bh) && /property="og:image"/.test(bh) && /data-page="1"/.test(bh) && /'Book · ' \+ c\.name/.test(bw), 'static OG defaults; the page title becomes "Book · <Salon>"');
ok(/'next_open'/.test(bw) && /with_addons: true/.test(bw) && /calendar\.google\.com\/calendar\/render/.test(bw), 'widget uses next_open, the combined hold, and offers Google Calendar');
ok(!/var\(--border\)/.test(bw) && !/setTimeout\([^)]*location\.href = pay/.test(bw) && /Pay ' \+ amt \+ ' deposit to confirm/.test(bw), 'no undefined --border; no surprise redirect — a clear "Pay $X deposit to confirm" button');

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
