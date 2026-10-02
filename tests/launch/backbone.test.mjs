// The scheduling backbone: Lola reads one local calendar that already includes
// the salon's own system (API or calendar link), books instantly, and writes to
// the salon's platform in the background with retries and an owner alert.
// Plus: keep-your-number forwarding, instant text-back, deposits that hold a slot,
// processing time learned from the menu.
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'k';
process.env.TELNYX_VOICE_APP_ID = 'cc-app'; delete process.env.TELNYX_PUBLIC_KEY;
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const sms = [], calls = [], actions = []; let ics = '';
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  if (u.includes('/v2/messages')) { sms.push(JSON.parse(init.body)); return J({ data: { id: 'm' } }); }
  if (/\/v2\/calls$/.test(u)) { const b = JSON.parse(init.body); calls.push(b); return b.connection_id === 'cc-app' ? J({ data: { call_control_id: 'v3:fwd' } }) : J({ errors: [{ detail: 'no' }] }, 422); }
  if (/\/v2\/calls\/[^/]+\/actions\//.test(u)) { actions.push({ u, b: JSON.parse(init.body) }); return J({ data: {} }); }
  if (u.includes('/phone_numbers')) return J({ data: [], meta: { total_pages: 1 } });
  if (u.startsWith('https://cal.example.com/')) return new Response(ics, { status: 200, headers: { 'content-type': 'text/calendar' } });
  return J({ data: [] });
};
const { T } = await import('./fake-supabase.mjs');
const P = new URL('../../api/', import.meta.url).href;
const { db } = await import(P + 'lib/db.js');
const TZ = 'America/New_York', TID = '00000000-0000-4000-8000-0000000000b1', DAY = 864e5;
const day = new Date(Date.now() + 3 * DAY).toLocaleDateString('en-CA', { timeZone: TZ });
const at = (hhmm) => { const d = new Date(`${day}T${hhmm}:00Z`); const off = (new Date(d.toLocaleString('en-US', { timeZone: 'UTC' })) - new Date(d.toLocaleString('en-US', { timeZone: TZ }))); return new Date(d.getTime() + off).toISOString(); };
function reset() {
  T.tenants = [{ id: TID, name: 'MMA Salon', slug: 'mma', subscription_status: 'active', phone_number: '+13055550100', operator_phone: '+17865550199' }];
  T.booking_settings = [{ tenant_id: TID, timezone: TZ, slot_interval_minutes: 30, minimum_notice_minutes: 0, booking_horizon_days: 90, default_buffer_before_min: 0, default_buffer_after_min: 0, allow_processing_overlap: true, metadata: {} }];
  T.services = [{ id: 'cut', tenant_id: TID, name: 'Cut', duration_minutes: 60, price: 80, is_active: true },
    { id: 'trim', tenant_id: TID, name: 'Trim', duration_minutes: 45, price: 40, is_active: true },
    { id: 'bal', tenant_id: TID, name: 'Balayage', duration_minutes: 135, price: 300, is_active: true, active_duration_1_min: 45, processing_duration_min: 45, active_duration_2_min: 45 }];
  T.staff = [{ id: 'ana', tenant_id: TID, name: 'Ana', is_active: true }, { id: 'bo', tenant_id: TID, name: 'Bo', is_active: true }];
  T.staff_services = []; T.staff_schedules = [];
  for (const s of ['ana', 'bo']) for (let d = 0; d < 7; d++) T.staff_schedules.push({ tenant_id: TID, staff_id: s, day_of_week: d, start_time: '09:00', end_time: '17:00' });
  T.staff_time_off = []; T.blocked_slots = []; T.bookings = []; T.availability_holds = []; T.clients = []; T.locations = []; T.business_hours = [];
  T.cached_availability = []; T.provider_mappings = []; T.booking_outbox = []; T.integrations = []; T.booking_sync_log = [];
  T.client_memories = []; T.usage_events = []; T.opt_outs = []; T.calls = []; T.tenant_channels = []; T.tenant_numbers = []; T.deposits = [];
}
reset();
const { getAvailability } = await import(P + 'lib/availability-engine-v2.js');
const free = async (svc, hhmm) => (await getAvailability({ tenantId: TID, serviceId: svc, date: at(hhmm), limit: 500 })).slots.filter((s) => s.starts_at === at(hhmm)).map((s) => s.staff_id).sort();

