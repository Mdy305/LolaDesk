// Business Owner Command Center: "what's our revenue locked in for next week?" and
// "block off Thursday afternoon for maintenance" — from the app, by text from the owner's
// cell (plan → YES → done), and on the owner phone line. Non-owners get no powers.
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'k';
process.env.OPERATOR_TOOLS_SECRET = 'op-secret'; process.env.ELEVENLABS_API_KEY = 'el'; process.env.ELEVENLABS_VOICE_ID = 'v1';
delete process.env.TELNYX_PUBLIC_KEY; delete process.env.OWNER_LINE_NUMBER; delete process.env.LOLADESK_OWNER_LINE;
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const texts = []; let llm = { content: 'Here to help.' };
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.includes('/messages')) { texts.push(JSON.parse(init.body)); return new Response(JSON.stringify({ data: { id: 'm' + texts.length } }), { status: 200, headers: { 'content-type': 'application/json' } }); }
  if (u.includes('chat/completions')) return new Response(JSON.stringify({ choices: [{ message: llm }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
};
const { T } = await import('./fake-supabase.mjs');
const P = new URL('../../api/', import.meta.url).href;
const { localDateKey, zonedLocalToUtc } = await import(P + 'lib/timezone.js');
const { addDays, resolvePeriod, periodFromText } = await import(P + 'lib/owner-money.js');
const TID = '00000000-0000-4000-8000-0000000000c1', OTHER = '00000000-0000-4000-8000-0000000000c2', TZ = 'America/New_York';
const LINE = '+13055550100', OWNER = '+17865550199', CLIENT = '+13055551234', LINE2 = '+13055550200';
const at = (key, hm) => zonedLocalToUtc(key, hm + ':00', TZ);
const today = localDateKey(new Date(), TZ);
const dow = new Date(`${today}T12:00:00Z`).getUTCDay();
const monday = addDays(today, -((dow + 6) % 7)), nextMon = addDays(monday, 7), nextSun = addDays(monday, 13);
const hourNow = Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' }).format(new Date())) % 24;
let thu = addDays(today, (4 - dow + 7) % 7); if (thu === today && hourNow >= 19) thu = addDays(thu, 7);
const hours = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: '09:00', close: '19:00', closed: false }]));

