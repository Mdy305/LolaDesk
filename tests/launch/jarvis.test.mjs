// Lola answers when you talk to her, and DOES what you say: one brain for the
// dashboard and the panel, reflexes for everyday commands, a fast Telnyx model
// with a hard deadline, never a leaked chain-of-thought, and a self-check.
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'k';
delete process.env.LOLA_VOICE_RELAY_URL; delete process.env.LOLA_FAST_MODEL; process.env.TELNYX_ASSISTANT_ID = 'assistant-1';
import { readFileSync } from 'node:fs';
const calls = []; const sms = [];
let llm = (model, body) => ({ status: 200, json: { choices: [{ message: { content: 'Sure — here you go.' } }] } });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  if (u.includes('chat/completions')) {
    const b = JSON.parse(init.body || '{}'); calls.push(b);
    const r = await llm(b.model, b, init);
    if (r.hang) return new Promise((_, rej) => init.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    return J(r.json, r.status);
  }
  if (u.includes('/v2/messages')) { sms.push(JSON.parse(init.body)); return J({ data: { id: 'm1' } }); }
  if (u.includes('text-to-speech')) return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  if (u.includes('/v2/phone_numbers')) return J({ data: [{ phone_number: '+13055550100', messaging_profile_id: 'mp1' }] });
  return J({});
};
const { T } = await import('./fake-supabase.mjs');
const P = new URL('../../api/', import.meta.url).href;
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const TID = '00000000-0000-4000-8000-0000000000dd', now = Date.now();
globalThis.__authUsers = { tok: { id: 'u1', email: 'owner@salon.com' } };
T.tenants = [{ id: TID, name: 'Salon', slug: 'salon', owner_email: 'owner@salon.com', subscription_status: 'active', phone_number: '+13055550100', services: [{ name: 'Balayage', price: 250 }] }];
T.tenant_users = [{ user_id: 'u1', tenant_id: TID, role: 'owner', status: 'active' }];
T.booking_settings = [{ tenant_id: TID, timezone: 'America/New_York' }];
T.clients = [{ id: 'c1', tenant_id: TID, first_name: 'Maria', last_name: 'Lopez', name: 'Maria Lopez', phone: '+13055551111' }];
T.bookings = [{ id: 'b1', tenant_id: TID, client_id: 'c1', status: 'confirmed', start_time: new Date(now + 3600e3).toISOString(), end_time: new Date(now + 7200e3).toISOString(), total_amount: 250 }];
T.client_memories = []; T.conversations = []; T.messages = []; T.services = []; T.staff = []; T.calls = []; T.usage_events = [];

const run = async (mod, body, { method = 'POST', headers = { authorization: 'Bearer tok' } } = {}) => { const h = (await import(P + mod)).default; return new Promise((resolve) => { const res = { statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(o) { resolve({ status: this.statusCode, ...o }); }, end() { resolve({ status: this.statusCode }); } }; h({ method, url: '/api/' + mod, headers, query: {}, body }, res); }); };
const say = (text, extra = {}) => run('lola.js', { messages: [{ role: 'user', content: text }], channel: 'dashboard', ...extra });
const words = (r) => r.content?.[0]?.text || '';

// 1) Reflexes: instant, no model in the loop
calls.length = 0;
let r = await say('Hey Lola, open my calendar');
ok(r.status === 200 && r.actions?.[0]?.navigate === '/calendar' && /calendar/i.test(words(r)), '“open my calendar” → she opens it: ' + words(r));
r = await say('catch me up');
ok(r.status === 200 && r.intent === 'today_brief' && words(r).length > 10, '“catch me up” runs the day brief: ' + words(r).slice(0, 90));
r = await say('how much did we make this week?');
ok(r.intent === 'revenue_report', '“how much did we make this week” → revenue report: ' + words(r).slice(0, 80));
ok(calls.length === 0, 'none of that waited on a model');
ok(r.orchestration?.agents?.[0]?.id === 'operations', 'the team member who did it is reported for the orb');

// 2) Doing things that reach a client: preview, then yes
r = await say("Text Maria I'm running 10 minutes late");
ok(r.needs_confirmation && /Maria/.test(words(r)) && /running 10 minutes late/.test(words(r)) && sms.length === 0, 'text preview, nothing sent yet: ' + words(r));
r = await say('yes');
ok(sms.length === 1 && sms[0].to === '+13055551111' && /running 10 minutes late/.test(sms[0].text) && /Sent/.test(words(r)), '“yes” → the text goes out from the salon line');

// 3) Everything else: her brain, fast model, deadline, voice style
calls.length = 0;
r = await say('What should I post on Instagram this week?', { voice: true, system: 'The owner is on the "dashboard" page of LolaDesk.' });
ok(r.status === 200 && words(r) === 'Sure — here you go.', 'open questions go to her brain');
ok(calls[0]?.model === 'meta-llama/Llama-3.3-70B-Instruct' && Array.isArray(calls[0].tools) && calls[0].tools.length > 10, 'fast Telnyx model with her tools');
const sys = calls[0]?.messages?.[0]?.content || '';
ok(/SPEAKING to you/.test(sys) && /PAGE CONTEXT/.test(sys) && !/Beverly Hills/.test(sys), 'spoken turns get short spoken answers; the page is context, not a persona');