// ── 1. The salon's own system is busy time for Lola ──
ok((await free('cut', '10:00')).join() === 'ana,bo', 'empty day: both stylists free at 10');
T.cached_availability = [{ tenant_id: TID, provider: 'square', external_booking_id: 'sq1', starts_at: at('10:00'), ends_at: at('11:00'), staff_id: 'TM_ANA', status: 'booked' }];
T.provider_mappings = [{ tenant_id: TID, provider: 'square', entity_type: 'staff', external_id: 'TM_ANA', local_id: 'ana' }];
ok((await free('cut', '10:00')).join() === 'bo', 'a Square appointment for Ana blocks Ana (never double-booked)');
T.cached_availability.push({ tenant_id: TID, provider: 'vagaro', external_booking_id: 'v1', starts_at: at('10:00'), ends_at: at('11:00'), staff_id: null, status: 'booked' });
ok((await free('cut', '10:00')).length === 0, 'an unassigned Vagaro appointment takes the last free chair');
ok((await free('cut', '12:00')).join() === 'ana,bo', 'other times stay open');
T.bookings = [{ id: 'mine', tenant_id: TID, staff_id: 'bo', service_id: 'cut', start_time: at('14:00'), end_time: at('15:00'), status: 'confirmed', external_id: 'sq9' }];
T.cached_availability = [{ tenant_id: TID, provider: 'square', external_booking_id: 'sq9', starts_at: at('14:00'), ends_at: at('15:00'), staff_id: null, status: 'booked' }];
ok((await free('cut', '14:00')).join() === 'ana', 'LolaDesk’s own booking echoed back by Square isn’t counted twice');
T.bookings = [{ id: 'b0', tenant_id: TID, staff_id: 'ana', service_id: 'bal', start_time: at('09:00'), end_time: at('11:15'), status: 'confirmed' }];
T.cached_availability = []; T.booking_settings[0].slot_interval_minutes = 15;
ok((await free('trim', '09:45')).includes('ana') && !(await free('trim', '09:30')).includes('ana'), 'processing time: Ana takes a 45-min trim while the balayage processes — not during application');

// ── 2. The calendar-link fallback (Boulevard, Vagaro, Fresha, Mindbody… any .ics) ──
reset();
const ical = await import(P + 'lib/connectors/ical.js');
const d0 = day.replace(/-/g, '');
ics = ['BEGIN:VCALENDAR', 'X-WR-TIMEZONE:America/New_York',
  'BEGIN:VEVENT', 'UID:a1', `DTSTART;TZID=America/New_York:${d0}T100000`, `DTEND;TZID=America/New_York:${d0}T110000`, 'SUMMARY:Balayage \\, toner', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:a2', `DTSTART;TZID=America/New_York:${d0}T130000`, 'DURATION:PT30M', 'STATUS:CANCELLED', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:a3', `DTSTART;TZID=America/New_York:${d0}T150000`, 'DURATION:PT1H', 'TRANSP:TRANSPARENT', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:w', `DTSTART;TZID=America/New_York:${d0}T160000`, `DTEND;TZID=America/New_York:${d0}T163000`, 'RRULE:FREQ=WEEKLY;COUNT=3', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:w', `RECURRENCE-ID;TZID=America/New_York:${new Date(Date.parse(day) + 7 * DAY).toISOString().slice(0, 10).replace(/-/g, '')}T160000`, 'STATUS:CANCELLED',
  `DTSTART;TZID=America/New_York:${new Date(Date.parse(day) + 7 * DAY).toISOString().slice(0, 10).replace(/-/g, '')}T160000`, 'DURATION:PT30M', 'END:VEVENT',
  'END:VCALENDAR'].join('\r\n');