function reset() {
  T.tenants = [{ id: TID, name: 'MMA Salon', slug: 'mma', phone_number: LINE, operator_phone: OWNER, operator_pin_hash: null, subscription_status: 'active' },
    { id: OTHER, name: 'Other Salon', slug: 'other', phone_number: LINE2, operator_phone: '+17865550000', subscription_status: 'active' }];
  T.tenant_numbers = [{ tenant_id: TID, phone_number: LINE, status: 'active' }, { tenant_id: OTHER, phone_number: LINE2, status: 'active' }];
  T.booking_settings = [{ tenant_id: TID, timezone: TZ, business_hours: hours, metadata: { hours_confirmed_at: '2026-01-01' } }, { tenant_id: OTHER, timezone: TZ, metadata: {} }];
  T.staff = [{ id: 'ana', tenant_id: TID, name: 'Ana', is_active: true }, { id: 'bo', tenant_id: TID, name: 'Bo', is_active: true }, { id: 'zed', tenant_id: OTHER, name: 'Zed', is_active: true }];
  T.services = [{ id: 'cut', tenant_id: TID, name: 'Cut', duration_minutes: 60, price: 80, is_active: true }];
  T.clients = [{ id: 'maria', tenant_id: TID, name: 'Maria Lopez', phone: '+13055551111' }, { id: 'jo', tenant_id: TID, name: 'Jo Park', phone: '+13055552222' },
    { id: 'early', tenant_id: TID, name: 'Early Bird', phone: '+13055553333' }, { id: 'gone', tenant_id: TID, name: 'Gone Girl', phone: '+13055554444' },
    { id: 'cx', tenant_id: OTHER, name: 'Maria Other', phone: '+13055559999' }];
  const bk = (id, tenant, client, staff, startIso, mins, status, amt) => ({ id, tenant_id: tenant, client_id: client, staff_id: staff, service_id: 'cut', start_time: startIso, end_time: new Date(Date.parse(startIso) + mins * 60e3).toISOString(), status, total_amount: amt });
  T.bookings = [
    // next week (Mon–Sun, salon time): 150 (Ana) + 100 (Bo, arrived) + 50 (Ana, Sunday 11:30pm) = $300, 3 bookings
    bk('nw1', TID, 'maria', 'ana', at(nextMon, '10:00'), 60, 'confirmed', 150),
    bk('nw2', TID, 'jo', 'bo', at(addDays(nextMon, 3), '15:00'), 60, 'arrived', 100),
    bk('nw3', TID, 'early', 'ana', at(nextSun, '23:30'), 30, 'confirmed', 50),
    bk('nwx', TID, 'gone', 'bo', at(addDays(nextMon, 2), '11:00'), 60, 'cancelled', 999),
    bk('nwp', TID, 'gone', 'bo', at(addDays(nextMon, 4), '11:00'), 60, 'pending', 500),
    // the edges: this Sunday 11:30pm (is UTC Monday) and the Monday after next 12:30am → not next week
    bk('edge1', TID, 'jo', 'ana', at(addDays(monday, 6), '23:30'), 30, 'confirmed', 70),
    bk('edge2', TID, 'jo', 'ana', at(addDays(nextSun, 1), '00:30'), 30, 'confirmed', 90),
    bk('oth', OTHER, 'cx', 'zed', at(addDays(nextMon, 1), '12:00'), 60, 'confirmed', 777),
    // Thursday: Maria 2pm and Jo 4pm clash with the afternoon; Early 10am and a cancelled 3pm don't
    bk('t1', TID, 'maria', 'ana', at(thu, '14:00'), 60, 'confirmed', 80),
    bk('t2', TID, 'jo', 'bo', at(thu, '16:00'), 60, 'confirmed', 80),
    bk('t3', TID, 'early', 'ana', at(thu, '10:00'), 60, 'confirmed', 80),
    bk('t4', TID, 'gone', 'bo', at(thu, '15:00'), 60, 'cancelled', 80),
  ];
  T.deposits = [{ id: 'd1', tenant_id: TID, booking_id: 'nw1', amount: 40, status: 'paid' }, { id: 'd2', tenant_id: TID, booking_id: 'nw2', amount: 25, status: 'pending' },
    { id: 'dx', tenant_id: OTHER, booking_id: 'nw1', amount: 500, status: 'paid' }];
  T.blocked_slots = []; T.client_memories = []; T.conversations = []; T.messages = []; T.usage_events = []; T.telnyx_events = []; T.opt_outs = [];
  T.staff_schedules = []; T.staff_time_off = []; T.calls = []; T.booking_status_history = [];
}
reset();
const tenant = () => T.tenants[0];

// ── 1. The money helper ──
const nw = resolvePeriod('next_week', TZ);
ok(nw.from === nextMon && nw.to === nextSun && new Date(`${nw.from}T12:00:00Z`).getUTCDay() === 1, `next week = Monday–Sunday of next week (${nw.from} → ${nw.to})`);
ok(periodFromText("what's our total revenue locked in for next week") === 'next_week' && periodFromText('this weekend') === 'weekend' && periodFromText('next month') === 'next_month', 'phrases: next week / this weekend / next month');
const { runOwnerTool } = await import(P + 'lib/owner-tools.js');
let r = await runOwnerTool({ tenant: tenant(), name: 'revenue_report', args: { period: 'next_week' } });
ok(r.ok && r.booked_total === 300 && r.bookings === 3, `next week: only confirmed/arrived bookings, stylist prices, salon-tz days → $300 / 3 (got ${r.booked_total} / ${r.bookings})`);
ok(r.by_stylist?.find((s) => s.name === 'Ana')?.total === 200 && r.by_stylist?.find((s) => s.name === 'Bo')?.total === 100, 'by stylist: Ana $200, Bo $100');
ok(r.by_day?.length === 3 && r.deposits_collected === 40, `by day (3 days) + deposits collected $40 (pending and other-salon deposits ignored): ${r.deposits_collected}`);
ok(/Next week/.test(r.say) && /\$300/.test(r.say) && /locked in/.test(r.say), 'said plainly: ' + r.say);
r = await runOwnerTool({ tenant: tenant(), name: 'revenue_report', args: { from: nextMon, to: nextMon } });
ok(r.booked_total === 150 && r.bookings === 1, 'explicit from/to dates work');
r = await runOwnerTool({ tenant: tenant(), name: 'revenue_report', args: { period: 'month' } });
ok(r.ok && r.period === 'month' && 'change_pct' in r, 'the classic month-to-date report still works');

