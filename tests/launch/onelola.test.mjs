// One living Lola, everywhere: the phone, a text, an Instagram DM and the
// website chat reach the same Lola with the same memory ("Hey Sarah, welcome
// back! Loved the ash blonde from last month…") and the same hands — she
// really books, moves and cancels in the salon's calendar on every channel.
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'k';
process.env.INSTAGRAM_APP_ID = 'ig-app'; process.env.INSTAGRAM_APP_SECRET = 'ig-secret'; process.env.INSTAGRAM_VERIFY_TOKEN = 'verify-me';
delete process.env.TELNYX_PUBLIC_KEY; delete process.env.INTEGRATION_ENCRYPTION_KEY;
import crypto from 'node:crypto';
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const sms = [], dms = [], llmCalls = [];
let script = [];   // what the model says next, turn by turn
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  if (u.includes('chat/completions')) { const b = JSON.parse(init.body); llmCalls.push(b); const next = script.shift() || { content: 'Happy to help!' }; return J({ choices: [{ message: { role: 'assistant', content: next.content || null, tool_calls: next.tool_calls } }] }); }
  if (u.includes('/v2/messages')) { sms.push(JSON.parse(init.body)); return J({ data: { id: 'm' } }); }
  if (u.includes('graph.instagram.com') && u.includes('/me/messages')) { dms.push({ auth: init.headers.Authorization, ...JSON.parse(init.body) }); return J({ message_id: 'mid' }); }
  if (u.includes('graph.instagram.com') && /fields=name,username/.test(u)) return J({ name: 'Sarah Kim', username: 'sarahk' });
  return J({ data: [] });
};
const { T } = await import('./fake-supabase.mjs');
const P = new URL('../../api/', import.meta.url).href;
const TID = '00000000-0000-4000-8000-0000000000f1', DAY = 864e5, now = Date.now();
T.tenants = [{ id: TID, name: 'MMA Salon', slug: 'mma', subscription_status: 'active', phone_number: '+13055550100', services: [{ name: 'Ash blonde', price: 220, duration: 150 }, { name: 'Blowout', price: 65, duration: 45 }] }];
T.tenant_numbers = [{ tenant_id: TID, phone_number: '+13055550100', kind: 'primary', status: 'active' }];
T.booking_settings = [{ tenant_id: TID, timezone: 'America/New_York', slot_interval_minutes: 30, minimum_notice_minutes: 0, booking_horizon_days: 90, default_buffer_before_min: 0, default_buffer_after_min: 0 }];
T.clients = [{ id: 'sarah', tenant_id: TID, first_name: 'Sarah', last_name: 'Kim', phone: '+13055554444' }];
T.staff = [{ id: 'st1', tenant_id: TID, name: 'Ana Ruiz', is_active: true }];
T.staff_services = []; T.staff_schedules = []; for (let d = 0; d < 7; d++) T.staff_schedules.push({ tenant_id: TID, staff_id: 'st1', day_of_week: d, start_time: '09:00', end_time: '18:00' });
T.staff_time_off = []; T.blocked_slots = []; T.availability_holds = []; T.locations = []; T.business_hours = [];
T.services = [{ id: 's1', tenant_id: TID, name: 'Ash blonde', price: 220, duration_minutes: 150, is_active: true }, { id: 's2', tenant_id: TID, name: 'Blowout', price: 65, duration_minutes: 45, is_active: true }];
T.bookings = [{ id: 'old', tenant_id: TID, client_id: 'sarah', service_id: 's1', staff_id: 'st1', status: 'completed', service: { name: 'Ash blonde' }, start_time: new Date(now - 33 * DAY).toISOString(), end_time: new Date(now - 33 * DAY + 9e6).toISOString() }];
T.client_memories = []; T.conversations = []; T.messages = []; T.usage_events = []; T.opt_outs = []; T.calls = []; T.call_sessions = []; T.booking_reminders = []; T.tenant_channels = [];
const run = async (mod, req) => { const h = (await import(P + mod)).default; return new Promise((resolve) => { const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(o) { resolve({ status: this.statusCode, ...o }); }, send(t) { resolve({ status: this.statusCode, text: t }); }, end(t) { resolve({ status: this.statusCode, text: t, headers: this.headers }); } }; h({ method: 'POST', url: '/api/' + mod, headers: {}, query: {}, ...req }, res); }); };
const { db } = await import(P + 'lib/db.js');

