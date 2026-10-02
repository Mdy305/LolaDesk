// Legal protection that actually holds: real policies on every page, a
// recorded "I agree" at signup, consent and STOP language on every text,
// the AI + recording notice on every call — and Lola answering LolaDesk's
// own support line (calls, texts, website), handing what she can't solve
// to the team.
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'k';
process.env.TELNYX_ASSISTANT_ID = 'assistant-salon'; process.env.TELNYX_MESSAGING_PROFILE_ID = 'mp-1'; process.env.ADMIN_EMAILS = 'owner@loladesk.com';
import { readFileSync, existsSync } from 'node:fs';
const R = (f) => readFileSync(new URL('../../' + f, import.meta.url), 'utf8');
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };

// ── 1. The documents ──
for (const p of ['terms', 'privacy', 'sms-terms', 'acceptable-use', 'dpa', 'ai', 'subprocessors', 'legal', 'support']) ok(existsSync(new URL('../../' + p + '.html', import.meta.url)), `/${p} exists`);
const terms = R('terms.html'), privacy = R('privacy.html'), sms = R('sms-terms.html');
ok(/arbitration/i.test(terms) && /class/i.test(terms) && /opt out of this arbitration/i.test(terms.replace(/<[^>]+>/g, '')) || /opt.out/i.test(terms), 'Terms: arbitration, class-action waiver, opt-out window');
ok(/911/.test(terms) && /twelve|12\)? months/i.test(terms) && /indemn/i.test(terms) && /Florida/.test(terms), 'Terms: no-911, liability cap, indemnity, Florida law');
ok(/TCPA/.test(terms) && /HIPAA|protected health information/i.test(terms), 'Terms: owners carry TCPA consent duties; no PHI without a BAA');
ok(/No mobile information will be shared with third parties or affiliates for marketing or promotional purposes/.test(privacy), 'Privacy: the exact 10DLC no-sharing clause carriers require');
ok(/STOP/.test(sms) && /HELP/.test(sms) && /rates may apply/i.test(sms) && /condition of (?:any )?purchase/i.test(sms), 'SMS terms: STOP, HELP, rates, consent not a condition of purchase');
ok(/recorded/i.test(R('ai.html')) && /Telnyx/.test(R('subprocessors.html')), 'AI & recording notice; subprocessors listed');
const index = R('index.html');
ok(/href="\/legal"/.test(index) && /href="\/sms-terms"/.test(index) && /href="\/support"/.test(index), 'homepage links Legal, SMS Terms and Support');