// ── 2. The app: "Lola, what's our total revenue locked in for next week?" ──
const { dashboardBrainReply } = await import(P + 'lib/dashboard-brain.js');
const say = async (text) => { const out = await dashboardBrainReply({ tenant: tenant(), body: { messages: [{ role: 'user', content: text }] } }); return { ...out.json, text: out.json.content?.[0]?.text || '' }; };
let a = await say("Lola, what's our total revenue locked in for next week?");
ok(a.intent === 'revenue_report' && /\$300/.test(a.text), 'app chat answers next week instantly: ' + a.text);

// ── 3. App: "Block off Thursday afternoon for maintenance" → plan → yes → block ──
a = await say('Block off Thursday afternoon for maintenance');
ok(a.intent === 'block_time' && a.needs_confirmation === true && T.blocked_slots.length === 0, 'block is previewed, nothing written yet');
ok(/12 PM to close \(7 PM\)/.test(a.text) && /whole salon/.test(a.text) && /maintenance/.test(a.text), 'the plan says what it blocks: ' + a.text);
ok(/2 clients are booked then: Maria 2 PM, Jo 4 PM/.test(a.text) && /Block anyway\?/.test(a.text) && /won't cancel/.test(a.text), 'clashing clients are listed (not the 10am, not the cancelled 3pm)');
a = await say('yes');
const blk = T.blocked_slots[0];
ok(T.blocked_slots.length === 1 && blk.tenant_id === TID && blk.staff_id === null && blk.blocked_date === thu && blk.start_time === '12:00' && blk.end_time === '19:00' && blk.reason === 'maintenance',
  `yes → one whole-salon block ${blk?.blocked_date} ${blk?.start_time}–${blk?.end_time} (${blk?.reason})`);
ok(['t1', 't2'].every((id) => T.bookings.find((b) => b.id === id).status === 'confirmed') && /nothing was cancelled/.test(a.text), 'Maria and Jo are still booked: ' + a.text);
a = await say('yes');
ok(T.blocked_slots.length === 1, 'a second "yes" never blocks twice');
const { blockedHitTz } = await import(P + 'lib/booking-repository.js');
const { db } = await import(P + 'lib/db.js');
ok(await blockedHitTz(db(), TID, 'ana', at(thu, '15:00'), at(thu, '16:00'), TZ) === thu && !(await blockedHitTz(db(), TID, 'ana', at(thu, '10:00'), at(thu, '11:00'), TZ)), 'the engine now refuses 3pm Thursday for anyone, 10am stays open');
// unblock
a = await say('remove the Thursday block');
ok(a.intent === 'unblock_time' && a.needs_confirmation && T.blocked_slots.length === 1, 'unblock is previewed: ' + a.text);
a = await say('yes');
ok(T.blocked_slots.length === 0 && /removed/.test(a.text), 'yes → block removed');
// a stylist's morning
a = await say("block Ana's Thursday morning for training");
ok(a.needs_confirmation && /Ana/.test(a.text) && /Early 10 AM/.test(a.text) && !/Jo/.test(a.text), "Ana's morning only lists Ana's clients: " + a.text);
a = await say('no');
ok(T.blocked_slots.length === 0 && /won't/i.test(a.text), '"no" drops it');

// ── 4. SMS from the owner's cell: plan → YES → block ──
const run = async (mod, body, extra = {}) => { const h = (await import(P + mod)).default; return new Promise((resolve) => { const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(o) { resolve({ status: this.statusCode, ...o }); }, end() { resolve({ status: this.statusCode }); }, send(o) { resolve({ status: this.statusCode, body: o }); } }; h({ method: 'POST', url: '/api/' + mod, headers: {}, query: {}, body, ...extra }, res); }); };
// Texts arrive as raw bytes signed with Telnyx's Ed25519 key (as on Vercel); unsigned = no TELNYX_PUBLIC_KEY.
const crypto = await import('node:crypto'); const { Readable } = await import('node:stream');
const ed = crypto.generateKeyPairSync('ed25519'); const PUB = ed.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
let evN = 0;
const sms = async (from, text, to = LINE, { signed = true } = {}) => {
  const raw = JSON.stringify({ data: { event_type: 'message.received', payload: { id: 'ev' + (++evN), from: { phone_number: from }, to: [{ phone_number: to }], text, type: 'SMS' } } });
  if (!signed) { delete process.env.TELNYX_PUBLIC_KEY; return run('telnyx-sms.js', JSON.parse(raw)); }
  process.env.TELNYX_PUBLIC_KEY = PUB;
  const ts = String(Math.floor(Date.now() / 1000));
  const req = Readable.from([Buffer.from(raw)]);
  Object.assign(req, { method: 'POST', url: '/api/telnyx-sms.js', headers: { 'content-type': 'application/json', 'telnyx-signature-ed25519': crypto.sign(null, Buffer.from(ts + '|' + raw), ed.privateKey).toString('base64'), 'telnyx-timestamp': ts }, query: {} });
  const h = (await import(P + 'telnyx-sms.js')).default;
  const out = await new Promise((resolve) => { const res = { statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(o) { resolve({ status: this.statusCode, ...o }); }, end() { resolve({ status: this.statusCode }); }, send(o) { resolve({ status: this.statusCode, body: o }); } }; h(req, res); });
  delete process.env.TELNYX_PUBLIC_KEY;
  return out;
};
texts.length = 0;
r = await sms(OWNER, 'Block off Thursday afternoon for maintenance');
let toOwner = texts.filter((t) => t.to === OWNER).map((t) => t.text).join(' | ');
ok(r.handled === 'owner_chat' && r.action === 'block_time' && r.needs_confirmation && T.blocked_slots.length === 0, 'owner text → a plan, nothing written yet');
ok(/Maria 2 PM, Jo 4 PM/.test(toOwner) && /Reply YES/.test(toOwner), 'the plan is texted back with the clashes: ' + toOwner);
texts.length = 0;
r = await sms(OWNER, 'YES');
toOwner = texts.filter((t) => t.to === OWNER).map((t) => t.text).join(' | ');
ok(T.blocked_slots.length === 1 && T.blocked_slots[0].start_time === '12:00' && T.blocked_slots[0].end_time === '19:00' && T.blocked_slots[0].staff_id === null && T.blocked_slots[0].blocked_date === thu, 'YES → the block is written');
ok(/Done/.test(toOwner) && !texts.some((t) => ['+13055551111', '+13055552222'].includes(t.to)), 'owner gets "Done"; clients are not texted or cancelled: ' + toOwner);
texts.length = 0;
r = await sms(OWNER, "what's our revenue locked in for next week?");
ok(/\$300/.test(texts.filter((t) => t.to === OWNER).map((t) => t.text).join(' ')) && r.action === 'revenue_report', 'reads answer immediately by text');
T.blocked_slots = [];

// ── 5. A non-owner texting the same gets no power ──
texts.length = 0;
r = await sms(CLIENT, 'Block off Thursday afternoon for maintenance');
ok(r.handled !== 'owner_chat' && T.blocked_slots.length === 0 && !T.client_memories.some((m) => m.client_phone === 'owner_pending' && m.value), 'a client texting the command: no plan parked, no block');
r = await sms(CLIENT, 'YES');
ok(T.blocked_slots.length === 0, '…and their YES blocks nothing');
// the owner's cell texting ANOTHER salon's line is just a client there
r = await sms(OWNER, 'Block off Thursday afternoon for maintenance', LINE2);
ok(r.handled !== 'owner_chat' && T.blocked_slots.length === 0, "the owner's cell on another salon's line has no owner powers there");
// a parked owner action can't be confirmed by someone else
await sms(OWNER, 'Block off Thursday afternoon for maintenance');
r = await sms(CLIENT, 'YES');
ok(T.blocked_slots.length === 0, "a client's YES never confirms the owner's parked block");
r = await sms(OWNER, 'no');
ok(T.blocked_slots.length === 0, 'owner says no → nothing');

// ── 6. The owner brain never claims an action it didn't take ──
llm = { content: "Done — I've blocked Thursday afternoon for you." };
texts.length = 0;
r = await sms(OWNER, 'should I take Thursday off to fix the dryer, what do you think?');
toOwner = texts.filter((t) => t.to === OWNER).map((t) => t.text).join(' ');
ok(!/I've blocked/.test(toOwner) && /haven't changed anything/.test(toOwner) && T.blocked_slots.length === 0, 'a claimed action is replaced with an honest offer: ' + toOwner);
llm = { content: 'Here to help.' };

// ── 6b. Review fixes ──
const pendingRow = () => T.client_memories.find((m) => m.client_phone === 'owner_pending' && m.value);
// (1) an UNSIGNED owner text (no TELNYX_PUBLIC_KEY) reads, but never acts
texts.length = 0;
r = await sms(OWNER, 'Block off Thursday afternoon for maintenance', LINE, { signed: false });
toOwner = texts.filter((t) => t.to === OWNER).map((t) => t.text).join(' ');
ok(r.handled === 'owner_chat' && !pendingRow() && T.blocked_slots.length === 0 && /add TELNYX_PUBLIC_KEY in Vercel/.test(toOwner), 'unsigned owner text: no plan parked, told to add the key: ' + toOwner);
texts.length = 0;
r = await sms(OWNER, "what's our revenue locked in for next week?", LINE, { signed: false });
toOwner = texts.filter((t) => t.to === OWNER).map((t) => t.text).join(' ');
ok(/\$300/.test(toOwner) && /TELNYX_PUBLIC_KEY/.test(toOwner), 'unsigned owner text still gets read answers, plus the one-line hint');
await sms(OWNER, 'Block off Thursday afternoon for maintenance');
r = await sms(OWNER, 'YES', LINE, { signed: false });
ok(T.blocked_slots.length === 0 && pendingRow(), "an unsigned (possibly forged) YES never confirms the owner's parked block");
// (2) only a bare yes/no confirms; replies flow on
r = await sms(OWNER, 'No, but street parking is free');
ok(pendingRow() && T.blocked_slots.length === 0, '"No, but street parking is free" is not a cancel (the plan is still parked)');
r = await sms(OWNER, 'ok');
ok(T.blocked_slots.length === 0 && pendingRow(), 'a bare "ok" never runs the parked action');
const { ownerCommandReply } = await import(P + 'lib/dashboard-brain.js');
ok(await ownerCommandReply({ tenant: tenant(), text: 'YES', channel: 'sms', sender: '+19995550000' }) === null && pendingRow(), 'a YES from a different sender cannot claim it');
a = await say('yes');
ok(T.blocked_slots.length === 0 && pendingRow(), "the app's yes doesn't run an action parked by text");
r = await sms(OWNER, 'Y 👍');
ok(T.blocked_slots.length === 1, 'bare "Y 👍" from the same cell confirms it');
T.blocked_slots = [];
a = await say('block Thursday morning for a meeting');
r = await sms(OWNER, 'YES');
ok(T.blocked_slots.length === 0 && pendingRow(), "a text YES doesn't run an action parked in the app");
a = await say('no');
ok(!pendingRow(), 'app "no" drops the app plan');
// during an open hot-lead relay, "No, but…" reaches the client
await sms(OWNER, 'Block off Thursday afternoon for maintenance');
T.conversations.push({ id: 'rl1', tenant_id: TID, channel: 'relay', status: 'open', started_at: new Date().toISOString(), metadata: { phone: CLIENT, name: 'Sam' } });
texts.length = 0;
r = await sms(OWNER, 'No, but street parking is free');
ok(r.handled === 'owner_relay' && texts.some((t) => t.to === CLIENT && /street parking/.test(t.text)) && pendingRow(), 'with a relay open, "No, but street parking is free" goes to the client');
r = await sms(OWNER, 'NO');
ok(!pendingRow() && T.blocked_slots.length === 0, 'a bare NO still answers Lola, even mid-relay');
T.conversations = T.conversations.filter((c) => c.channel !== 'relay');
// (3) past weekdays look back
const { routeOwnerIntent } = await import(P + 'lib/owner-intents.js');
const lastSat = routeOwnerIntent('how much did we make last saturday');
const ls = resolvePeriod(lastSat?.args?.period, TZ);
ok(lastSat?.args?.period === 'last saturday' && ls.from < today && new Date(`${ls.from}T12:00:00Z`).getUTCDay() === 6 && ls.from >= addDays(today, -7), 'last Saturday = the previous Saturday: ' + ls.from);
ok(routeOwnerIntent('how much did we make saturday')?.args?.period === 'last saturday' && routeOwnerIntent('revenue locked in saturday')?.args?.period === 'saturday', 'past tense looks back, "locked in" looks ahead');
// (4) block parsing
const iso = routeOwnerIntent(`block ${nextMon} afternoon`);
ok(iso.args.date === nextMon && iso.args.part === 'afternoon' && !iso.args.start && !iso.args.end, 'an ISO date is never read as a time');
const iso2 = routeOwnerIntent(`block ${nextMon} from 2 to 4pm`);
ok(iso2.args.start === '2' && iso2.args.end === '4pm', '…and a real range next to it still parses');
a = await say('block the 3pm for Maria');
ok(!pendingRow() && /until when/.test(a.text) && T.blocked_slots.length === 0, '"block the 3pm for Maria" asks, never blocks the whole day: ' + a.text);
a = await say('block off thursday');
ok(!pendingRow() && /morning, afternoon, all day/.test(a.text), 'no part or time → Lola asks which part');
// (5) the app model can't pre-confirm
llm = { content: null, tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'block_time', arguments: JSON.stringify({ date: 'thursday', part: 'afternoon', confirmed: true, plan: { date: thu, start_time: '08:00', end_time: '09:00', staff_id: null, reason: 'x', repeat_weeks: 1 } }) } }] };
a = await say('please make thursday afternoon unavailable for repairs');
ok(a.needs_confirmation && T.blocked_slots.length === 0 && pendingRow()?.value?.args?.plan?.start_time === '12:00', 'model-chosen confirmed/plan are stripped: previewed, the parked plan is the real one');
await say('no');
llm = { content: 'Here to help.' };
// (6) the Telnyx assistant learns the new owner tools
const { buildTools } = await import(P + 'operator-provision.js');
const names = buildTools({ slug: 'mma' }).map((x) => x.webhook.name);
const fr = buildTools({ slug: 'mma' }).find((x) => x.webhook.name === 'find_revenue');
ok(names.includes('block_time') && names.includes('unblock_time') && fr.webhook.body_parameters.properties.range.enum.includes('next_week'), 'operator assistant tools: block_time, unblock_time, find_revenue next_week');

