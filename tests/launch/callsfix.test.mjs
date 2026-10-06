// Calls, texts and Lola's tools — the production defects fixed together:
// privacy on chat channels, signed webhooks/tools, honest booking answers, one calls row per call,
// a voice that can't hang the line, one text-back a day, and the paid-service gate + cost hooks.
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'k';
process.env.ELEVENLABS_API_KEY = 'el'; process.env.ELEVENLABS_VOICE_ID = 'lolaVoice'; process.env.APP_URL = 'https://www.loladesk.com';
delete process.env.TELNYX_PUBLIC_KEY; delete process.env.VOICE_PROVIDER; delete process.env.LOLA_TOOL_SECRET;
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const sms = [], llm = [];
let script = [], ttsMode = 'ok', smsMode = 'ok';
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  if (u.includes('chat/completions')) {
    const b = JSON.parse(init.body); llm.push(b);
    const next = script.shift() || { content: 'Happy to help!' };
    if (next.status) return J({ error: { message: next.error || 'bad request' } }, next.status);
    return J({ choices: [{ message: { role: 'assistant', content: next.content || null, tool_calls: next.tool_calls } }] });
  }
  if (u.includes('/text-to-speech/')) {
    if (ttsMode === 'hang') return new Promise((_, rej) => { init.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))); });
    return new Response(new Uint8Array(1200), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  }
  if (u.includes('fake.supabase.co/storage') && init.method === 'HEAD') return new Response(null, { status: 404 });
  if (u.includes('/v2/messages')) {
    if (smsMode === 'refuse') return J({ errors: [{ detail: '10DLC campaign not active' }] }, 400);
    sms.push(JSON.parse(init.body)); return J({ data: { id: 'm' + sms.length } });
  }
  return J({ data: [] });
};
const { T } = await import('./fake-supabase.mjs');
const P = new URL('../../api/', import.meta.url).href;
const TID = '00000000-0000-4000-8000-0000000000c1', TZ = 'America/New_York', DAY = 864e5;
const LINE = '+13055550100', SARAH = '+13055554444', MALLORY = '+17865550111';
const day = new Date(Date.now() + 3 * DAY).toLocaleDateString('en-CA', { timeZone: TZ });
function reset() {
  T.tenants = [{ id: TID, name: 'MMA Salon', slug: 'mma', subscription_status: 'active', status: 'active', plan: 'pro', phone_number: LINE, timezone: TZ, services: [{ name: 'Haircut', price: 60, duration: 60 }, { name: 'Blowout', price: 40, duration: 30 }] }];
  T.tenant_numbers = [{ tenant_id: TID, phone_number: LINE, kind: 'primary', status: 'active' }];
  T.booking_settings = [{ tenant_id: TID, timezone: TZ, slot_interval_minutes: 15, minimum_notice_minutes: 0, booking_horizon_days: 90, default_buffer_before_min: 0, default_buffer_after_min: 0, metadata: {} }];
  T.services = [{ id: 'cut', tenant_id: TID, name: 'Haircut', duration_minutes: 60, price: 60, is_active: true }, { id: 'blow', tenant_id: TID, name: 'Blowout', duration_minutes: 30, price: 40, is_active: true }];
  T.staff = [{ id: 'ana', tenant_id: TID, name: 'Ana Ruiz', is_active: true }]; T.staff_services = []; T.staff_schedules = [];
  for (let d = 0; d < 7; d++) T.staff_schedules.push({ tenant_id: TID, staff_id: 'ana', day_of_week: d, start_time: '09:00', end_time: '18:00' });
  T.clients = [{ id: 'sarah', tenant_id: TID, first_name: 'Sarah', last_name: 'Kim', name: 'Sarah Kim', phone: SARAH }];
  for (const k of ['staff_time_off', 'blocked_slots', 'bookings', 'availability_holds', 'locations', 'business_hours', 'cached_availability', 'provider_mappings', 'booking_outbox', 'integrations', 'client_memories', 'usage_events', 'deposits', 'tenant_channels', 'opt_outs', 'call_sessions', 'calls', 'conversations', 'messages', 'telnyx_events', 'booking_reminders', 'platform_settings']) T[k] = [];
}
reset();
const at = (hm) => { const { zonedLocalToUtc } = TZM; return zonedLocalToUtc(day, hm + ':00', TZ); };
const TZM = await import(P + 'lib/timezone.js');
const { db } = await import(P + 'lib/db.js');
const run = async (mod, req) => { const h = (await import(P + mod)).default; return new Promise((resolve) => { const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(o) { resolve({ status: this.statusCode, ...o }); }, send(t) { resolve({ status: this.statusCode, text: String(t) }); }, end(t) { resolve({ status: this.statusCode, text: t }); } }; h({ method: 'POST', url: '/api/' + mod, headers: {}, query: {}, ...req }, res); }); };
const { toolKey } = await import(P + 'lib/tool-key.js');
const costs = []; let gateAnswer = { ok: true };
globalThis.__lolaPaidHooks = { serviceAllowed: async () => gateAnswer, logCost: async (tenantId, kind, cents, meta) => { costs.push({ tenantId, kind, cents, meta }); } };