// ── 1. Her memory ──
const { clientStory, welcomeBack, agoWords } = await import(P + 'lib/client-brain.js');
const story = await clientStory(db(), T.tenants[0], T.clients[0]);
ok(story.known && story.first === 'Sarah' && story.last.service === 'Ash blonde' && story.last.stylist === 'Ana' && story.last.ago === 'last month', 'she knows Sarah: ' + story.brief);
const hi = welcomeBack(story);
ok(hi === 'Hey Sarah, welcome back! Loved the ash blonde from last month — are we refreshing your roots or going for a blowout today?', 'the welcome: ' + hi);
ok(agoWords(new Date(now - 10 * DAY).toISOString(), now) === 'last week' && agoWords(new Date(now - 100 * DAY).toISOString(), now) === '3 months ago', 'time said like a person');
ok(welcomeBack(await clientStory(db(), T.tenants[0], { id: 'x', first_name: 'Client', phone: '+1305' })) === '', 'a stranger gets no fake familiarity');

// ── 2. The phone: her first words are personal, with the notice ──
const { toolKey } = await import(P + 'lib/tool-key.js');
let r = await run('agent-variables.js', { url: '/api/agent-variables?k=' + toolKey('variables'), body: { data: { payload: { telnyx_agent_target: '+13055550100', telnyx_end_user_target: '+13055554444' } } } });
const g = r.dynamic_variables?.lola_greeting || '';
ok(/^Hey Sarah, welcome back to MMA Salon!/.test(g) && /may be recorded/.test(g) && /AI assistant/.test(g) && /ash blonde from last month/.test(g), 'Sarah calls → ' + g);
r = await run('agent-variables.js', { url: '/api/agent-variables?k=' + toolKey('variables'), body: { data: { payload: { telnyx_agent_target: '+13055550100', telnyx_end_user_target: '+17865550000' } } } });
ok(/^Thanks for calling MMA Salon!/.test(r.dynamic_variables.lola_greeting) && /may be recorded/.test(r.dynamic_variables.lola_greeting), 'a new caller → ' + r.dynamic_variables.lola_greeting);
r = await run('lola-tools.js', { query: { tool: 'recall_client', salon: '+13055550100' }, body: { client_phone: '(305) 555-4444' } });
ok(/^Hey Sarah, welcome back/.test(r.speak), 'website chat / hidden caller ID: she recognises Sarah from her number');

// ── 3. A text: welcome + she REALLY books ──
const day = new Date(now + 2 * DAY).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
script = [
  { tool_calls: [{ id: 't1', type: 'function', function: { name: 'book_appointment', arguments: JSON.stringify({ service: 'Blowout', date: day, time: '11:00am' }) } }] },
  { content: 'Hey Sarah, welcome back! You’re booked for a Blowout at 11am — see you then!' },
];
const before = T.bookings.length;
await run('telnyx-sms.js', { body: { data: { event_type: 'message.received', payload: { from: { phone_number: '+13055554444' }, to: [{ phone_number: '+13055550100' }], text: `Can I get a blowout ${day} at 11?`, type: 'SMS' } } } });
const sys = llmCalls[0]?.messages?.[0]?.content || '';
ok(/OPEN WITH THIS WELCOME/.test(sys) && /Sarah/.test(sys) && Array.isArray(llmCalls[0]?.tools) && llmCalls[0].tools.some(t => t.function.name === 'reschedule_appointment'), 'texting Lola gets Sarah’s memory and her booking hands');
const nb = T.bookings.slice(before).find(b => b.client_id === 'sarah');
ok(nb && nb.status !== 'cancelled', 'the booking is really in the calendar');
ok(sms.at(-1)?.to === '+13055554444' && /booked for a Blowout/.test(sms.at(-1).text), 'and she texts back: ' + sms.at(-1)?.text);
ok(llmCalls[1]?.messages?.some(m => m.role === 'tool' && /"booked":true/.test(m.content)), 'she only says “booked” after the calendar said so');