const evs = ical.parseIcs(ics, { from: new Date().toISOString(), to: new Date(Date.now() + 40 * DAY).toISOString() });
ok(evs.length === 3 && new Date(evs[0].start).toISOString() === at('10:00') && evs[0].summary === 'Balayage , toner', 'iCal: time zones, cancelled + free events skipped');
ok(evs.filter((e) => e.uid === 'w').length === 2, 'iCal: weekly repeats expanded, a cancelled single occurrence removed');
ok(ical.normalizeUrl('webcal://cal.example.com/x.ics') === 'https://cal.example.com/x.ics' && ical.normalizeUrl('http://127.0.0.1/x') === null, 'webcal links accepted; private addresses refused');
globalThis.__authUsers = { tok: { id: 'u1', email: 'o@mma.com' } };
T.tenant_users = [{ user_id: 'u1', tenant_id: TID, role: 'owner', status: 'active' }];
process.env.INTEGRATION_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const run = async (mod, req) => { const h = (await import(P + mod)).default; return new Promise((resolve) => { const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(o) { resolve({ status: this.statusCode, headers: this.headers, ...o }); }, end() { resolve({ status: this.statusCode, headers: this.headers }); } }; h({ method: 'POST', headers: { authorization: 'Bearer tok' }, query: {}, ...req }, res); }); };
let r = await run('calendar-link.js', { body: { url: 'webcal://cal.example.com/vagaro/secret.ics', staff_id: 'ana' } });
ok(r.ok && r.events === 3 && /Lola won’t book over them/.test(r.say), 'paste a calendar link → checked, saved: ' + r.say);
ok(T.integrations[0]?.provider === 'ical' && !/cal\.example\.com/.test(T.integrations[0].access_token), 'the secret link is stored encrypted');
ok(T.cached_availability.some((x) => x.provider === 'ical' && x.staff_id === 'local:ana' && x.starts_at === at('10:00')), 'its appointments land in the local calendar right away');
ok((await free('cut', '10:00')).join() === 'bo', 'and Lola won’t book Ana over them');
r = await run('calendar-link.js', { method: 'GET' });
ok(r.feeds?.[0]?.host === 'cal.example.com' && !JSON.stringify(r).includes('secret.ics'), 'Settings shows the link without revealing it');
r = await run('calendar-link.js', { body: { url: 'https://cal.example.com/nope' } }); // ics stays valid; now break it
ics = 'not a calendar';
r = await run('calendar-link.js', { body: { url: 'https://cal.example.com/broken.ics' } });
ok(r.status === 400 && /didn’t open as a calendar/.test(r.error), 'a wrong link is refused in plain words');

// ── 3. Write-through: instant local booking, platform write in the background ──
reset();
const outbox = await import(P + 'lib/booking-outbox.js');
const { SKILLS } = await import(P + 'lola-tools.js');
const t0 = Date.now();
r = await SKILLS.book_appointment(T.tenants[0], { service: 'Cut', date: day, time: '11:00am', client_name: 'Sarah Kim', client_phone: '+13055554444' });
ok(r.booked && Date.now() - t0 < 1500, `Lola books from the local engine in ${Date.now() - t0}ms — no wait on the salon’s platform`);
ok(T.booking_outbox.length === 1 && T.booking_outbox[0].payload.service.name === 'Cut' && T.booking_outbox[0].payload.client.phone === '+13055554444', 'the platform write is queued durably');
await new Promise((r) => setTimeout(r, 50));
const row = T.booking_outbox[0];
ok(['skipped', 'pending', 'done'].includes(row.status), 'with no platform connected it finishes quietly: ' + row.status);
row.status = 'pending'; row.next_attempt_at = new Date(0).toISOString();
let res = await outbox.processOutbox(db(), { commit: async () => ({ ok: true, external: { provider: 'square', id: 'SQ-77' } }) });
ok(res.done === 1 && T.booking_outbox[0].status === 'done' && T.bookings.find((b) => b.id === row.booking_id)?.external_id === 'SQ-77', 'committed upstream; the booking remembers its Square id');
row.status = 'pending'; row.attempts = 0; row.next_attempt_at = new Date(0).toISOString();
res = await outbox.processOutbox(db(), { commit: async () => ({ ok: false, error: 'Square 503 service unavailable' }) });
ok(res.retrying === 1 && T.booking_outbox[0].status === 'pending' && Date.parse(T.booking_outbox[0].next_attempt_at) > Date.now(), 'a platform hiccup is retried later (backoff)');
const sent = [];
row.next_attempt_at = new Date(0).toISOString();
res = await outbox.processOutbox(db(), { commit: async () => ({ ok: false, conflict: true, error: 'slot taken' }), send: async (m) => { sent.push(m); return {}; } });
ok(res.failed === 1 && sent[0]?.to === '+17865550199' && /Sarah/.test(sent[0].text) && /already taken there/.test(sent[0].text), 'the platform refuses → the owner is texted who and when: ' + sent[0]?.text);
row.status = 'pending'; row.attempts = outbox.MAX_ATTEMPTS - 1; row.next_attempt_at = new Date(0).toISOString(); sent.length = 0;
res = await outbox.processOutbox(db(), { commit: async () => ({ ok: false, error: '401 Unauthorized' }), send: async (m) => { sent.push(m); return {}; } });
ok(res.failed === 1 && /reconnected/.test(sent[0]?.text || ''), 'expired login → after the last retry the owner is told to reconnect');