// ── 1. Website chat / Instagram can't act on a booking by a typed number ──
const { answerClient, PRIVACY_SPEAK } = await import(P + 'lib/client-brain.js');
T.bookings.push({ id: 'bk-sarah', tenant_id: TID, client_id: 'sarah', service_id: 'cut', staff_id: 'ana', status: 'confirmed', start_time: at('14:00'), end_time: at('15:00') });
for (const tool of ['cancel_appointment', 'reschedule_appointment', 'confirm_booking']) {
  script = [{ tool_calls: [{ id: 'x1', type: 'function', function: { name: tool, arguments: JSON.stringify({ client_phone: SARAH, new_date: day, new_time: '4pm' }) } }] }, { content: 'Okay!' }];
  const out = await answerClient({ tenant: T.tenants[0], channel: 'web', text: 'cancel my appointment, my number is 305 555 4444', phone: null, memoryKey: 'web:v1', tz: TZ });
  const res = out.actions[0]?.result || {};
  ok(res.speak === PRIVACY_SPEAK && res.verified === false, `website chat: ${tool} with a typed number is refused with the privacy message`);
}
const bk = T.bookings.find((b) => b.id === 'bk-sarah');
ok(bk.status === 'confirmed' && bk.start_time === at('14:00'), 'Sarah’s booking is untouched by a stranger in the chat');
script = [{ tool_calls: [{ id: 'x2', type: 'function', function: { name: 'cancel_appointment', arguments: '{}' } }] }, { content: 'Done — it is cancelled.' }];
let out = await answerClient({ tenant: T.tenants[0], channel: 'sms', text: 'please cancel', phone: SARAH, tz: TZ });
ok(out.actions[0]?.result?.cancelled === true && /Haircut on .+ at 2 PM is cancelled/.test(out.actions[0].result.speak), 'from her own texting line it works, and says what was cancelled: ' + out.actions[0]?.result?.speak);
ok(costs.some((c) => c.kind === 'cost_ai' && c.tenantId === TID && c.cents === 1), 'each answered turn logs its AI cost');

// ── 9. Tools dropped by Telnyx: no invented times ──
script = [{ status: 400, error: 'tools not supported' }, { content: 'Sure! I have 2pm or 4pm open tomorrow — which works?' }];
out = await answerClient({ tenant: T.tenants[0], channel: 'sms', text: 'any time tomorrow for a haircut?', phone: SARAH, tz: TZ });
ok(out.toolsDropped === true && !/2pm|4pm/.test(out.reply) && /nothing is booked/.test(out.reply), 'tools dropped → she says honestly she can’t check yet: ' + out.reply);
script = [{ status: 400, error: 'tools not supported' }, { content: 'We are at 1 Ocean Drive.' }];
out = await answerClient({ tenant: T.tenants[0], channel: 'sms', text: 'where are you located?', phone: SARAH, tz: TZ });
ok(out.reply === 'We are at 1 Ocean Drive.', 'a plain question is still answered normally');

