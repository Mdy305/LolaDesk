// The owner's everyday surfaces tell the truth: client notes and color formulas
// really save (per salon), "Text payment link" really texts the existing link,
// "Put to work" really runs Lola, one deposit rule everywhere, and the menu shows
// owners only what's theirs.
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'tk';
delete process.env.STRIPE_SECRET_KEY;
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const texts = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  if (u === 'https://api.telnyx.com/v2/messages') { const b = JSON.parse(init.body); texts.push(b); return J({ data: { id: 'msg-' + texts.length } }); }
  return J({ data: [] });
};
const fs = await import('node:fs');
const R = (f) => fs.readFileSync(new URL('../../' + f, import.meta.url), 'utf8');
const { T } = await import('./fake-supabase.mjs');
const P = new URL('../../api/', import.meta.url).href;
const MMA = '00000000-0000-4000-8000-00000000aa01', GLOW = '00000000-0000-4000-8000-00000000aa02';
T.tenants = [
  { id: MMA, name: 'MMA Salon', slug: 'mma', owner_name: 'Meddy Jerome', phone_number: '+13055550100', subscription_status: 'active' },
  { id: GLOW, name: 'Glow Spa', slug: 'glow', owner_name: 'Ana', phone_number: null, subscription_status: 'active' },
];
T.tenant_users = [{ user_id: 'u1', tenant_id: MMA, role: 'owner' }, { user_id: 'u2', tenant_id: GLOW, role: 'owner' }, { user_id: 'u3', tenant_id: MMA, role: 'stylist' }];
globalThis.__authUsers = { tok: { id: 'u1', email: 'o@mma.com', user_metadata: { full_name: 'Meddy Jerome' } }, tok2: { id: 'u2', email: 'o@glow.com' }, tok3: { id: 'u3', email: 's@mma.com' } };
T.tenant_numbers = [{ tenant_id: MMA, phone_number: '+13055550100', kind: 'primary', status: 'active' }];
T.clients = [
  { id: 'sarah', tenant_id: MMA, first_name: 'Sarah', name: 'Sarah Kim', phone: '+13055554444', notes: 'Prefers Saturdays' },
  { id: 'lia', tenant_id: GLOW, first_name: 'Lia', name: 'Lia Park', phone: '+17865551111', notes: '' },
];
T.booking_settings = [{ tenant_id: MMA, timezone: 'America/New_York', metadata: { rebooking: { enabled: true } } }];
T.payments = []; T.pos_transactions = []; T.deposits = []; T.billing_policies = []; T.client_notes = [];

const run = async (mod, req) => {
  const h = (await import(P + mod)).default;
  return new Promise((resolve) => {
    const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(o) { resolve({ status: this.statusCode, ...o }); }, end(t) { resolve({ status: this.statusCode, text: t }); } };
    h({ method: 'GET', headers: {}, query: {}, ...req }, res);
  });
};
const auth = (t = 'tok') => ({ authorization: 'Bearer ' + t });

