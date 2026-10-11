// Lola sells like the best front desk, from the salon's REAL data: real add-ons at real prices (never invented),
// a stylist's own price quoted and booked, the waitlist when nothing is open (and freed times offered to it),
// the next visit pre-booked at the service's natural cycle, and the same smart order on every booking path.
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'k';
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const texts = [];
globalThis.fetch = async (url, init = {}) => { if (String(url).includes('/messages')) texts.push(JSON.parse(init.body || '{}')); return new Response(JSON.stringify({ data: { id: 'm' } }), { status: 200, headers: { 'content-type': 'application/json' } }); };
const { T } = await import('./fake-supabase.mjs');
const P = new URL('../../api/', import.meta.url).href;
const TID = '44444444-4444-4444-8444-444444444444', TZ = 'America/New_York', DAY = 864e5;
const day = new Date(Date.now() + 3 * DAY).toLocaleDateString('en-CA', { timeZone: TZ });
const atOn = (d, hhmm) => { const x = new Date(`${d}T${hhmm}:00Z`); const off = (new Date(x.toLocaleString('en-US', { timeZone: 'UTC' })) - new Date(x.toLocaleString('en-US', { timeZone: TZ }))); return new Date(x.getTime() + off).toISOString(); };
const at = (h) => atOn(day, h);
T.tenants = [{ id: TID, name: 'MMA Salon', slug: 'mma', subscription_status: 'active', phone_number: '+13055550100', services: [{ name: 'Balayage', price: 250 }, { name: 'Cut', price: 80 }] }];
T.booking_settings = [{ tenant_id: TID, timezone: TZ, slot_interval_minutes: 15, minimum_notice_minutes: 0, booking_horizon_days: 120, default_buffer_before_min: 0, default_buffer_after_min: 0, allow_processing_overlap: true, metadata: { rebook_followup_days: 28 } }];
T.services = [
  { id: 'bal', tenant_id: TID, name: 'Balayage', duration_minutes: 180, price: 250, is_active: true },
  { id: 'cut', tenant_id: TID, name: 'Cut', duration_minutes: 60, price: 80, is_active: true },
  { id: 'gloss', tenant_id: TID, name: 'Gloss', duration_minutes: 30, price: 45, is_active: true },
  { id: 'olaplex', tenant_id: TID, name: 'Olaplex Treatment', duration_minutes: 20, price: 35, is_active: true },
];
T.staff = [{ id: 'meddy', tenant_id: TID, name: 'Meddy', is_active: true }, { id: 'nia', tenant_id: TID, name: 'Nia', is_active: true }];
T.staff_services = [{ staff_id: 'meddy', service_id: 'bal', custom_price: 400 }];
T.staff_schedules = []; for (const s of ['meddy', 'nia']) for (let d = 0; d < 7; d++) T.staff_schedules.push({ tenant_id: TID, staff_id: s, day_of_week: d, start_time: '09:00', end_time: '18:00' });
for (const k of ['staff_time_off', 'blocked_slots', 'bookings', 'availability_holds', 'clients', 'locations', 'business_hours', 'cached_availability', 'provider_mappings', 'booking_outbox', 'integrations', 'client_memories', 'usage_events', 'deposits', 'tenant_channels', 'opt_outs', 'booking_waitlist', 'booking_history', 'rebooking_offers', 'booking_events', 'lola_events']) T[k] ||= [];
const tenant = T.tenants[0];
const { SKILLS } = await import(P + 'lola-tools.js');

// ── Real add-ons only ──
let r = await SKILLS.detect_upsell_opportunity(tenant, { service: 'Balayage' });
ok(r.recommended.length && r.recommended.every((a) => ['Gloss', 'Olaplex Treatment'].includes(a.name)) && /\$45|\$35/.test(r.speak), 'the add-on is one the salon really sells, at its real price: ' + r.speak);
ok(!/Restorative Gloss|Bond-Building|\$60/.test(r.speak), 'never an invented product or price');
T.services = T.services.filter((s) => !['gloss', 'olaplex'].includes(s.id));
r = await SKILLS.detect_upsell_opportunity(tenant, { service: 'Balayage' });
ok(!r.recommended.length && r.instruction === 'Do not offer an add-on.', 'nothing on the menu pairs with it → no pitch at all');
T.services.push({ id: 'gloss', tenant_id: TID, name: 'Gloss', duration_minutes: 30, price: 45, is_active: true });