// ── 3/4/5. Lola's tools over HTTP ──
reset();
const tools = (await import(P + 'lola-tools.js')).default;
const { SKILLS, resolveDateKey } = await import(P + 'lola-tools.js');
const callTool = (query, body) => new Promise((resolve) => { const res = { statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(o) { resolve(o); }, end() { resolve({}); } }; tools({ method: 'POST', query, headers: {}, body }, res); });
const smsAtUnsigned = sms.length;
let r = await callTool({ tool: 'book_appointment', to: LINE, from: MALLORY }, { service: 'Haircut', date: day, time: '10am', client_name: 'Mal Lory', client_phone: '3055550999', no_email: true });
ok(r.booked === false && r.error === 'unsigned' && T.bookings.length === 0 && sms.length === smsAtUnsigned, 'unsigned book_appointment books nothing and texts nobody: ' + r.speak);
r = await callTool({ tool: 'capture_lead', to: LINE }, { client_name: 'X', client_phone: '3055550998' });
ok(r.error === 'unsigned' && !T.clients.some((c) => c.phone === '+13055550998'), 'unsigned capture_lead writes nothing');
r = await callTool({ tool: 'list_services', to: LINE }, {});
ok(/Haircut/.test(r.speak), 'public read skills stay open without a signature');
r = await callTool({ k: toolKey(), tool: 'book_appointment', to: LINE, from: SARAH }, { service: 'Haircut', date: day, time: '10am', stylist: 'Bea', no_email: true });
ok(r.booked === true && T.bookings.length === 1, 'signed → really booked: ' + r.speak);
ok(/with Ana/.test(r.speak) && !/Bea/.test(r.speak) && r.stylist === 'Ana', 'asked for Bea, Ana was assigned → the confirmation names Ana');
// #8 the add-on right after, same client, same day: joins the visit
const textsBefore = sms.length;
r = await callTool({ k: toolKey(), tool: 'book_appointment', to: LINE, from: SARAH }, { service: 'Blowout', date: day, time: '11am', no_email: true });
ok(r.booked === true && r.add_on_to && /added Blowout/.test(r.speak) && !/deposit/.test(r.speak) && !r.upsell && r.confirmation.text_to === null, 'the add-on joins the visit — no second confirmation / deposit line: ' + r.speak);
ok(!sms.slice(textsBefore).some((m) => /deposit/i.test(m.text || '')), 'and no deposit link is texted for it');

// #4 confirm_booking never searches by name
r = await SKILLS.confirm_booking(T.tenants[0], { client_name: 'Sarah' });
ok(r.confirmed === false && !r.booking, 'confirm_booking with only a name finds nothing (no fuzzy name lookup)');
r = await SKILLS.confirm_booking(T.tenants[0], { client_phone: SARAH });
ok(r.confirmed === true, 'by her number it confirms');

// #5 someone else's booking_id is refused, even signed and from a verified line
T.clients.push({ id: 'mal', tenant_id: TID, first_name: 'Mal', last_name: 'Lory', phone: MALLORY });
const sarahBooking = T.bookings.find((b) => b.client_id === 'sarah' && b.status === 'confirmed');
r = await callTool({ k: toolKey(), tool: 'cancel_appointment', to: LINE, from: MALLORY }, { booking_id: sarahBooking.id });
ok(r.cancelled === false && r.verified === false && sarahBooking.status === 'confirmed', 'a caller can’t cancel another client’s booking by its id');
r = await callTool({ k: toolKey(), tool: 'reschedule_appointment', to: LINE, from: MALLORY }, { booking_id: sarahBooking.id, new_date: day, new_time: '3pm' });
ok(r.rescheduled === false && sarahBooking.start_time === at('10:00'), '…nor move it');
r = await callTool({ k: toolKey(), tool: 'reschedule_appointment', to: LINE, from: SARAH }, { booking_id: sarahBooking.id, new_date: day, new_time: '3pm' });
ok(r.rescheduled === true && /your Haircut from .+ at 10 AM is moved to .+ at 3 PM/.test(r.speak), 'her own booking moves, and she hears which one: ' + r.speak);