// ── 1. Client notes + color formulas ──
let r = await run('crm-notes.js', { query: { client_id: 'sarah' } });
ok(r.status === 401, 'notes need a sign-in');
r = await run('crm-notes.js', { method: 'POST', headers: auth(), body: { client_id: 'sarah', kind: 'note', body: 'Allergic to PPD — patch test first', tenant_id: GLOW } });
ok(r.ok && r.storage === 'client_notes' && T.client_notes.length === 1 && T.client_notes[0].tenant_id === MMA && T.client_notes[0].client_id === 'sarah', 'a note saves to the signed-in salon (a tenant named in the request is ignored)');
r = await run('crm-notes.js', { method: 'POST', headers: auth(), body: { client_id: 'sarah', kind: 'formula', formula: '7N + 7G 1:1', developer: '20 vol', processing: '35 min', notes: 'Root only', stylist: 'Ana', date: '2026-10-01' } });
const f = T.client_notes.find((x) => x.kind === 'formula');
ok(r.ok && r.formula && r.formula.developer === '20 vol' && f && f.data.formula === '7N + 7G 1:1' && f.data.processing === '35 min' && f.data.stylist === 'Ana' && f.data.date === '2026-10-01', 'a color formula saves with date, formula, developer, processing, notes, stylist');
r = await run('crm-notes.js', { headers: auth(), query: { client_id: 'sarah' } });
ok(r.ok && r.notes.some((n) => /PPD/.test(n.body)) && r.notes.some((n) => /Saturdays/.test(n.body)) && r.formulas.length === 1 && r.formulas[0].notes === 'Root only', 'the profile reads them back (plus what was already on file)');
r = await run('crm-notes.js', { headers: auth('tok2'), query: { client_id: 'sarah' } });
ok(r.status === 404, 'another salon cannot read MMA’s client');
r = await run('crm-notes.js', { method: 'POST', headers: auth('tok2'), body: { client_id: 'sarah', body: 'hijack' } });
ok(r.status === 404 && !T.client_notes.some((x) => x.body === 'hijack'), '…or write to her');
r = await run('crm-notes.js', { method: 'DELETE', headers: auth('tok2'), query: { id: T.client_notes[0].id } });
ok(r.ok && r.deleted === 0 && T.client_notes.length === 2, '…or delete her notes');
// Table not migrated yet → nothing is lost: it lands on clients.notes.
globalThis.__missing = new Set(['client_notes']);
r = await run('crm-notes.js', { method: 'POST', headers: auth(), body: { client_id: 'sarah', body: 'Loves oat milk lattes' } });
ok(r.ok && r.storage === 'client_notes_text' && /Loves oat milk lattes/.test(T.clients[0].notes) && /Prefers Saturdays/.test(T.clients[0].notes), 'no table yet → the note is appended to the client record');
r = await run('crm-notes.js', { method: 'POST', headers: auth(), body: { client_id: 'sarah', kind: 'formula', formula: '9.1 toner', developer: '10 vol', processing: '20 min' } });
r = await run('crm-notes.js', { headers: auth(), query: { client_id: 'sarah' } });
ok(r.ok && r.notes.some((n) => /oat milk/.test(n.body)) && r.formulas.length === 1 && r.formulas[0].formula === '9.1 toner' && r.formulas[0].developer === '10 vol', '…and both notes and formulas read back from it');
globalThis.__missing = null;
const cj = R('client.js');
ok(/\/api\/crm-notes/.test(cj) && !/\/api\/clients\/\$\{encodeURIComponent\(clientId\)\}\/(notes|formulas)/.test(cj) && !/\/api\/crm\/(notes|formulas)/.test(cj) && !/local only/.test(cj) && /Save formula/.test(cj), 'the client page uses the real endpoint, has a formula form, and never fakes a local-only save');
ok(fs.existsSync(new URL('../../migrations/20261006_client_notes.sql', import.meta.url)) && /create table if not exists client_notes/.test(R('migrations/20261006_client_notes.sql')), 'migration for client_notes is in place');