// 4) Fast model not on the account → Kimi, once, then remembered
calls.length = 0;
llm = (model) => model.includes('Llama') ? { status: 404, json: { errors: [{ detail: 'model not found' }] } } : { status: 200, json: { choices: [{ message: { content: 'From Kimi.' } }] } };
r = await say('Tell me something nice');
ok(words(r) === 'From Kimi.' && calls.map(c => c.model).join(',') === 'meta-llama/Llama-3.3-70B-Instruct,moonshotai/Kimi-K2.6', 'fast model missing → Kimi answers the same turn');
calls.length = 0; await say('And another');
ok(calls.length === 1 && calls[0].model === 'moonshotai/Kimi-K2.6', 'and she stops asking for the missing model');

// 5) Never speak a chain-of-thought
const { chat } = await import(P + 'lib/llm.js');
llm = () => ({ status: 200, json: { choices: [{ message: { content: '<think>The user wants a greeting. Let me</think>Hello!', reasoning: 'internal' } }] } });
let c = await chat({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 200 });
ok(c.ok && c.text === 'Hello!', 'thinking is stripped from what she says');
llm = () => ({ status: 200, json: { choices: [{ message: { content: '', reasoning: 'The user wants me to…' } }] } });
c = await chat({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 200 });
ok(!c.ok, 'reasoning alone is never sent to a client as a text');

// 6) A hung model can't freeze her
llm = () => ({ hang: true });
const t0 = Date.now();
c = await chat({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 200, deadlineMs: 3000 });
ok(!c.ok && Date.now() - t0 < 4500, `hard deadline holds (${Date.now() - t0}ms)`);
llm = () => ({ hang: true });
const t1 = Date.now(); r = await say('Write me a poem about hair');
ok(r.status === 200 && words(r) && Date.now() - t1 < 25000, `the brain still answers inside its budget (${Date.now() - t1}ms): ` + words(r).slice(0, 60));

// 7) The browser voice never waits on a socket Vercel can't host
r = await run('voice-session.js', {});
ok(r.status === 503 && r.code === 'relay_not_available', 'no hosted relay → the orb uses her direct voice path');
const compat = readFileSync(new URL('../../voice-compat.js', import.meta.url), 'utf8');
ok(!/api\/lola-orchestra/.test(compat.replace(/\/\/.*$/gm, '')), 'the dashboard no longer diverts her to the caller-side orchestra');
const app = readFileSync(new URL('../../app.js', import.meta.url), 'utf8');
ok(/applyActions\(/.test(app) && /nextTurnVoice/.test(app) && !/Valentina R\. is 2 weeks overdue/.test(app), 'dashboard acts on what she says, keeps the conversation going, no invented numbers');

// 8) “Lola, run a check”
llm = () => ({ status: 200, json: { choices: [{ message: { content: 'ready' } }] } });
r = await say('Lola, run a check');
ok(r.intent === 'self_check' && Array.isArray(r.checks) && r.checks.find(x => x.key === 'brain') && r.checks.find(x => x.key === 'texts')?.ok && /fast model/.test(words(r)), 'self-check: ' + words(r).slice(0, 140));

// 9) Alive: every page in sight, her mood, her hello
const side = readFileSync(new URL('../../sidebar.js', import.meta.url), 'utf8');
ok(/const subs = t\.subs\.filter\(allowed\);/.test(side) && /id: 'salon'/.test(side) && /Phone & texting/.test(side), 'every page stays in the sidebar (Salon: settings, team, phone, billing…)');
ok(/lola-mood\.js/.test(side) && /old preview copy/.test(side), 'mood loads on every page; preview copies say they are not the live app');
globalThis.window = globalThis; globalThis.addEventListener ||= () => {}; globalThis.CustomEvent ||= class extends Event { constructor(t, o) { super(t); this.detail = o && o.detail; } };
const events = []; globalThis.dispatchEvent = (e) => { events.push(e); return true; };
await import('../../lola-mood.js');
const M = globalThis.LolaMood;
ok(M.read('Thank you Lola, that is perfect!').joy > 0.5 && M.read('A client is upset about a refund').concern > 0.5 && M.read('do it now!!').energy > 0, 'she reads the mood of what you say');
const orb = readFileSync(new URL('../../lola-orb.js', import.meta.url), 'utf8');
ok(/lola:mood/.test(orb) && /nextBeat/.test(orb) && /posture/.test(orb) && /pointermove/.test(orb), 'her body answers: mood, heartbeat, posture, she notices you');
ok(/greetOnArrival/.test(app) && /silent:true/.test(app), 'she says hello with your day on your first touch');
const res = readFileSync(new URL('../../lola-resonance.js', import.meta.url), 'utf8');
ok(/Authorization: 'Bearer ' \+ tok/.test(res) && /My voice is off right now/.test(res), 'her voice is signed in, and a failure is shown, never silent');

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