// #6 dates without a year are the NEXT one, never 2001
const thisYear = Number(new Date().toLocaleDateString('en-CA', { timeZone: TZ }).slice(0, 4));
const today = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const oct10 = resolveDateKey('October 10', TZ);
ok(oct10 && Number(oct10.slice(0, 4)) >= thisYear && oct10 >= today && oct10.endsWith('-10-10'), '“October 10” → the next October 10: ' + oct10);
ok(resolveDateKey('2026-12-24', TZ) === '2026-12-24' || thisYear > 2026, 'YYYY-MM-DD is taken as given');
ok(resolveDateKey('Friday, Oct 10th', TZ) === oct10 && resolveDateKey('10/10', TZ) === oct10, 'other spellings land on the same day');
ok(resolveDateKey('tomorrow', TZ) > today && resolveDateKey('banana', TZ) === null, 'tomorrow works; nonsense is no date');
ok(Number(resolveDateKey('October 10, 2001', TZ).slice(0, 4)) >= thisYear, 'a year long gone is never booked');

// #20 the paid-service gate on the tools
gateAnswer = { ok: false, reason: 'trial_expired' };
const nBookings = T.bookings.length;
r = await callTool({ k: toolKey(), tool: 'book_appointment', to: LINE, from: SARAH }, { service: 'Haircut', date: day, time: '4pm', no_email: true });
ok(r.booked === false && r.error === 'service_paused' && T.bookings.length === nBookings, 'a paused salon books nothing through Lola: ' + r.speak);
gateAnswer = { ok: true };

// ── 10. A refused text is never "sent" ──
const { sendAutopilotSms } = await import(P + 'lib/sms.js');
smsMode = 'refuse';
const ar = await sendAutopilotSms({ from: LINE, to: SARAH, text: 'We miss you', tenantId: TID });
ok(ar.sent === false && ar.failed === true, 'autopilot text refused by Telnyx → sent:false (it used to say sent)');
smsMode = 'ok';
ok((await sendAutopilotSms({ from: LINE, to: SARAH, text: 'We miss you', tenantId: TID })).sent === true, 'a delivered one says sent');

// ── 11/12. ONE calls row per call; replies before bookkeeping ──
reset();
let callsAtReply = -1;
const av = (await import(P + 'agent-variables.js')).default;
await new Promise((resolve) => { const res = { statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(o) { callsAtReply = T.calls.length; this.body = o; return this; }, end() { return this; } };
  Promise.resolve(av({ method: 'POST', url: '/api/agent-variables', headers: {}, body: { data: { payload: { telnyx_agent_target: LINE, telnyx_end_user_target: SARAH, call_control_id: 'v3:one', call_session_id: 'sess-one' } } } }, res)).then(resolve); });