// ── 7. Owner phone line: "revenue next week" is next week, and block needs the PIN ──
const { parseOperatorIntent } = await import(P + 'operator-voice.js');
const { OPERATOR_SKILLS } = await import(P + 'operator-tools.js');
let it = parseOperatorIntent("what's our revenue locked in for next week");
ok(it.tool === 'find_revenue' && it.args.range === 'next_week', 'operator voice: "next week" is detected before /week/');
ok(parseOperatorIntent('revenue this week').args.range === 'week', '"this week" stays week-to-date');
let v = await OPERATOR_SKILLS.find_revenue(tenant(), it.args);
ok(v.total === 300 && v.count === 3 && /Next week/.test(v.speak), 'find_revenue next_week → $300: ' + v.speak);
v = await OPERATOR_SKILLS.find_revenue(tenant(), { from: nextMon, to: nextSun });
ok(v.total === 300, 'find_revenue accepts from/to');
const voice = (speech, q = '') => run('operator-voice.js', { From: OWNER, To: '+18005550000', SpeechResult: speech, CallSid: 'c1' }, { url: '/api/operator-voice' + q });
const lastSaid = () => [...T.messages].reverse().find((m) => m.role === 'assistant')?.content || '';
r = await voice('Lola what is our revenue locked in for next week');
ok(r.status === 200 && /\$300/.test(lastSaid()) && /Next week/.test(lastSaid()), 'calling the owner line: revenue next week → ' + lastSaid());
it = parseOperatorIntent('block off thursday afternoon for maintenance');
ok(it.tool === 'block_time' && it.args.part === 'afternoon', 'operator voice parses block_time');
ok(parseOperatorIntent('cancel the thursday block').tool === 'unblock_time', '"cancel the thursday block" is an unblock, never a client cancel');
const { hashPin } = await import(P + 'lib/operator-db.js').then((m) => ({ hashPin: m.hashPin })).catch(() => ({}));
v = await OPERATOR_SKILLS.block_time(tenant(), it.args);
ok(v.needs_confirmation && v.confirm_token && /Maria 2 PM, Jo 4 PM/.test(v.speak) && /PIN/.test(v.speak) && T.blocked_slots.length === 0, 'phone: plan + clashes, waits for the PIN');
let w = await OPERATOR_SKILLS.block_time(tenant(), { ...it.args, confirm: true, pin: '1234', confirm_token: v.confirm_token });
ok(T.blocked_slots.length === 0 && /PIN/.test(w.speak), 'no PIN on file → nothing changes: ' + w.speak);
if (typeof hashPin === 'function') {
  T.tenants[0].operator_pin_hash = hashPin('1234');
  w = await OPERATOR_SKILLS.block_time(tenant(), { ...it.args, confirm: true, pin: '9999', confirm_token: v.confirm_token });
  ok(T.blocked_slots.length === 0, 'wrong PIN → nothing changes');
  w = await OPERATOR_SKILLS.block_time(tenant(), { ...it.args, confirm: true, pin: '1234', confirm_token: v.confirm_token });
  ok(T.blocked_slots.length === 1 && T.blocked_slots[0].start_time === '12:00' && T.blocked_slots[0].staff_id === null && /Done/.test(w.speak), 'right PIN → blocked: ' + w.speak);
  const u = await OPERATOR_SKILLS.unblock_time(tenant(), { date: 'thursday' });
  w = await OPERATOR_SKILLS.unblock_time(tenant(), { date: 'thursday', confirm: true, pin: '1234', confirm_token: u.confirm_token });
  ok(u.needs_confirmation && T.blocked_slots.length === 0, 'phone unblock with PIN');
  const other = await OPERATOR_SKILLS.block_time(T.tenants[1], { ...it.args, confirm: true, pin: '1234', confirm_token: v.confirm_token });
  ok(T.blocked_slots.length === 0 && /expired/.test(other.speak), "one salon's confirm token can't run on another salon");
}

if (fails) { console.log(`${fails} failing`); process.exit(1); }
console.log('ownercmd: all passed');
