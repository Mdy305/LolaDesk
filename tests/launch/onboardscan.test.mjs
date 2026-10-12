// Onboarding: what Lola learns from the website and Google lands where booking reads it — the opening
// hours become the booking hours (and the stylists' week), services land priced (unpriced ones are asked
// for), the salon's phone / booking link / socials are kept — and the booking checklist says so.
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'k';
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
globalThis.fetch = async () => new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
const { T } = await import('./fake-supabase.mjs');
const TID = '00000000-0000-4000-8000-0000000b0a01';
const reset = () => {
  T.tenants = [{ id: TID, name: 'MMA Salon', slug: 'mma', phone_number: '+13055550100', subscription_status: 'active', services: [], knowledge: null }];
  for (const k of ['booking_settings', 'services', 'staff', 'staff_schedules', 'staff_services', 'bookings', 'clients', 'locations', 'business_hours', 'blocked_slots', 'staff_time_off']) T[k] = [];
};
reset();
const P = new URL('../../api/', import.meta.url).href;
const { ensureBookingBaseline } = await import(P + 'lib/booking-seed.js');
await ensureBookingBaseline(TID);   // what provisioning does: starter hours, $0 Consultation, a stand-in stylist (09–19 every day)
const BL = await import(P + 'lib/business-learn.js');
const { readinessFrom, bookingReadiness } = await import(P + 'lib/booking-readiness.js');
const before = await bookingReadiness(TID);
ok(!before.steps.find((s) => s.id === 'hours').done && !before.steps.find((s) => s.id === 'services').done, 'after sign-up, hours and services are not set (what the owner saw)');

const profile = BL.cleanProfile({
  summary: 'Luxury color studio.', hours_text: 'Tue-Sat 10am-7pm', phone: '(786) 449-7058',
  business_hours: { mon: { closed: true }, tue: { open: '10:00', close: '19:00' }, wed: { open: '10:00', close: '19:00' }, thu: { open: '10:00', close: '19:00' }, fri: { open: '10:00', close: '19:00' }, sat: { open: '10:00', close: '19:00' }, sun: { closed: true } },
  services: [{ name: 'French Balayage', price: 350, duration_min: 210 }, { name: 'Haircut', price: 95, duration_min: 60 }, { name: 'Hair Botox', price: null, duration_min: 120 }],
  team: [{ name: 'Meddy', role: 'Colorist' }],
});
const google = { ok: true, place: { id: 'p1', name: 'MMA Salon', address: '1500 Alton Rd, Miami Beach, FL', phone: '+1 786-449-7058', rating: 4.9, reviews_count: 180,
  hours: ['Monday: Closed', 'Tuesday: 10:00 AM – 7:00 PM', 'Wednesday: 10:00 AM – 7:00 PM', 'Thursday: 10:00 AM – 8:00 PM', 'Friday: 10:00 AM – 7:00 PM', 'Saturday: 9:00 AM – 6:00 PM', 'Sunday: Closed'], reviews: [] }, competitors: [] };
const links = BL.siteLinks('<a href="https://www.joinblvd.com/b/mmasalon/widget">Book</a><a href="https://www.facebook.com/mmasalon">fb</a><a href="tel:+17864497058">call</a>');
const c = (await import('@supabase/supabase-js')).createClient('x', 'y');
const report = await BL.applyProfile(c, T.tenants[0], profile, { source: { website: 'https://www.mmasalon.com', google, links } });
const bs = T.booking_settings[0];
ok(report.hours && report.hours_source === 'google' && bs.business_hours.thu.close === '20:00' && bs.business_hours.sat.open === '09:00' && bs.business_hours.mon.closed && bs.metadata.hours_confirmed_at && bs.metadata.hours_source === 'google', 'Google’s hours (exact) become the booking hours — Thu till 8, Sat from 9, Mon/Sun closed');
const days = [...new Set(T.staff_schedules.map((r) => r.day_of_week))].sort();
ok(!T.staff_schedules.some((r) => r.day_of_week === 0 || r.day_of_week === 1) && T.staff_schedules.some((r) => r.day_of_week === 4 && String(r.end_time).startsWith('20:00')), 'stylists on the starter week now work the salon’s week (no Sunday/Monday; Thursday till 8): days ' + days.join(','));
const live = T.services.filter((s) => s.is_active !== false);
ok(live.some((s) => s.name === 'French Balayage' && Number(s.price) === 350) && !live.some((s) => /^consultation$/i.test(s.name)), 'the real menu replaces the $0 placeholder');
ok(report.needs_price?.length === 1 && report.needs_price[0].name === 'Hair Botox' && report.needs_price[0].id, 'the service the website doesn’t price is asked for (with its id, so the owner prices it in one tap)');
const k = JSON.parse(T.tenants[0].knowledge);
ok(k.salon_phone === '+1 786-449-7058' && /joinblvd/.test(k.booking_link) && k.booking_system === 'Boulevard' && /facebook/.test(k.socials.facebook) && T.tenants[0].phone_number === '+13055550100', 'the salon’s own phone, booking link and socials are kept — Lola’s line is never overwritten');
const after = await bookingReadiness(TID);
ok(after.steps.find((s) => s.id === 'hours').done && after.steps.find((s) => s.id === 'services').done, 'the booking checklist now shows hours and services done');

// The owner already set hours by hand → a later scan never overwrites them
const mine = { mon: { open: '11:00', close: '18:00', closed: false }, tue: { open: '11:00', close: '18:00', closed: false }, wed: { open: '11:00', close: '18:00', closed: false }, thu: { open: '11:00', close: '18:00', closed: false }, fri: { open: '11:00', close: '18:00', closed: false }, sat: { open: '11:00', close: '18:00', closed: true }, sun: { open: '11:00', close: '18:00', closed: true } };
bs.business_hours = mine; bs.metadata = { ...bs.metadata, business_hours: mine, hours_confirmed_at: new Date().toISOString(), hours_source: 'owner' };
const r2 = await BL.applyProfile(c, T.tenants[0], profile, { source: { google, links } });
ok(!r2.hours && T.booking_settings[0].business_hours.mon.open === '11:00', 'hours the owner set by hand are never overwritten by a scan');

// Website-only text hours still work
ok(JSON.stringify(BL.parseHoursText('Tuesday - Saturday: 10am - 7pm')) .includes('"tue":{"open":"10:00","close":"19:00","closed":false}'), 'plain website text "Tuesday - Saturday: 10am - 7pm" is understood');
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