ok(callsAtReply === 0 && T.calls.length === 1 && T.calls[0].status === 'in_progress', 'Telnyx gets its answer first; the live call row is written right after');
const { persistCallInsights, parseInsightsEvent, classifyResults } = await import(P + 'lib/call-insights.js');
const ev = { data: { id: 'ins-1', event_type: 'call.conversation_insights.generated', payload: { call_control_id: 'v3:one', call_session_id: 'sess-one', results: [{ result: JSON.stringify({ summary: 'Booked a haircut.', outcome: 'booked' }) }, { result: { transcript: [{ role: 'assistant', content: 'Hi, Lola here.' }, { role: 'user', content: 'A haircut please.' }] } }] } } };
const parsedEv = parseInsightsEvent(ev);
const pr = await persistCallInsights(db(), parsedEv, classifyResults(parsedEv.results));
const row = T.calls[0];
ok(pr.mode === 'updated' && T.calls.length === 1, 'the insights land on the SAME row (one row per call)');
ok(row.status === 'booked' && row.summary === 'Booked a haircut.' && row.recording_url === 'Lola: Hi, Lola here.\nCaller: A haircut please.\n', 'status + “Caller:/Lola:” transcript text + summary are written');
ok(!('outcome' in row) && !('transcript' in row), 'the generated outcome/transcript columns are never written');
const ins = await run('webhooks/telnyx-insights.js', { body: JSON.stringify(ev) });
ok(ins.status === 200 && ins.mode === 'duplicate', 'the redelivered event is acknowledged, not re-applied');
const ins2 = await run('webhooks/telnyx-insights.js', { body: JSON.stringify({ data: { event_type: 'call.conversation_insights.generated', payload: { call_control_id: 'v3:nobody', results: [{ result: 'x' }] } } }) });
ok(ins2.status === 200, 'an unknown call never makes the webhook fail');

// ── 18. The old Call Control webhook: answers texts through the live pipeline, upserts call rows ──
reset(); sms.length = 0;
script = [{ content: 'Hi Sarah! What day works for you?' }];
const hook = await run('telnyx-webhook.js', { body: JSON.stringify({ data: { id: 'evw1', event_type: 'message.received', payload: { id: 'pw1', from: { phone_number: SARAH }, to: [{ phone_number: LINE }], text: 'Hi, can I book?', type: 'SMS' } } }) });
ok(hook.status === 200 && hook.forwarded === 'telnyx-sms' && sms.some((m) => m.to === SARAH && /What day works/.test(m.text)), 'a text arriving on /api/telnyx-webhook is answered by Lola (was saved and never answered)');
ok(costs.some((c) => c.kind === 'cost_sms' && c.tenantId === TID), 'the outbound reply logs its SMS cost');
T.calls.push({ id: 'live', tenant_id: TID, telnyx_call_control_id: 'v3:cc', status: 'in_progress' });
await run('telnyx-webhook.js', { body: JSON.stringify({ data: { event_type: 'call.hangup', payload: { call_control_id: 'v3:cc' } } }) });
ok(T.calls.length === 1 && T.calls[0].status === 'completed', 'call events close the one row');