// ── 2. Signup: no account without a recorded "I agree" ──
const onb = R('onboarding.html');
ok(/id="agreeTerms"/.test(onb) && /accept_terms:true/.test(onb) && /arbitration/.test(onb), 'signup shows the agreement checkbox and sends acceptance');
const { T } = await import('./fake-supabase.mjs');
const P = new URL('../../api/', import.meta.url).href;
const call = async (mod, req) => { const h = (await import(P + mod)).default; return new Promise((resolve) => { const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(o) { resolve({ status: this.statusCode, ...o }); }, end() { resolve({ status: this.statusCode }); } }; h({ headers: {}, query: {}, ...req }, res); }); };
let r = await call('auth/signup.js', { method: 'POST', body: { email: 'a@b.com', password: 'password123' } });
ok(r.status === 400 && r.code === 'terms_required', 'server refuses a signup that did not agree');
const { acceptanceFrom, recordAcceptance, discloseGreeting, greetingDiscloses } = await import(P + 'lib/legal.js');
const { db } = await import(P + 'lib/db.js');
T.legal_acceptances = [];
const acc = acceptanceFrom({ headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8', 'user-agent': 'Safari' } }, { email: 'A@B.com' });
await recordAcceptance(db(), { ...acc, user_id: 'u1', tenant_id: 't1' });
ok(T.legal_acceptances[0]?.ip === '1.2.3.4' && T.legal_acceptances[0].terms_version && T.legal_acceptances[0].email === 'a@b.com' && T.legal_acceptances[0].documents.includes('terms'), 'acceptance recorded with version, time, IP, browser');

// ── 3. Texts carry opt-out; booking carries consent ──
const { confirmText } = await import(P + 'lib/appointment-confirm.js');
ok(/Reply STOP to opt out/.test(confirmText({ firstName: 'Ana', salon: 'S', what: 'cut', when: 'Fri 2pm' })), 'appointment confirmations say how to opt out');
const bw = R('booking-widget.js');
ok(/By booking, you agree to get texts about this appointment/.test(bw) && /Reply STOP to opt out, HELP for help/.test(bw) && /sms_consent: 'transactional'/.test(bw), 'booking page discloses texts and records consent');

// ── 4. Every call opens with the AI + recording notice ──
ok(!greetingDiscloses('Hi, thanks for calling {{salon_name}}! How can I help?'), 'a plain greeting is caught');
const g = discloseGreeting('Hi, thanks for calling {{salon_name}}! How can I help?');
ok(greetingDiscloses(g) && /\{\{salon_name\}\}/.test(g) && /How can I help\?$/.test(g), 'disclosure added, salon’s own words kept: ' + g);
let assistant = { id: 'assistant-salon', name: 'LolaBrain', greeting: 'Hi! Thanks for calling {{salon_name}}.', instructions: 'You are Lola.', tools: [], dynamic_variables_webhook_url: 'https://www.loladesk.com/api/agent-variables' };
const updates = [];
const realFetch = globalThis.fetch;
let numbers = [], orders = [], assistants = [], patchedNums = [], smsOut = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), m = init.method || 'GET';
  const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  const body = init.body ? JSON.parse(init.body) : null;
  if (u.includes('/ai/assistants/assistant-salon')) { if (m !== 'GET') { updates.push(body); assistant = { ...assistant, ...body }; } return J({ data: assistant }); }
  if (/\/ai\/assistants\/care-1/.test(u)) { const a = assistants.find(x => x.id === 'care-1'); Object.assign(a, body); return J({ data: a }); }
  if (/\/ai\/assistants(\?|$)/.test(u)) { if (m === 'POST') { const a = { id: 'care-1', ...body, telephony_settings: { ...(body.telephony_settings || {}), default_texml_app_id: 'texml-care' } }; assistants.push(a); return J({ data: a }); } return J({ data: [assistant, ...assistants] }); }
  if (u.includes('/available_phone_numbers')) return J({ data: [{ phone_number: '+13055559999' }] });
  if (u.includes('/number_orders')) { orders.push(body); numbers.push({ id: 'pn-new', phone_number: '+13055559999' }); return J({ data: { id: 'o1' } }); }
  const pm = u.match(/\/phone_numbers\/([\w-]+)\/(voice|messaging)/); if (pm) { patchedNums.push(pm[1] + ':' + pm[2] + ':' + JSON.stringify(body)); return J({ data: {} }); }
  if (u.includes('/phone_numbers')) return J({ data: numbers, meta: { total_pages: 1 } });
  if (u.includes('/v2/messages')) { smsOut.push(body); return J({ data: { id: 'm' } }); }
  if (u.includes('chat/completions')) return J({ choices: [{ message: { content: 'Plans start at $99 a month with a 14-day free trial — loladesk.com/pricing.' } }] });
  return J({ data: [] });
};
const { wireAssistant } = await import(P + 'lib/assistant-wiring.js');
let w = await wireAssistant({ heal: true });
ok(w.healed && updates[0]?.greeting === '{{lola_greeting}}' && greetingDiscloses(updates[0].dynamic_variables.lola_greeting) && /\{\{salon_name\}\}/.test(updates[0].dynamic_variables.lola_greeting) && /\[LolaDesk compliance\]/.test(updates[0].instructions), 'Lola’s phone greeting (personal per call, notice by default) and rules healed: ' + updates[0]?.dynamic_variables?.lola_greeting);
updates.length = 0; w = await wireAssistant({ heal: true });
ok(w.ok && !updates.length, 'second check: nothing to change');