// ── 4. The engine contract ──
reset();
const { BookingEngineFactory, SlotCollisionError, HoldExpiredError } = await import(P + 'lib/booking-engine.js');
const engine = await BookingEngineFactory.forTenant(TID, { fresh: true });
const slots = await engine.getAvailableSlots({ date: at('09:00') }, 'cut');
ok(slots.length > 0 && slots[0].service_id === 'cut', 'getAvailableSlots: local, instant');
const hold = await engine.reserveSlotHold(slots[0], { id: null });
ok(hold.hold_token && Date.parse(hold.expires_at) - Date.now() > 8 * 60e3, 'reserveSlotHold: a 10-minute soft lock');
let err = null; try { await engine.reserveSlotHold(slots[0], {}); } catch (e) { err = e; }
ok(err instanceof SlotCollisionError && err.code === 'slot_collision', 'the same slot can’t be held twice (SlotCollisionError)');
const receipt = await engine.commitBooking(hold.hold_token, { client: { name: 'Mia' }, timezone: TZ });
ok(receipt.booking_id && T.bookings.some((b) => b.id === receipt.booking_id) && receipt.upstream === 'queued', 'commitBooking: booked locally, upstream queued');
err = null; try { await engine.commitBooking(hold.hold_token, {}); } catch (e) { err = e; }
ok(err instanceof HoldExpiredError, 'a used or expired hold can’t book again (HoldExpiredError)');
const lt = await run('lola-tools.js', { query: { tool: 'list_services', to: '+13055550100' }, body: {} });
ok(/total;dur=/.test(lt.headers['Server-Timing'] || '') && lt.headers['X-Lola-Latency-Ms'] != null, 'every voice tool reports its latency (Server-Timing)');

// ── 5. Keep your number: conditional forwarding ──
reset();
const fwd = await import(P + 'lib/forwarding.js');
const att = fwd.forwardingPlan('+13055550100', 'att'), vz = fwd.forwardingPlan('+13055550100', 'verizon');
ok(att.steps[0].dial === '**61*13055550100**10#' && att.steps[1].dial === '**67*13055550100#' && vz.steps[0].dial === '*713055550100', 'the exact codes: AT&T/T-Mobile ring-2x + busy, Verizon no-answer/busy');
r = await fwd.startForwardingTest(db(), T.tenants[0], '(305) 555-7777');
ok(r.ok && calls.at(-1).to === '+13055557777' && calls.at(-1).from === '+13055550100', 'Test it: LolaDesk calls the salon number from Lola’s line');
const { bridgeStep, decodeState } = await import(P + 'lib/owner-call.js');
const ev = (type, cs) => ({ data: { event_type: type, payload: { call_control_id: 'v3:fwd', client_state: cs } } });
const s1 = bridgeStep(ev('call.answered', calls.at(-1).client_state));
ok(s1.action === 'speak' && bridgeStep(ev('call.speak.ended', s1.body.client_state)).action === 'hangup', 'the test leg says goodbye and hangs up');
ok(await fwd.noteForwardedArrival(db(), T.tenants[0], '+13055550100', '+13055550100') && T.tenant_channels.find((x) => x.channel === 'forwarding').status === 'verified', 'the call arrives back on Lola’s line → forwarding verified');