// ── The stylist's own price ──
r = await SKILLS.get_pricing(tenant, { service: 'Balayage' });
ok(/\$250/.test(r.speak) && /\$400 with Meddy/.test(r.speak), 'the price includes the stylist who charges more: ' + r.speak);
r = await SKILLS.get_pricing(tenant, { service: 'Balayage', stylist: 'Meddy' });
ok(r.price === 400 && /with Meddy it's \$400/.test(r.speak), 'asked about Meddy → Meddy’s price: ' + r.speak);
const { createBookingSafe } = await import(P + 'lib/calendar-engine.js');
const bk = await createBookingSafe({ tenant, service: 'Balayage', stylist: 'Meddy', startsAt: at('09:00'), durationMin: 180, price: 250, sendConfirmation: false, skipDeposit: true });
ok(bk.ok && Number(bk.booking.total_amount) === 400, 'booked with Meddy → the booking (and its deposit) carry $400, not the menu $250: ' + bk.booking?.total_amount);

// ── Nothing open → the priority waitlist, and a freed time goes to it ──
T.blocked_slots = [{ tenant_id: TID, blocked_date: null, staff_id: null, start_time: null, end_time: null }];
const realBlocks = T.blocked_slots; T.staff_schedules = [];
r = await SKILLS.check_availability(tenant, { service: 'Cut', date: day });
ok(r.offer_waitlist && /priority waitlist/.test(r.speak) && !r.slots.length, 'nothing open → Lola offers the waitlist: ' + r.speak);
T.blocked_slots = []; for (const s of ['meddy', 'nia']) for (let d = 0; d < 7; d++) T.staff_schedules.push({ tenant_id: TID, staff_id: s, day_of_week: d, start_time: '09:00', end_time: '18:00' });
r = await SKILLS.waitlist_add(tenant, { service: 'Cut', client_name: 'Sofia Reyes', client_phone: '+13055550177', sms_consent: true });
ok(r.waitlisted && T.booking_waitlist.length === 1 && T.booking_waitlist[0].sms_consent === true && /waitlist/.test(r.speak), 'waitlist_add puts her on it for real: ' + r.speak);
r = await SKILLS.waitlist_add(tenant, { service: 'Cut', client_name: 'Someone Else', client_phone: '+13055550999', sms_consent: true, caller_line: '+13055550177' });
ok(T.booking_waitlist[1]?.sms_consent === false, 'a caller can’t sign someone else’s number up for texts');
r = await SKILLS.waitlist_add(tenant, { service: 'Cut', client_name: 'No Answer', client_phone: '+13055550998' });
ok(T.booking_waitlist[2]?.sms_consent === false, 'no clear yes → no texts');
T.booking_waitlist = T.booking_waitlist.slice(0, 1);
T.clients.push({ id: 'cl-j', tenant_id: TID, name: 'Jade Lin', first_name: 'Jade', last_name: 'Lin', phone: '+13055550188' });
T.bookings.push({ id: 'bk-j', tenant_id: TID, client_id: 'cl-j', staff_id: 'nia', service_id: 'cut', start_time: at('15:00'), end_time: at('16:00'), status: 'confirmed' });
r = await SKILLS.cancel_appointment(tenant, { client_phone: '+13055550188' });
await new Promise((ok2) => setTimeout(ok2, 50));
ok(r.cancelled && texts.some((t) => t.to === '+13055550177'), 'Jade cancels with Lola → Sofia (waitlisted) gets the text for that time');

// ── The next visit at the service's natural cycle ──
const { rebookIntervalDays } = await import(P + 'lib/sales-brain.js');
ok(rebookIntervalDays({ name: 'Balayage' }) === 84 && rebookIntervalDays({ name: "Women's Cut" }) === 42 && rebookIntervalDays({ name: 'Signature Blowout' }) === 7 && rebookIntervalDays({ name: 'Mystery Service' }, 28) === 28, 'natural cycles: balayage 12 weeks, cut 6, blowout 1, anything else the salon’s setting');
T.clients.push({ id: 'cl-m', tenant_id: TID, name: 'Maria Lopez', first_name: 'Maria', last_name: 'Lopez', phone: '+13055550166' });
T.bookings.push({ id: 'bk-old', tenant_id: TID, client_id: 'cl-m', staff_id: 'nia', service_id: 'cut', start_time: new Date(Date.now() - 20 * DAY).toISOString(), end_time: new Date(Date.now() - 20 * DAY + 3600e3).toISOString(), status: 'completed' });
r = await SKILLS.rebook_next_visit(tenant, { client_phone: '+13055550166' });
const first = r.slots?.[0] ? Date.parse(r.slots[0]) : 0;
ok(r.service === 'Cut' && r.cycle_days === 42 && first > Date.now() + 20 * DAY && first < Date.now() + 26 * DAY && /with Nia/.test(r.speak), 'her next cut, ~6 weeks after the last one, with her stylist: ' + r.speak);

// ── The rebooking text turns on with the owner's setting, timed per service ──
const { resolvePolicy } = await import(P + 'lib/rebooking.js');
ok(resolvePolicy({ metadata: { rebook_followup_days: 28 } }) === null && resolvePolicy({ metadata: { rebooking: { enabled: true, interval_days: 28 } } })?.interval_days === 28 && resolvePolicy({ metadata: { rebooking: { enabled: false } } }) === null, 'the rebooking text is opt-in: a default value never texts clients; the owner switching it on does');
const html = (await import('node:fs')).readFileSync(new URL('../../booking-settings.html', import.meta.url), 'utf8');
ok(/dirty\.has\('rebook_followup_days'\)/.test(html) && /rebooking: \{ enabled: n > 0/.test(html) && /rebook_followup_days \?\? 28/.test(html), 'the settings page writes the switch only when the owner changes it, and "Off" stays off');
ok(['Haircut & Style', 'Color & Style', 'Wash, Cut & Blowdry'].every((n) => rebookIntervalDays({ name: n }) === 42) && rebookIntervalDays({ name: 'Brazilian Blowout' }) === 90, 'a cut "& Style" is a 6-week cut, not a 1-week blowout; a Brazilian Blowout is a smoothing treatment');

// ── Every booking path offers the same smart order ──
T.bookings.push({ id: 'b-a', tenant_id: TID, staff_id: 'nia', service_id: 'cut', start_time: at('12:00'), end_time: at('13:00'), status: 'confirmed' });
const brain = await import(P + 'lib/booking-brain.js');
const av = await brain.checkAvailability(tenant, { service: 'Cut', date: day });
const top = av.slots[0];
ok(av.ok && top && (top.reasons || []).length > 0, 'the dashboard / Telnyx tool path now gets ranked times too (not earliest-first): ' + (top?.reasons || []).join(', '));
// ── A deposit the owner asks for later never auto-releases a confirmed appointment ──
{
  const H = 3600e3, now = Date.now();
  T.booking_settings[0].metadata = { ...T.booking_settings[0].metadata, deposits: { enabled: true, percent: 20, hold_minutes: 30 } };
  T.bookings.push({ id: 'dep-old', tenant_id: TID, client_id: 'cl-m', staff_id: 'nia', service_id: 'cut', start_time: new Date(now + 72 * H).toISOString(), end_time: new Date(now + 73 * H).toISOString(), status: 'confirmed', created_at: new Date(now - 48 * H).toISOString() });
  T.bookings.push({ id: 'dep-new', tenant_id: TID, client_id: 'cl-j', staff_id: 'nia', service_id: 'cut', start_time: new Date(now + 96 * H).toISOString(), end_time: new Date(now + 97 * H).toISOString(), status: 'confirmed', created_at: new Date(now - 2 * H).toISOString() });
  T.deposits.push({ id: 'd1', tenant_id: TID, booking_id: 'dep-old', amount: 16, status: 'pending', created_at: new Date(now - 1 * H).toISOString() });
  T.deposits.push({ id: 'd2', tenant_id: TID, booking_id: 'dep-new', amount: 16, status: 'pending', created_at: new Date(now - 2 * H + 60e3).toISOString() });
  const { runDepositSweep } = await import(P + 'lib/deposits.js');
  await runDepositSweep(new Date(), { send: async () => ({ data: { id: 'x' } }), refund: async () => ({}) });
  const st = (id) => T.bookings.find((b) => b.id === id).status;
  ok(st('dep-old') === 'confirmed' && T.deposits.find((d) => d.id === 'd1').status === 'pending', 'owner asked for a deposit days after booking → the appointment stays confirmed');
  ok(st('dep-new') === 'cancelled' && T.deposits.find((d) => d.id === 'd2').status === 'expired', 'a deposit asked at booking and unpaid past the window still releases the time (salon policy)');
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