// ── 5. LolaDesk’s own support line ──
T.platform_settings = []; T.tenant_numbers = [{ tenant_id: 't1', phone_number: '+13055550100' }]; T.tenants = [{ id: 't1', name: 'Salon', phone_number: '+13055550100' }]; T.support_tickets = [];
numbers = [{ id: 'pn-salon', phone_number: '+13055550100' }];
const care = await import(P + 'lib/customer-care.js');
let p = await care.provisionCare(db(), { area_code: '305' });
ok(p.ok && p.created_assistant && p.bought && orders[0]?.phone_numbers?.[0]?.phone_number === '+13055559999' && p.number === '+13055559999', 'no free number → she buys one: ' + p.number);
ok(!patchedNums.some(x => x.startsWith('pn-salon')) && patchedNums.some(x => x.startsWith('pn-new:voice') && x.includes('texml-care')) && patchedNums.some(x => x.startsWith('pn-new:messaging') && x.includes('mp-1')), 'the salon’s number is never touched; the support number gets calls and texts');
const a = assistants[0];
ok(/LolaDesk/.test(a.instructions) && /\$99/.test(a.instructions) && greetingDiscloses(a.greeting) && a.tools.some(t => t.webhook?.name === 'log_support_request') && a.telephony_settings.supports_unauthenticated_web_calls, 'support Lola knows the product, discloses, can pass things to the team, works on the web');
ok(!a.model || /Llama|Kimi|moonshot/i.test(a.model), 'support Lola runs on Telnyx inference');
orders.length = 0; p = await care.provisionCare(db(), {});
ok(p.ok && !p.bought && !orders.length && !p.created_assistant && p.number === '+13055559999', 'running it again refreshes her, buys nothing');
r = await call('customer-care.js', { method: 'GET', query: { public: '1' } });
ok(r.number === '+13055559999' && r.email === 'support@loladesk.com' && r.agent_id === 'care-1', 'the support page gets the number and the web agent');

// a text to the support line
const alerts = [];
const notify = async (msg) => { alerts.push(msg); return { sent: true }; };
const send = async (m) => { smsOut.push(m); return { ok: true }; };
let h = await care.handleCareText(db(), { to: '+13055559999', from: '+17865551234', text: 'How much is it?' }, { send, notify });
ok(h?.handled === 'care_text' && smsOut.at(-1).from === '+13055559999' && /\$99/.test(smsOut.at(-1).text) && T.support_tickets.length === 1 && /How much/.test(alerts[0]), 'a text gets Lola’s answer and the team sees it');
h = await care.handleCareText(db(), { to: '+13055550100', from: '+17865551234', text: 'hi' }, { send, notify });
ok(h === null, 'texts to a salon’s number are left to the salon');
await care.handleCareText(db(), { to: '+13055559999', from: '+17865551234', text: 'STOP' }, { send, notify });
const n = smsOut.length;
h = await care.handleCareText(db(), { to: '+13055559999', from: '+17865551234', text: 'hello?' }, { send, notify });
ok(h.handled === 'care_opted_out' && smsOut.length === n, 'STOP is honoured: no more texts');
ok(/import \{ handleCareText \}/.test(R('api/telnyx-sms.js')), 'inbound texts reach the support line first');

// Lola's tool on a call
r = await call('customer-care.js', { method: 'POST', query: { action: 'ticket', k: 'wrong' }, body: { issue: 'x' } });
ok(r.status === 401, 'the team’s inbox can’t be spammed from outside');
r = await call('customer-care.js', { method: 'POST', query: { action: 'ticket', k: care.ticketToken(), from: '{{telnyx_end_user_target}}' }, body: { name: 'Jo', business: 'Glow', callback_number: '(305) 555-2222', issue: 'Wants a refund' } });
ok(r.ok && T.support_tickets.some(t => t.phone === '+13055552222' && /refund/.test(t.issue)), 'a support call request is saved for the team');
r = await call('customer-care.js', { method: 'POST', query: {}, body: {} });
ok(r.status === 401, 'setting up the line needs the LolaDesk owner');
ok(/setupCare/.test(R('admin.html')) && /LolaDesk support line/.test(R('admin.html')), 'Admin has the support line card');

globalThis.fetch = realFetch;
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
