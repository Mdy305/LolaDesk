// Lola as the owner's chief of staff: she already knows the business onboarding synced (live menu,
// team, hours, Google) and the day (money locked in, next client, who needs a call back, the biggest
// opening), answers number-first, and offers the one move. Stale tenant-row copies never win.
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'k';
delete process.env.TELNYX_PUBLIC_KEY;
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const prompts = []; let llm = { content: 'On it.' };
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const J = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
  if (u.includes('chat/completions')) { const b = JSON.parse(init.body || '{}'); prompts.push(b); return J({ choices: [{ message: llm }] }); }
  if (u.includes('/messages')) return J({ data: { id: 'm1' } });
  return J({});
};
const { T } = await import('./fake-supabase.mjs');
const P = new URL('../../api/', import.meta.url).href;
const { localDateKey, zonedLocalToUtc } = await import(P + 'lib/timezone.js');
const A = await import(P + 'lib/owner-awareness.js');
const TID = '00000000-0000-4000-8000-0000000000e1', OTHER = '00000000-0000-4000-8000-0000000000e2', TZ = 'America/New_York';
const at = (key, hm) => zonedLocalToUtc(key, hm + ':00', TZ);
const addDays = (key, n) => { const [y, m, d] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const today = localDateKey(new Date(), TZ), tom = addDays(today, 1);
const week = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: '09:00', close: '19:00', closed: false }]));
const learnedAt = new Date().toISOString();
globalThis.__authUsers = { tok: { id: 'u1', email: 'm@mmasalon.com' } };