// ── 2. Text the payment link ──
T.payments = [
  { id: 'p1', tenant_id: MMA, stripe_id: 'plink_1', kind: 'charge', status: 'pending', amount: 6500, client_id: 'sarah', client_phone: '+13055554444', client_name: 'Sarah Kim', at_risk: true, metadata: {} },
  { id: 'p2', tenant_id: MMA, stripe_id: 'pi_2', kind: 'charge', status: 'failed', amount: 5000, client_id: 'sarah', at_risk: true, metadata: {} },
  { id: 'p3', tenant_id: MMA, stripe_id: 'pi_3', kind: 'charge', status: 'pending', amount: 4000, client_phone: '12', at_risk: true, metadata: { payment_link_url: 'https://buy.stripe.com/x3' } },
  { id: 'p4', tenant_id: MMA, stripe_id: 'pi_4', kind: 'charge', status: 'pending', amount: 4000, at_risk: true, metadata: { payment_link_url: 'https://buy.stripe.com/x4' } },
  { id: 'g1', tenant_id: GLOW, stripe_id: 'pi_g', kind: 'charge', status: 'pending', amount: 9000, client_phone: '+17865551111', at_risk: true, metadata: { payment_link_url: 'https://buy.stripe.com/g1' } },
];
T.pos_transactions = [{ tenant_id: MMA, stripe_id: 'plink_1', payment_link_url: 'https://buy.stripe.com/abc' }];
const send = (id, t = 'tok') => run('stripe/payments/[id]/send-link.js', { method: 'POST', headers: auth(t), query: { id } });
r = await run('stripe/payments/[id]/send-link.js', { method: 'POST', query: { id: 'p1' } });
ok(r.status === 401, 'sending a link needs a sign-in');
r = await send('p1');
ok(r.ok && texts.length === 1 && texts[0].from === '+13055550100' && texts[0].to === '+13055554444' && /https:\/\/buy\.stripe\.com\/abc/.test(texts[0].text) && /MMA Salon/.test(texts[0].text) && /\$65\.00/.test(texts[0].text) && r.sent_to === '•••4444', 'texts the existing link from the salon’s own number');
r = await send('p2');
ok(r.status === 409 && /no payment link/i.test(r.error) && !/phone/i.test(r.error) && texts.length === 1, 'no link on file → says so plainly (never blames the client’s phone)');
r = await send('p3');
ok(r.status === 400 && /client’s phone number/.test(r.error) && texts.length === 1, 'a broken client number → that’s what it says');
r = await send('p4');
ok(r.status === 400 && /no phone number on file/i.test(r.error), 'no client phone → asks to add one');
r = await send('g1');
ok(r.status === 404, 'another salon’s payment is not found');
T.tenants[1].phone_number = null; T.payments.push({ id: 'g2', tenant_id: GLOW, kind: 'charge', status: 'pending', amount: 100, client_phone: '+17865551111', metadata: { payment_link_url: 'https://buy.stripe.com/g2' } });
r = await send('g2', 'tok2');
ok(r.status === 409 && /salon doesn’t have a texting number/.test(r.error) && !/client’s phone/.test(r.error), 'salon without a number → the salon is told, not the client blamed');
ok(/send-link/.test(R('banking-payments.html')) && !/Lola will follow up if it isn't paid in 24h/.test(R('banking-payments.html')), 'Payments page makes no promise the server doesn’t keep');

// ── 3. "Put Lola to work" really runs her ──
const router = await import(P + 'lib/router.js');
const brainCalls = [];
router.__setBrain(async (args) => { brainCalls.push(args); return { status: 200, json: { content: [{ type: 'text', text: 'Drafted a Tuesday win-back for 12 due clients — approve it in Campaigns.' }], intent: 'campaign_draft', actions: [{ navigate: '/campaigns' }] } }; });
r = await run('orchestrator.js', { method: 'POST', body: { route_to: 'growth', task: 'win back overdue VIPs', tenant: { slug: 'glow' } } });
ok(r.status === 401 && !brainCalls.length, 'no sign-in → nothing runs (a browser-named salon is never trusted)');
r = await run('orchestrator.js', { method: 'POST', headers: auth(), body: { route_to: 'growth', task: 'win back overdue VIPs', tenant: { slug: 'glow', id: GLOW } } });
ok(r.ok && /Tuesday win-back/.test(r.reply) && brainCalls[0].tenant.id === MMA && brainCalls[0].tenant.owner_name === 'Meddy Jerome' && /marketing lead/.test(brainCalls[0].body.system) && brainCalls[0].body.messages[0].content === 'win back overdue VIPs' && r.actions[0].navigate === '/campaigns', 'the signed-in salon’s Lola does the job and the owner sees her real answer');
router.__setBrain(async () => ({ status: 200, json: { content: [] } }));
r = await run('orchestrator.js', { method: 'POST', headers: auth(), body: { route_to: 'ops', task: 'x' } });
ok(!r.ok && r.error && !/delegated/i.test(JSON.stringify(r)), 'no answer → an honest failure, never "Delegated"');
router.__setBrain(null);
ok(!/Placeholder handoff/.test(R('api/lib/router.js')), 'the placeholder hand-off is gone');
const mk = R('marketer.html');
ok(!/slug:\s*'demo'/.test(mk) && /Authorization: 'Bearer ' \+ tok/.test(mk) && !/Delegated to/.test(mk), 'Marketer sends the sign-in, never a demo salon, and shows what Lola actually did');
ok(!/I've handed that to my/.test(R('app.js')) && /data\.reply/.test(R('app.js')), 'the dashboard shows her real reply too');

// ── 4. One deposit rule ──
r = await run('tenant/billing-policies/index.js', { method: 'POST', headers: auth(), body: { deposits: { enabled: true, type: 'fixed', amount: 40, min_amount: 10, hold_minutes: 15, who: 'risky' }, no_show: { enabled: true, type: 'fixed', amount: 50, delay_minutes: 15 }, late_cancel: { enabled: true, window_hours: 48, amount: 30 } } });
const md = T.booking_settings[0].metadata;
ok(r.ok && md.deposits.enabled === true && md.deposits.type === 'fixed' && md.deposits.fixed_cents === 4000 && md.deposits.min_cents === 1000 && md.deposits.who === 'risky' && md.deposits.no_show.fee_cents === 5000 && md.deposits.late_cancel.window_hours === 48 && md.rebooking?.enabled === true, 'Payments → Policies saves into booking_settings.metadata.deposits (other settings untouched)');
const { resolvePolicy } = await import(P + 'lib/deposits.js');
const pol = resolvePolicy(T.booking_settings[0]);
ok(pol.enabled && pol.type === 'fixed' && pol.fixed_cents === 4000 && pol.hold_minutes === 15, 'the deposit Lola texts reads that same rule');
// Settings → Booking rules changes the same object…
T.booking_settings[0].metadata.deposits = { ...md.deposits, enabled: false, grace_minutes: 30 };
r = await run('tenant/billing-policies/index.js', { headers: auth() });
ok(r.ok && r.data.deposits.enabled === false && r.data.deposits.amount === 40 && r.data.deposits.mode === 'fixed' && r.data.deposits.fixed_cents === 4000 && r.data.no_show.fee_cents === 5000 && r.data.late_cancel.hours_before === 48 && Array.isArray(r.data.tips.suggested_percents), '…and Payments → Policies reads it back (same response shape as before)');
ok(T.billing_policies.some((x) => x.tenant_id === MMA && x.policies && x.policies.no_show.enabled === true), 'the legacy billing_policies copy is refreshed for its old readers');
r = await run('tenant/billing-policies/index.js', { method: 'POST', headers: auth('tok3'), body: { deposits: { enabled: true } } });
ok(r.status === 403, 'a stylist can’t change payment policies');
const bp = R('banking-policies.html'), st = R('settings.html');
ok(/LolaBank\.api\('\/api\/booking-settings'/.test(bp) && /metadata: \{ deposits \}/.test(bp) && /Object\.assign\(\{\},was,\{enabled:on/.test(st), 'both pages write the one rule (Settings merges, never wipes the fees)');

// ── 5. What owners see ──
const side = R('sidebar.js');
ok(/label: 'Phone & texting', href: '\/telecom', pages: \['telecom'\], platform: true/.test(side) && /label: 'Launch checklist', href: '\/launch', pages: \['launch'\], owner: true, hidden: true/.test(side), 'Phone & texting is LolaDesk-operator only; the Launch checklist stays reachable for owners (⌘K / URL), off the menu');
ok(!/brain-os\?q=/.test(side) && /LolaEverywhere\.ask\(text\)/.test(side), '⌘K free text goes to Lola, not a separate page');
ok(/\.ln-side \.ln-menu \[data-ln-dup\]\{display:none\}/.test(side), 'the account menu no longer repeats the sidebar on desktop');
const dash = R('dashboard.html');
ok(!/Book Sarah/.test(dash) && !/Top blonde clients/.test(dash) && /fillCmdChips/.test(dash), 'no invented clients in the dashboard chips');
ok(/shown\("scheduleList"\) && renderSchedule/.test(dash), 'hidden dashboard panels aren’t fetched');
ok(/applySignedInTenant/.test(R('app.js')) && !/owner: 'Owner'/.test(R('app.js')) && /loladesk_tenant/.test(R('auth-guard.js')), 'Lola greets the signed-in owner, never “Owner”');
for (const p of ['pos', 'revenue', 'client', 'lola-live']) ok(/auth-guard\.js/.test(R(p + '.html')), p + ' is behind the sign-in');
for (const p of ['client', 'pos', 'activation-studio', 'numbers', 'lola-live']) ok(/sidebar\.js/.test(R(p + '.html')), p + ' has the menu');
ok(!/user-scalable=no/.test(R('lola-live.html')), 'Lola full screen can be zoomed');
const act = R('activation-studio.html');
ok(!/Telnyx|ElevenLabs|LolaBrain|tenant configuration/.test(act) && /Checking Lola can answer your phone/.test(act), 'activation speaks salon, not engineering');
const onb = R('onboarding.html');
ok(!/Enter your calendar/.test(onb) && /confirmed \\u2014 sign in/.test(onb) && /Add Lola to your website/.test(onb) && !/placeholder="MMA Salon"/.test(onb), 'onboarding: honest confirm step, website step in plain words, generic placeholder');
ok(/for="mfaCode"|id="mfaCode" aria-label/.test(R('login.html')) && /id="forgotEmail" aria-label/.test(R('login.html')) && /id="callPhone" aria-label/.test(R('login.html')), 'sign-in code / reset / call-me fields are labelled');
ok(!/<label>[^<]*<\/label><input id="sName"/.test(st) && /<label for="sName">/.test(st), 'Settings fields are labelled');

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