// ── 6. Instant text-back ──
reset();
const { instantTextBack } = await import(P + 'lib/textback.js');
T.calls = [{ id: 'k1', tenant_id: TID, telnyx_call_control_id: 'v3:k1', from_number: '+13055558888', to_number: '+13055550100', direction: 'inbound', created_at: new Date().toISOString() }];
const tb = []; const send = async (m) => { tb.push(m); return {}; };
r = await instantTextBack(db(), { callControlId: 'v3:k1', durationSec: 4 }, { send });
ok(r.sent && tb[0].to === '+13055558888' && /cut off/.test(tb[0].text) && /STOP/.test(tb[0].text), 'hung up after 4s → texted in the same second: ' + tb[0]?.text);
r = await instantTextBack(db(), { callControlId: 'v3:k1', durationSec: 3 }, { send });
ok(!r.sent && r.reason === 'already_texted_today', 'never twice in a day');
T.calls.push({ id: 'k2', tenant_id: TID, telnyx_call_control_id: 'v3:k2', from_number: '+13055559999', to_number: '+13055550100', direction: 'inbound', created_at: new Date().toISOString() });
r = await instantTextBack(db(), { callControlId: 'v3:k2', durationSec: 95 }, { send });
ok(!r.sent && r.reason === 'real_conversation', 'a real conversation gets no text-back');
T.calls.push({ id: 'k3', tenant_id: TID, telnyx_call_control_id: 'v3:k3', from_number: '+17865550199', to_number: '+13055550100', direction: 'inbound', created_at: new Date().toISOString() });
r = await instantTextBack(db(), { callControlId: 'v3:k3', durationSec: 2 }, { send });
ok(!r.sent && r.reason === 'own_line', 'the owner calling in never gets one');

// ── 7. Deposits: the owner's policy is what Lola charges; optional pay-within hold ──
reset();
const dep = await import(P + 'lib/deposits.js');
ok(dep.depositAmountCents(80, { type: 'fixed', fixed_cents: 2500, min_cents: 0 }) === 2500 && dep.depositAmountCents(300, { type: 'percent', percent: 25, premium_value: 50, premium_threshold: 250, min_cents: 0 }) === 15000, 'fixed $25, and the $250+ tier at 50%');
const { mirrorDeposits } = await import(P + 'tenant/billing-policies/index.js');
await mirrorDeposits(db(), TID, { enabled: true, type: 'fixed', amount: 50, min_amount: 0, hold_minutes: '10' });
const pol = dep.resolvePolicy(T.booking_settings[0]);
ok(pol.enabled && pol.type === 'fixed' && pol.fixed_cents === 5000 && pol.hold_minutes === 10, 'Banking → Policies now drives the deposit Lola texts (it didn’t before)');
T.clients = [{ id: 'cl', tenant_id: TID, name: 'Sarah', phone: '+13055554444' }];
T.bookings = [{ id: 'bk', tenant_id: TID, client_id: 'cl', service_id: 'cut', status: 'confirmed', start_time: at('15:00'), end_time: at('16:00'), total_amount: 80 }];
T.deposits = [{ id: 'd1', tenant_id: TID, booking_id: 'bk', amount: 50, status: 'pending', created_at: new Date(Date.now() - 11 * 60e3).toISOString() }];
const dsent = [];
const sw = await dep.runDepositSweep(new Date(), { send: async (m) => { dsent.push(m); return {}; } });
ok(sw.released === 1 && T.bookings[0].status === 'cancelled' && T.deposits[0].status === 'expired' && /released the time/.test(dsent[0]?.text || ''), 'unpaid after 10 minutes → the slot goes back on the calendar and the client is told');
const { depositRequestText } = await import(P + 'lib/lola-persona.js');
ok(/within 10 minutes/.test(depositRequestText({ firstName: 'Sarah', salon: 'MMA', serviceName: 'Cut', when: 'Sat 11am', amount: '$50.00', link: 'https://pay', holdMinutes: 10 })), 'the deposit text says “tap within 10 minutes”');

// ── 8. The menu reader learns processing time and the deposit policy ──
const bl = await import(P + 'lib/business-learn.js');
const ph = bl.phasesFor('Full Balayage', 135);
ok(ph.active_duration_1_min === 45 && ph.processing_duration_min === 45 && ph.active_duration_2_min === 45 && bl.phasesFor('Haircut', 60) === null, 'balayage 2h15 → application 45 / processing 45 / finish 45; a haircut stays one block');
ok(bl.depositFromText('A $50 deposit is required to book').fixed_cents === 5000 && bl.depositFromText('25% deposit due at booking').percent === 25, 'deposit policy read from the website');

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