// ── 2. Signatures: the voice line and texts verify every content type ──
const ed = crypto.generateKeyPairSync('ed25519');
process.env.TELNYX_PUBLIC_KEY = ed.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const signedReq = (mod, raw, { good = true, ct = 'application/x-www-form-urlencoded', url = '' } = {}) => {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = crypto.sign(null, Buffer.from(ts + '|' + raw), good ? ed.privateKey : crypto.generateKeyPairSync('ed25519').privateKey).toString('base64');
  const req = Readable.from([Buffer.from(raw)]);
  Object.assign(req, { method: 'POST', url: '/api/' + mod + url, headers: { 'content-type': ct, 'telnyx-signature-ed25519': sig, 'telnyx-timestamp': ts }, query: {} });
  return runStream(mod, req);
};
// The request IS the byte stream (as on Vercel with bodyParser:false) — never copied into a plain object.
const runStream = async (mod, req) => { const h = (await import(P + mod)).default; return new Promise((resolve) => { const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(o) { resolve({ status: this.statusCode, ...o }); }, send(t) { resolve({ status: this.statusCode, text: String(t) }); }, end(t) { resolve({ status: this.statusCode, text: t }); } }; h(req, res); }); };
const form = new URLSearchParams({ CallSid: 'sig-1', From: SARAH, To: LINE, CallStatus: 'in-progress' }).toString();
r = await signedReq('telnyx-voice.js', form, { good: false });
ok(r.status === 403 && /bad signature/.test(r.error), 'a forged TeXML request is refused (it used to skip the check on Vercel)');
r = await signedReq('telnyx-voice.js', form);
ok(r.status === 200 && /<Play>/.test(r.text), 'a genuinely signed one is answered in her voice' + (r.status === 200 && /<Play>/.test(r.text) ? '' : ': ' + JSON.stringify(r).slice(0, 300)));
r = await run('telnyx-voice.js', { headers: { 'content-type': 'application/x-www-form-urlencoded', 'telnyx-signature-ed25519': 'x', 'telnyx-timestamp': String(Math.floor(Date.now() / 1000)) }, body: { CallSid: 'sig-2', From: SARAH, To: LINE } });
ok(r.status === 403, 'a signed request whose bytes were pre-parsed can’t be verified, so with a key set it is refused');
const smsForm = new URLSearchParams({ From: SARAH, To: LINE, Body: 'hi' }).toString();
r = await signedReq('telnyx-sms.js', smsForm, { good: false });
ok(r.status === 403 && /bad signature/.test(r.error), 'telnyx-sms verifies form posts too (it only checked JSON)');
r = await signedReq('operator-voice.js', new URLSearchParams({ From: SARAH, To: LINE }).toString(), { good: false });
ok(r.status === 403 && /bad signature/.test(r.error), 'the owner voice line verifies signatures');
const wa = await import(P + 'webhooks/whatsapp.js');
ok(wa.config?.api?.bodyParser === false && (await import(P + 'telnyx-voice.js')).config?.api?.bodyParser === false, 'raw bodies on every Telnyx route (voice, sms, whatsapp, operator)');
delete process.env.TELNYX_PUBLIC_KEY;

// ── 13/14/15/20/21. The phone line ──
reset(); sms.length = 0; costs.length = 0;
const voice = (b, q = '') => run('telnyx-voice.js', { url: '/api/telnyx-voice' + q, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: b });
const base = { CallSid: 'call-x', From: SARAH, To: LINE, CallStatus: 'in-progress' };
r = await voice(base);
script = [{ content: 'Sure — what day works for you?' }];
await voice(base, '?continue=' + Buffer.from('I want a haircut').toString('base64url'));
script = [{ content: 'Great — and what time?' }];
await voice(base, '?continue=' + Buffer.from('Friday').toString('base64url'));
ok(T.usage_events.filter((e) => (e.event_type || e.kind || e.type) === 'voice_call').length === 1, 'voice_call usage is logged once per call, not per turn');
ok(costs.some((c) => c.kind === 'cost_tts' && c.cents >= 1), 'a new line of her voice logs its ElevenLabs cost');
await voice({ ...base, CallStatus: 'completed', CallDuration: '125' });
ok(costs.some((c) => c.kind === 'cost_voice_minutes' && c.cents === 3), 'a finished call logs its minutes (125s → 3 min)');
// silence twice → one text-back, with the STOP line, once a day
r = await voice(base, '?silence=2');
const tb = sms.filter((m) => m.to === SARAH);
ok(tb.length === 1 && /STOP/.test(tb[0].text), 'a silent caller gets one text-back, with the STOP line: ' + tb[0]?.text);
await voice({ ...base, CallSid: 'call-y' }, '?silence=2');
ok(sms.filter((m) => m.to === SARAH).length === 1, 'and not a second one the same day');
// ElevenLabs hangs → the turn still finishes inside the budget
ttsMode = 'hang';
const t0 = Date.now();
script = [{ content: 'Let me look at Saturday for you.' }];
r = await voice({ ...base, CallSid: 'call-z' }, '?continue=' + Buffer.from('Saturday?').toString('base64url'));
const took = Date.now() - t0;
ok(r.status === 200 && /<Hangup\/>/.test(r.text) && took < 7500, `a hung voice request is cut off (${took}ms) — never a robot voice, never a hung line`);
ttsMode = 'ok';
// paused salon: a short message in her voice, then goodbye
gateAnswer = { ok: false, reason: 'unpaid' };
r = await voice({ ...base, CallSid: 'call-p' });
ok(/<Play>/.test(r.text) && /<Hangup\/>/.test(r.text) && !/<Gather/.test(r.text), 'a paused salon’s line says so in Lola’s voice and hangs up');
// paused salon: no AI text reply
const llmBefore = llm.length, smsBefore = sms.length;
r = await run('telnyx-sms.js', { body: { data: { event_type: 'message.received', payload: { id: 'p-paused', from: { phone_number: SARAH }, to: [{ phone_number: LINE }], text: 'Hi, can I book?', type: 'SMS' } } } });
ok(r.handled === 'service_paused' && llm.length === llmBefore && sms.length === smsBefore, 'a paused salon gets no AI text reply (logged)');
r = await run('agent-variables.js', { body: { data: { payload: { telnyx_agent_target: LINE, telnyx_end_user_target: SARAH } } } });
ok(r.dynamic_variables?.salon_paused === 'true' && /not taking requests/.test(r.dynamic_variables.lola_greeting), 'the assistant is told the salon is paused: ' + r.dynamic_variables?.lola_greeting);
gateAnswer = { ok: true };
delete globalThis.__lolaPaidHooks;
const { serviceGate } = await import(P + 'lib/paid-hooks.js');
ok((await serviceGate(T.tenants[0])).ok === true, 'without the billing module the gate fails open');