// ── 4. Instagram: connect, verify, DM → same Lola, same memory ──
const ig = await import(P + 'lib/instagram-dm.js');
const st = ig.signState(TID);
ok(ig.readState(st) === TID && ig.readState(st.slice(0, -1) + (st.endsWith('a') ? 'b' : 'a')) === null, 'the connect link can’t be forged');
ok(/instagram\.com\/oauth\/authorize/.test(ig.authUrl(TID)) && /instagram_business_manage_messages/.test(decodeURIComponent(ig.authUrl(TID))), 'connect goes to Instagram with the DM permission');
r = await run('instagram.js', { method: 'GET', url: '/api/instagram?error=access_denied&state=' + st });
ok(r.status === 302 && r.headers.Location === '/settings?instagram=cancelled', 'Instagram sends the owner back to Settings (exact redirect URI, no query string)');
ok(ig.redirectUri() === 'https://www.loladesk.com/api/instagram', 'redirect URI to register with Meta: ' + ig.redirectUri());
r = await run('instagram.js', { method: 'GET', url: '/api/instagram?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42' });
ok(r.text === '42', 'Meta’s webhook check passes');
T.tenant_channels = [{ tenant_id: TID, channel: 'instagram', account_id: 'IG-SALON', username: 'mmasalon', access_token: 'plain:tok-1', status: 'active' }];
const dm = (text, sender = 'IG-SARAH') => ({ object: 'instagram', entry: [{ id: 'IG-SALON', messaging: [{ sender: { id: sender }, recipient: { id: 'IG-SALON' }, message: { mid: 'm' + Math.random(), text } }] }] });
let raw = JSON.stringify(dm('hi! do you have time saturday?'));
r = await run('instagram.js', { url: '/api/instagram', headers: { 'x-hub-signature-256': 'sha256=bad' }, body: raw });
ok(r.status === 401, 'an unsigned DM is refused');
script = [{ content: 'Hi Sarah! Saturday works — morning or afternoon?' }];
const sig = (b) => 'sha256=' + crypto.createHmac('sha256', 'ig-secret').update(b).digest('hex');
r = await run('instagram.js', { url: '/api/instagram', headers: { 'x-hub-signature-256': sig(raw) }, body: raw });
ok(r.ok && dms.at(-1)?.recipient?.id === 'IG-SARAH' && dms.at(-1).auth === 'Bearer tok-1' && /Saturday works/.test(dms.at(-1).message.text), 'a DM gets Lola’s answer, from the salon’s Instagram');
const igc = T.clients.find(c => c.phone === 'ig:IG-SARAH');
ok(igc && igc.first_name === 'Sarah' && T.conversations.some(c => c.channel === 'instagram' && c.client_id === igc.id), 'the DM thread lands in the salon’s inbox under Sarah');
script = [{ content: 'Got you, Sarah! Welcome back.' }];
raw = JSON.stringify(dm('my number is 305-555-4444'));
await run('instagram.js', { url: '/api/instagram', headers: { 'x-hub-signature-256': sig(raw) }, body: raw });
const lastSys = llmCalls.at(-1).messages[0].content;
ok(/Ash blonde/.test(lastSys) && /last visit/.test(lastSys), 'she gives her number → Instagram Sarah IS phone Sarah: same memory');
ok(T.clients.find(c => c.phone === 'ig:IG-SARAH').notes === 'linked:+13055554444', 'linked for good');
raw = JSON.stringify({ object: 'instagram', entry: [{ id: 'IG-SALON', messaging: [{ sender: { id: 'IG-SALON' }, recipient: { id: 'IG-SARAH' }, message: { text: 'echo', is_echo: true } }] }] });
const n = dms.length; await run('instagram.js', { url: '/api/instagram', headers: { 'x-hub-signature-256': sig(raw) }, body: raw });
ok(dms.length === n, 'her own messages never trigger a reply loop');
const { replyAsSalon } = ig;
const rr = await replyAsSalon(db(), TID, igc.id, 'See you Saturday! — Ana');
ok(rr.ok && dms.at(-1).message.text === 'See you Saturday! — Ana', 'the owner can reply to the DM from the LolaDesk inbox');

// ── 5. One question, answered: is Lola taking care of my business right now? ──
const { lolaPulse } = await import(P + 'lola/pulse.js');
let pz = await lolaPulse(db(), T.tenants[0]);
ok(pz.live && /^Lola is answering · /.test(pz.headline) && /booked today/.test(pz.headline) && /nothing needs you$/.test(pz.headline), 'the dashboard line: ' + pz.headline);
pz = await lolaPulse(db(), { ...T.tenants[0], id: 'nobody', phone_number: null });
ok(!pz.live && /isn’t answering yet/.test(pz.headline) && pz.action.href === '/settings#phone', 'no line → it says so, with the fix: ' + pz.headline);
const dash = (await import('node:fs')).readFileSync(new URL('../../dashboard.html', import.meta.url), 'utf8');
ok(/id="lolaPulse"/.test(dash) && /\/api\/lola\/pulse/.test(dash) && !/part of the team and ready/.test(dash), 'the dashboard shows it live (refreshing every 30s)');

// ── 6. Nothing we built is ever taken away ──
const KEEP = ['404', 'activation-studio', 'admin', 'banking-payments', 'banking-policies', 'banking', 'book', 'booking-integrity', 'booking-settings', 'bookings', 'brain-os', 'calendar', 'calls', 'campaigns', 'client', 'clients', 'dashboard', 'growth-os', 'inbox', 'index', 'inventory', 'launch', 'login', 'lola-live', 'marketer', 'numbers', 'oauth-callback', 'onboarding', 'operations-os', 'operator', 'paid', 'pos', 'pricing', 'privacy', 'reset', 'revenue', 'reviews', 'services', 'settings', 'subscription', 'team', 'telecom', 'terms'];
const fsx = await import('node:fs');
const missing = KEEP.filter((p) => !fsx.existsSync(new URL('../../' + p + '.html', import.meta.url)));
ok(!missing.length, `every page we built is still here (${KEEP.length} pages)` + (missing.length ? ' — missing: ' + missing.join(', ') : ''));

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