function reset() {
  T.tenants = [{ id: TID, name: 'MMA Salon', slug: 'mma', owner_name: 'Meddy Jerome', owner_email: 'm@mmasalon.com', phone_number: '+13055550100', subscription_status: 'active',
    services: [{ name: 'Old Placeholder', price: 1 }], team: [{ name: 'Ghost' }], hours: 'stale hours',
    knowledge: JSON.stringify({ booking_system: 'Boulevard', learned: { at: learnedAt, services: 3, team: 2 },
      google: { rating: 4.9, reviews_count: 212, address: '1500 Alton Rd', competitors: [{ name: 'Rival Salon', rating: 4.6, reviews_count: 90 }], reviews: [] } }) },
    { id: OTHER, name: 'Other', slug: 'other', subscription_status: 'active' }];
  T.tenant_users = [{ user_id: 'u1', tenant_id: TID, role: 'owner', status: 'active' }];
  T.booking_settings = [{ tenant_id: TID, timezone: TZ, business_hours: week, metadata: {} }];
  T.services = [
    { id: 'bal', tenant_id: TID, name: 'Balayage', price: 250, duration_minutes: 120, is_active: true },
    { id: 'cut', tenant_id: TID, name: 'Cut', price: 80, duration_minutes: 60, is_active: true },
    { id: 'ton', tenant_id: TID, name: 'Toner', price: 0, duration_minutes: 30, is_active: true },
    { id: 'old', tenant_id: TID, name: 'Retired Perm', price: 99, duration_minutes: 60, is_active: false },
    { id: 'osv', tenant_id: OTHER, name: 'Other Service', price: 10, duration_minutes: 30, is_active: true }];
  T.staff = [{ id: 'ana', tenant_id: TID, name: 'Ana', role: 'Colorist', is_active: true }, { id: 'bo', tenant_id: TID, name: 'Bo', is_active: true }, { id: 'zed', tenant_id: OTHER, name: 'Zed', is_active: true }];
  T.clients = [{ id: 'maria', tenant_id: TID, name: 'Maria Lopez', phone: '+13055551111' }, { id: 'jo', tenant_id: TID, name: 'Jo Park', phone: '+13055552222' },
    { id: 'early', tenant_id: TID, name: 'Early Bird', phone: '+13055553333' }];
  const bk = (id, client, staff, svc, key, hm, mins, status, amt, tenant = TID) => ({ id, tenant_id: tenant, client_id: client, staff_id: staff, service_id: svc, start_time: at(key, hm), end_time: new Date(Date.parse(at(key, hm)) + mins * 60e3).toISOString(), status, total_amount: amt, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' });
  T.bookings = [
    bk('m1', 'maria', 'ana', 'bal', today, '14:00', 120, 'confirmed', 250),
    bk('j1', 'jo', 'bo', 'cut', today, '09:00', 60, 'completed', 80),
    bk('x1', 'jo', 'bo', 'cut', today, '12:00', 60, 'cancelled', 80),
    bk('e1', 'early', 'ana', 'cut', tom, '10:00', 60, 'confirmed', 80),
    bk('e2', 'jo', 'bo', 'bal', tom, '11:00', 120, 'confirmed', 250),
    bk('o1', 'maria', 'zed', 'osv', today, '15:00', 60, 'confirmed', 999, OTHER)];
  T.booking_reminders = [{ id: 'r1', booking_id: 'e2', status: 'confirmed' }];
  T.calls = [{ id: 'k1', tenant_id: TID, direction: 'inbound', status: 'missed', from_number: '+13055552222', created_at: new Date(Date.now() - 3600e3).toISOString() }];
  T.client_memories = []; T.conversations = []; T.messages = []; T.usage_events = []; T.agent_runs = []; T.deposits = []; T.staff_services = [];
  A._resetAwareness();
}

// 1) The hours read like a person says them
ok(A.hoursText({ mon: { closed: true }, tue: { open: '10:00', close: '19:00' }, wed: { open: '10:00', close: '19:00' }, thu: { open: '10:00', close: '19:00' }, fri: { open: '10:00', close: '19:00' }, sat: { open: '09:00', close: '17:30' }, sun: { closed: true } })
  === 'Tue–Fri 10am–7pm · Sat 9am–5:30pm · Mon & Sun closed', 'hours: ' + A.hoursText({ mon: { closed: true }, tue: { open: '10:00', close: '19:00' }, wed: { open: '10:00', close: '19:00' }, thu: { open: '10:00', close: '19:00' }, fri: { open: '10:00', close: '19:00' }, sat: { open: '09:00', close: '17:30' }, sun: { closed: true } }));

// 2) The snapshot is the live setup, not the stale tenant row
reset();
const tenant = T.tenants[0];
const snap = await A.businessSnapshot(tenant);
ok(snap.services.map((s) => s.name).join(',') === 'Balayage,Cut,Toner', 'menu = live services (active only, this salon only): ' + snap.services.map((s) => s.name));
ok(snap.staff.map((s) => s.name).join(',') === 'Ana,Bo', 'team = live staff');
ok(snap.hours === 'Mon–Sun 9am–7pm', 'hours from the booking calendar: ' + snap.hours);
ok(/Google: 4\.9★ from 212 reviews/.test(snap.prompt) && /Rival Salon 4\.6★ \(90\)/.test(snap.prompt), 'Google rating + competitor in her knowledge');
ok(/Toner \(no price yet\)/.test(snap.prompt) && snap.gaps.some((g) => g.key === 'prices'), 'the unpriced service is known as a gap');
ok(!/Old Placeholder|Ghost|stale hours|Retired Perm|Other Service/.test(snap.prompt), 'no stale, archived or other-salon data');
const hyd = A.hydrateTenant(tenant, snap);
ok(hyd.services.length === 3 && hyd.services[0].name === 'Balayage' && hyd.team[0].name === 'Ana' && tenant.services[0].name === 'Old Placeholder', 'older fast paths get the real menu (the row itself untouched)');

// 3) Right now, at 11am salon time
const eleven = new Date(at(today, '11:00'));
const s = await A.situation(tenant, { snap, now: eleven, fresh: true });
ok(s.today.count === 2 && s.today.total === 330, `today: ${s.today.count} clients, $${s.today.total} (cancelled excluded)`);
ok(s.today.next && s.today.next.client === 'Maria Lopez' && s.today.next.time === '2pm' && s.today.next.service === 'Balayage', 'next client: Maria at 2pm for Balayage');
ok(s.tomorrow.count === 2 && s.tomorrow.total === 330 && s.unconfirmed === 1, 'tomorrow: 2, $330, 1 not confirmed (the YES one counts)');
ok(s.needs.length === 1 && s.needs[0].name === 'Jo', 'Jo missed → needs a call back');
ok(s.opening && s.opening.stylist === 'Bo' && s.opening.start === 11 * 60 + 30 && s.opening.end === 19 * 60, 'biggest opening: Bo 11:30am–7pm');
ok(/Jo called and I missed them\. Want me to call Jo back\?/.test(s.oneMove.say), 'one move = call Jo back: ' + s.oneMove.say);
ok(/Today: 2 clients, \$330 locked in; next: Maria Lopez at 2pm \(Balayage\) with Ana/.test(s.prompt), 'RIGHT NOW block has the exact numbers');

// 4) After closing, she leads with tomorrow
A._resetAwareness();
const late = await A.situation(tenant, { now: new Date(at(today, '19:15')), fresh: true });
ok(late.closedNow && late.focusDay === 'tomorrow' && late.opening && late.opening.stylist === 'Ana' && late.opening.start === 11 * 60 && late.opening.end === 19 * 60, 'after hours → tomorrow; Ana free 11am–7pm');

// 5) "Catch me up" in the app = the chief-of-staff briefing, number first
reset();
const run = async (body) => { const h = (await import(P + 'lola.js')).default; return new Promise((resolve) => { const res = { statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(o) { resolve({ status: this.statusCode, ...o }); }, end() { resolve({ status: this.statusCode }); } }; h({ method: 'POST', url: '/api/lola', headers: { authorization: 'Bearer tok' }, query: {}, body }, res); }); };
const words = (r) => r.content?.[0]?.text || '';
prompts.length = 0;
let r = await run({ messages: [{ role: 'user', content: 'catch me up' }], channel: 'dashboard' });
ok(r.status === 200 && r.intent === 'today_brief' && prompts.length === 0, 'catch me up → instant briefing, no model');
ok(/I've synced your setup: 3 services, 2 stylists, your hours, 4\.9 stars on Google\./.test(words(r)), 'fresh onboarding is announced as synced: ' + words(r).slice(0, 110));
ok(/\$\d/.test(words(r)) && /locked in/.test(words(r)) && /Want me to call Jo back\?/.test(words(r)), 'money + the one move: ' + words(r));
const logged = T.messages.length;
r = await run({ messages: [{ role: 'user', content: 'catch me up' }], channel: 'dashboard', voice: true, silent: true });
ok(r.intent === 'today_brief' && words(r).length > 20, 'the hello when the owner arrives is the same briefing');
ok(T.messages.length === logged, 'her hello is not logged as your conversation');

// 6) Everything else: the model sees who she is, the business and the day
reset(); prompts.length = 0; llm = { content: 'Two balayages tomorrow — $500.' };
r = await run({ messages: [{ role: 'user', content: 'how is the balayage business looking' }], channel: 'dashboard' });
const sys = (prompts[0]?.messages || []).find((m) => m.role === 'system')?.content || '';
ok(/chief of staff/.test(sys) && /Meddy's/.test(sys) && /Answer first/.test(sys), 'chief-of-staff voice, by name');
ok(/THE BUSINESS/.test(sys) && /Balayage \$250 120min/.test(sys) && /Team \(2\): Ana \(Colorist\), Bo/.test(sys), 'the live menu and team');
ok(/RIGHT NOW/.test(sys) && /Tomorrow: 2 clients, \$330 locked in/.test(sys), 'the day, in numbers');
ok(!/Old Placeholder|Ghost/.test(sys), 'never the stale copies');

// 7) A menu edit shows up on her next word
reset();
await A.businessSnapshot(T.tenants[0]);
T.services.push({ id: 'gls', tenant_id: TID, name: 'Gloss', price: 65, duration_minutes: 30, is_active: true });
ok(!(await A.businessSnapshot(T.tenants[0])).services.some((x) => x.name === 'Gloss'), '(cached within a turn burst)');
A.forgetTenant(TID);
ok((await A.businessSnapshot(T.tenants[0])).services.some((x) => x.name === 'Gloss'), 'after an edit she sees the new service');

// 8) By text from the owner's cell
reset();
const { ownerCommandReply } = await import(P + 'lib/dashboard-brain.js');
const sms = await ownerCommandReply({ tenant: T.tenants[0], text: 'catch me up', channel: 'sms', sender: '+17865550199', readOnly: true });
ok(sms && sms.intent === 'today_brief' && /locked in/.test(sms.say), 'texting "catch me up" gets the same briefing (read-only is fine): ' + (sms?.say || '').slice(0, 80));

// 9) A brand-new salon: she says what's missing instead of inventing
T.tenants = [{ id: OTHER, name: 'Fresh', slug: 'fresh', subscription_status: 'active' }]; T.services = []; T.staff = []; T.booking_settings = []; T.bookings = []; T.calls = [];
A._resetAwareness();
const empty = await A.businessSnapshot(T.tenants[0]);
ok(empty.gaps.map((g) => g.key).join(',') === 'menu,hours,line,google', 'new salon gaps: ' + empty.gaps.map((g) => g.key));
const eb = await A.chiefBrief(T.tenants[0], { now: new Date(at(today, '11:00')) });
ok(eb && /nothing booked yet/.test(eb.say) && /send me your website/.test(eb.say), 'new salon brief: ' + (eb?.say || ''));

console.log(fails ? `\n${fails} FAILED` : '\nall chief-of-staff checks pass');
process.exit(fails ? 1 : 0);