// ── 17. A double "yes" runs the owner's parked action once ──
const OT = await import(P + 'lib/owner-tools.js');
T.client_memories.push({ tenant_id: TID, client_phone: 'owner_pending', key: 'action', value: { name: 'no_such_tool', args: {}, at: Date.now() } });
const [y1, y2] = await Promise.all([OT.takePendingAction({ tenant: T.tenants[0], text: 'yes' }), OT.takePendingAction({ tenant: T.tenants[0], text: 'yes' })]);
ok([y1, y2].filter((x) => x && x.duplicate).length === 1 && [y1, y2].filter((x) => x && !x.duplicate).length === 1, 'two “yes” at once: one runs it, the other is told it’s handled');

// ── 19. A tool wired to /api/lola/book-appointment is re-pointed at the live booking layer ──
const W = await import(P + 'lib/assistant-wiring.js');
const d = W.diagnoseTool({ type: 'webhook', webhook: { name: 'book_appointment', url: 'https://www.loladesk.com/api/lola/book-appointment?k=' + toolKey(), method: 'POST' } });
ok(d && d.fixable && d.problem === 'skips_live_booking', 'the direct-insert endpoint is diagnosed as miswired (fixable)');
const d2 = W.diagnoseTool({ type: 'webhook', webhook: { name: 'book_appointment', url: W.toolUrl('book_appointment'), method: 'POST' } });
ok(d2 === null, 'the live booking layer URL is the correct wiring');

// ── 16. Photo download has a real deadline ──
const { downloadImageAsBase64 } = await import(P + 'lib/lola-integrations.js');
const realFetch = globalThis.fetch;
globalThis.fetch = (u, init = {}) => String(u).includes('slow.example') ? new Promise((_, rej) => init.signal?.addEventListener('abort', () => rej(new Error('aborted')))) : realFetch(u, init);
const t1 = Date.now(); let threw = false;
try { await downloadImageAsBase64('https://slow.example/p.jpg', { timeoutMs: 300 }); } catch (_) { threw = true; }
ok(threw && Date.now() - t1 < 2000, 'an image download that hangs is aborted on time');
globalThis.fetch = realFetch;

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
