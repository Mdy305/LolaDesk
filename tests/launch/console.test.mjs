// LolaDesk Console (/console → api/console.js): the platform owner runs the business —
// overview numbers from real rows, every subscription, the same Comp/Suspend as /api/admin,
// the support inbox (status, note, claim, honest replies) and salons' in-app "Contact support".
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k';
process.env.ADMIN_EMAILS = 'admin@loladesk.com'; process.env.APP_URL = 'https://www.loladesk.com';
for (const k of ['TELNYX_API_KEY', 'SENDGRID_API_KEY', 'AWS_SES_REGION', 'AWS_ACCESS_KEY_ID', 'MAILGUN_API_KEY', 'MAILGUN_DOMAIN', 'BILLING_ENFORCE']) delete process.env[k];
import { readFileSync } from 'node:fs';

const texts = [];
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (/api\.telnyx\.com\/v2\/messages/.test(u)) { texts.push(JSON.parse(init.body || '{}')); return J({ data: { id: 'msg_1' } }); }
  return J({ data: [] });
};

const { T } = await import('./fake-supabase.mjs');
const P = new URL('../../api/', import.meta.url).href;
const R = (f) => readFileSync(new URL('../../' + f, import.meta.url), 'utf8');
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const DAY = 864e5, now = Date.now(), iso = (ms) => new Date(ms).toISOString();
const run = async (mod, { method = 'GET', headers = {}, body = {}, query = {} } = {}) => { const h = (await import(P + mod)).default; return new Promise((resolve) => { const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, status(c) { this.statusCode = c; return this; }, json(o) { resolve({ status: this.statusCode, ...o }); }, send(b) { resolve({ status: this.statusCode, body: String(b), headers: this.headers }); }, end() { resolve({ status: this.statusCode }); } }; h({ method, url: '/api/' + mod, headers, query, body }, res); }); };
globalThis.__authUsers = { 'tok-admin': { id: 'u-adm', email: 'admin@loladesk.com' }, 'tok-a': { id: 'u-a', email: 'owner@salona.com', user_metadata: { name: 'Ana' } }, 'tok-x': { id: 'u-x', email: 'nobody@else.com' } };
const ADMIN = { authorization: 'Bearer tok-admin' }, OWNER = { authorization: 'Bearer tok-a' };

function seed() {
  T.tenants = [
    { id: 't1', slug: 'one', name: 'One Salon', owner_email: 'owner@salona.com', plan: 'starter', billing_interval: 'monthly', subscription_status: 'active', current_period_end: iso(now + 20 * DAY), stripe_customer_id: 'cus_1', phone_number: '+13055550001', created_at: iso(now - 60 * DAY) },
    { id: 't2', slug: 'two', name: 'Two Spa', owner_email: 'two@x.com', plan: 'pro', billing_interval: 'annual', subscription_status: 'past_due', past_due_since: iso(now - DAY), created_at: iso(now - 90 * DAY) },
    { id: 't3', slug: 'three', name: 'Three', owner_email: 'three@x.com', plan: 'medspa', subscription_status: 'trial', trial_ends_at: iso(now + 3 * DAY), created_at: iso(now - 11 * DAY) },
    { id: 't4', slug: 'four', name: 'Four', owner_email: 'four@x.com', plan: 'starter', subscription_status: 'trial', trial_ends_at: iso(now + 12 * DAY), created_at: iso(now - 2 * DAY) },
    { id: 't5', slug: 'five', name: 'Five', owner_email: 'five@x.com', plan: 'pro', subscription_status: 'canceled', canceled_at: iso(now - 5 * DAY), current_period_end: iso(now - 5 * DAY), created_at: iso(now - 200 * DAY) },
    { id: 't6', slug: 'six', name: 'Six', owner_email: 'six@x.com', plan: 'pro', subscription_status: 'canceled', canceled_at: iso(now - 45 * DAY), created_at: iso(now - 300 * DAY) },
    { id: 't7', slug: 'seven', name: 'Seven', owner_email: 'seven@x.com', plan: 'starter', subscription_status: 'trial', billing_status: 'active', created_at: iso(now - 40 * DAY) },
    { id: 't8', slug: 'eight', name: 'Eight', owner_email: 'eight@x.com', plan: 'starter', subscription_status: 'active', billing_status: 'suspended', created_at: iso(now - 40 * DAY) },
  ];
  T.usage_events = [{ tenant_id: 't1', kind: 'cost_number_month', units: 100, metadata: { unit: 'cents' }, created_at: iso(now) }, { tenant_id: 't1', kind: 'voice_call', units: 1, created_at: iso(now) }];
  T.booking_fees = []; T.messages = []; T.calls = []; T.bookings = []; T.tenant_users = [];
  T.billing_events = [{ id: 'e1', tenant_id: 't1', stripe_event_id: 'evt_1', type: 'invoice.payment_succeeded', amount: 9900, currency: 'usd', status: 'paid', created_at: iso(now - DAY) }, { id: 'e2', tenant_id: 't2', stripe_event_id: 'evt_2', type: 'invoice.payment_failed', created_at: iso(now - DAY) }];
  T.platform_settings = [];
  T.support_tickets = [
    { id: 'k1', name: 'Old', phone: '+17865550001', issue: 'Texts not arriving to clients', urgency: 'normal', channel: 'sms', status: 'open', created_at: iso(now - 3 * DAY) },
    { id: 'k2', name: 'Fresh', phone: '+17865550002', issue: 'Texts not arriving since Monday', urgency: 'normal', channel: 'phone_call', status: 'open', created_at: iso(now - 1 * DAY) },
    { id: 'k3', name: 'Urgent', email: 'u@x.com', issue: 'Lola stopped answering calls', urgency: 'high', channel: 'phone_call', status: 'open', created_at: iso(now - 2 * DAY) },
    { id: 'k4', name: 'Done', issue: 'Billing question', urgency: 'high', channel: 'sms', status: 'resolved', created_at: iso(now - 0.5 * DAY) },
    { id: 'k5', name: 'NoContact', issue: 'Help me', urgency: 'low', channel: 'phone_call', status: 'open', created_at: iso(now - 4 * DAY) },
  ];
}
seed();

// ══ 1. Admin only — every action ══
const GETS = ['overview', 'subscriptions', 'tenant', 'tickets', 'help', 'analytics'];
const POSTS = ['suspend', 'activate', 'unsuspend', 'uncomp', 'extend_trial', 'ticket_update', 'ticket_reply'];
let blocked = true;
for (const a of GETS) {
  const x = await run('console.js', { headers: { authorization: 'Bearer tok-x' }, query: { action: a, id: 't1' } });
  const y = await run('console.js', { query: { action: a } });
  if (x.status !== 403 || y.status !== 401) blocked = false;
}
for (const a of POSTS) {
  const x = await run('console.js', { method: 'POST', headers: { authorization: 'Bearer tok-x' }, body: { action: a, tenant_id: 't1', id: 'k1', days: 3, message: 'hi' } });
  const y = await run('console.js', { method: 'POST', headers: OWNER, body: { action: a, tenant_id: 't1', id: 'k1', days: 3, message: 'hi' } });
  if (x.status !== 403 || y.status !== 403) blocked = false;
}
ok(blocked && T.tenants.find((t) => t.id === 't1').billing_status === undefined && T.support_tickets.find((t) => t.id === 'k1').status === 'open', 'every Console action: 401 signed out, 403 for non-admins (a salon owner too) — nothing changed');

// ══ 2. Overview from real rows ══
let r = await run('console.js', { headers: ADMIN, query: { action: 'overview' } });
const o = r.overview;
ok(r.ok && o.mrr_cents === 9900 + 31900 + 9900 && o.arr_cents === o.mrr_cents * 12, `MRR from plans.js: active starter + past_due pro annual + (suspended but Stripe-active) starter = $${o.mrr_cents / 100}`);
const adm = await run('admin.js', { headers: ADMIN });
ok(adm.metrics.mrr_cents === o.mrr_cents && adm.metrics.costs_cents === o.costs_cents && adm.metrics.margin_cents === o.margin_cents, 'Console MRR / cost / margin = the Command page’s numbers (one computation)');
ok(o.trials === 2 && o.trials_ending_7d === 1, 'trials: 2, one ends within 7 days');
ok(o.past_due === 1 && o.churned_30d === 1 && o.new_30d === 2 && o.comped === 1 && o.suspended === 1, 'past due 1 · churned in 30 days 1 (not the one 45 days ago) · new in 30 days 2 · comped 1 · suspended 1');
ok(o.tickets_open === 4 && o.tickets_urgent === 1, 'open tickets 4, urgent 1 (a resolved urgent one doesn’t count)');
ok(Array.isArray(o.signups_weekly) && o.signups_weekly.length === 8 && o.signups_weekly[7] === 1 && o.signups_weekly.reduce((a, b) => a + b, 0) === 4, 'weekly sign-ups trend counts real created_at (last 8 weeks)');

// ══ 3. Subscriptions ══
r = await run('console.js', { headers: ADMIN, query: { action: 'subscriptions' } });
const st = Object.fromEntries(r.subscriptions.map((s) => [s.id, s.state]));
ok(st.t1 === 'active' && st.t2 === 'past_due' && st.t3 === 'trialing' && st.t5 === 'canceled' && st.t7 === 'comped' && st.t8 === 'suspended', 'each salon gets one state: active / past_due / trialing / canceled / comped / suspended');
const s1 = r.subscriptions.find((s) => s.id === 't1');
ok(s1.mrr_cents === 9900 && s1.stripe_customer_id === 'cus_1' && s1.owner_email === 'owner@salona.com' && s1.phone_number === '+13055550001' && s1.renews_at, 'row: MRR, Stripe customer, owner, line, renewal');
r = await run('console.js', { headers: ADMIN, query: { action: 'subscriptions', status: 'trialing' } });
ok(r.subscriptions.length === 2 && r.subscriptions.every((s) => s.state === 'trialing'), 'status filter: trialing only');
r = await run('console.js', { headers: ADMIN, query: { action: 'subscriptions', q: 'two@x' } });
ok(r.subscriptions.length === 1 && r.subscriptions[0].id === 't2', 'search by owner email');
r = await run('console.js', { headers: ADMIN, query: { action: 'tenant', id: 't1' } });
ok(r.ok && r.events.length === 1 && r.events[0].type === 'invoice.payment_succeeded' && r.usage.some((u) => u.kind === 'cost_number_month' && u.cost_cents === 100) && r.usage.some((u) => u.kind === 'voice_call' && u.count === 1), 'drawer: billing timeline for that salon only + this month’s usage and cost');

// ══ 4. Comp / Suspend = /api/admin ══
const viaAdmin = {}, viaConsole = {};
for (const a of ['activate', 'uncomp', 'suspend', 'unsuspend']) {
  seed(); const x = await run('admin.js', { method: 'POST', headers: ADMIN, body: { action: a, tenant_id: 't3' } });
  viaAdmin[a] = [x.status, x.tenant?.billing_status, T.tenants.find((t) => t.id === 't3').billing_status];
  seed(); const y = await run('console.js', { method: 'POST', headers: ADMIN, body: { action: a, tenant_id: 't3' } });
  viaConsole[a] = [y.status, y.tenant?.billing_status, T.tenants.find((t) => t.id === 't3').billing_status];
}
ok(JSON.stringify(viaAdmin) === JSON.stringify(viaConsole) && viaConsole.activate[2] === 'active' && viaConsole.suspend[2] === 'suspended' && viaConsole.uncomp[2] === 'trial', 'Comp / Uncomp / Suspend / Unsuspend: Console writes exactly what /api/admin writes');
seed(); r = await run('console.js', { method: 'POST', headers: ADMIN, body: { action: 'comp', tenant_id: 't4' } });
ok(r.ok && T.tenants.find((t) => t.id === 't4').billing_status === 'active', '"comp" = activate');
const bad = await run('console.js', { method: 'POST', headers: ADMIN, body: { action: 'suspend', tenant_id: 'nope' } });
const badA = await run('admin.js', { method: 'POST', headers: ADMIN, body: { action: 'suspend', tenant_id: 'nope' } });
ok(bad.status === 404 && badA.status === 404 && bad.error === badA.error, 'unknown salon: same 404 from both');

// Extend trial (LolaDesk no-card trial only; written to trial_ends_at, which the paywall reads)
seed(); const before = Date.parse(T.tenants.find((t) => t.id === 't3').trial_ends_at);
r = await run('console.js', { method: 'POST', headers: ADMIN, body: { action: 'extend_trial', tenant_id: 't3', days: 7 } });
ok(r.ok && Math.abs(Date.parse(T.tenants.find((t) => t.id === 't3').trial_ends_at) - (before + 7 * DAY)) < 1000, 'extend trial by 7 days → trial_ends_at + 7 days');
r = await run('console.js', { method: 'POST', headers: ADMIN, body: { action: 'extend_trial', tenant_id: 't1', days: 7 } });
ok(r.status === 409 && !T.tenants.find((t) => t.id === 't1').trial_ends_at, 'a Stripe-billed salon’s trial isn’t touched (409)');
r = await run('console.js', { method: 'POST', headers: ADMIN, body: { action: 'extend_trial', tenant_id: 't3', days: 400 } });
ok(r.status === 400, 'days outside 1–90 refused');

// ══ 5. Support inbox ══
seed();
r = await run('console.js', { headers: ADMIN, query: { action: 'tickets' } });
ok(r.tickets.map((t) => t.id).join(',') === 'k3,k2,k1,k5,k4', 'inbox order: unresolved first, urgent first, then newest (' + r.tickets.map((t) => t.id).join(',') + ')');
ok(r.channels.sms === false && r.channels.email === false, 'channels honest: no support line, no email provider');
r = await run('console.js', { method: 'POST', headers: ADMIN, body: { action: 'ticket_reply', id: 'k1', message: 'On it!' } });
ok(r.status === 400 && /support line/.test(r.error) && !texts.length && !(T.support_tickets.find((t) => t.id === 'k1').replies || []).length, 'reply with no channel → clear error, nothing sent or logged: ' + r.error);
r = await run('console.js', { method: 'POST', headers: ADMIN, body: { action: 'ticket_update', id: 'k1', status: 'in_progress' } });
ok(r.ok && T.support_tickets.find((t) => t.id === 'k1').status === 'in_progress' && T.support_tickets.find((t) => t.id === 'k1').updated_at, 'status open → in_progress');
r = await run('console.js', { method: 'POST', headers: ADMIN, body: { action: 'ticket_update', id: 'k1', status: 'resolved' } });
ok(r.ok && T.support_tickets.find((t) => t.id === 'k1').resolved_at, 'resolved stamps resolved_at');
r = await run('console.js', { method: 'POST', headers: ADMIN, body: { action: 'ticket_update', id: 'k1', status: 'open' } });
ok(r.ok && T.support_tickets.find((t) => t.id === 'k1').resolved_at === null, 'reopen clears resolved_at');
r = await run('console.js', { method: 'POST', headers: ADMIN, body: { action: 'ticket_update', id: 'k1', status: 'done' } });
ok(r.status === 400, 'unknown status refused');
r = await run('console.js', { method: 'POST', headers: ADMIN, body: { action: 'ticket_update', id: 'k1', admin_note: 'Their 10DLC is pending.' } });
ok(r.ok && T.support_tickets.find((t) => t.id === 'k1').admin_note === 'Their 10DLC is pending.', 'internal note saved');
r = await run('console.js', { method: 'POST', headers: ADMIN, body: { action: 'ticket_update', id: 'k5', claim: true } });
ok(r.ok && T.support_tickets.find((t) => t.id === 'k5').assigned_to === 'admin@loladesk.com' && T.support_tickets.find((t) => t.id === 'k5').status === 'in_progress', 'claim → assigned to me, in progress');

// Reply by text from the LolaDesk support line
process.env.TELNYX_API_KEY = 'tk';
T.platform_settings = [{ key: 'customer_care', value: { number: '+13055559999', assistant_id: 'a1' } }];
r = await run('console.js', { headers: ADMIN, query: { action: 'tickets' } });
ok(r.channels.sms === true && r.channels.sms_from === '+13055559999', 'support line configured → text replies available');
r = await run('console.js', { method: 'POST', headers: ADMIN, body: { action: 'ticket_reply', id: 'k2', message: 'Hi! Your number’s texting registration is approved now.' } });
const k2 = T.support_tickets.find((t) => t.id === 'k2');
ok(r.ok && r.via === 'sms' && texts.length === 1 && texts[0].from === '+13055559999' && texts[0].to === '+17865550002' && /approved/.test(texts[0].text), 'reply is a real text from the support line to the requester');
ok(Array.isArray(k2.replies) && k2.replies.length === 1 && k2.replies[0].via === 'sms' && k2.replies[0].by === 'admin@loladesk.com' && k2.status === 'in_progress', 'reply logged on the ticket; ticket moves to in progress');
r = await run('console.js', { method: 'POST', headers: ADMIN, body: { action: 'ticket_reply', id: 'k3', message: 'Calling you now' } });
ok(r.status === 400 && /email/.test(r.error) && texts.length === 1, 'no phone + no email provider → clear error (never a fake send)');
T.platform_settings.push({ key: 'customer_care_opt_outs', value: ['+17865550001'] });
r = await run('console.js', { method: 'POST', headers: ADMIN, body: { action: 'ticket_reply', id: 'k1', message: 'Hello' } });
ok(r.status === 409 && texts.length === 1, 'someone who texted STOP to the support line is not texted');
globalThis.fetch = async (url) => /telnyx/.test(String(url)) ? J({ errors: [{ detail: '10DLC not registered' }] }, 400) : J({});
r = await run('console.js', { method: 'POST', headers: ADMIN, body: { action: 'ticket_reply', id: 'k2', message: 'again' } });
ok(r.status === 502 && /10DLC/.test(r.error) && T.support_tickets.find((t) => t.id === 'k2').replies.length === 1, 'Telnyx refuses → 502 with the reason, not logged as sent');
delete process.env.TELNYX_API_KEY;

// ══ 6. Contact support from inside the app ══
seed(); T.tenant_users = [{ tenant_id: 't1', user_id: 'u-a', role: 'owner' }];
const n0 = T.support_tickets.length;
r = await run('customer-care.js', { method: 'POST', headers: OWNER, query: { action: 'contact' }, body: { message: 'How do I add a second stylist?', urgency: 'high' } });
const mine = T.support_tickets[T.support_tickets.length - 1];
ok(r.ok && T.support_tickets.length === n0 + 1 && mine.tenant_id === 't1' && mine.channel === 'app' && mine.business === 'One Salon' && mine.email === 'owner@salona.com' && mine.urgency === 'high' && mine.status === 'open', 'a signed-in owner’s request becomes a ticket tied to their salon (channel app)');
r = await run('customer-care.js', { method: 'POST', query: { action: 'contact' }, body: { message: 'hi there' } });
ok(r.status === 401 && T.support_tickets.length === n0 + 1, 'signed out → 401, nothing saved');
r = await run('customer-care.js', { method: 'POST', headers: { authorization: 'Bearer tok-x' }, query: { action: 'contact' }, body: { message: 'hi there' } });
ok(r.status === 404, 'a login with no salon → 404');
r = await run('customer-care.js', { method: 'POST', headers: OWNER, query: { action: 'contact' }, body: { message: '' } });
ok(r.status === 400, 'empty message refused');
r = await run('console.js', { headers: ADMIN, query: { action: 'help' } });
ok(r.ok && r.app.length === 1 && r.app[0].salon === 'One Salon' && r.common[0].phrase === 'texts arriving' && r.common[0].count === 2, 'Help: app requests with the salon name + most common issues grouped (' + r.common.map((c) => c.phrase + '×' + c.count).join(', ') + ')');
r = await run('customer-care.js', { method: 'GET', headers: OWNER });
ok(r.status === 403, 'the support-line setup itself stays admin-only');

// ══ 7. Analytics — every number in one place, vs the previous period ══
{
  const d = (n) => iso(now - n * DAY);
  for (const k of Object.keys(T)) if (!k.startsWith('__')) T[k] = [];
  T.tenants = [
    { id: 'a1', name: 'Alpha', plan: 'pro', billing_interval: 'monthly', subscription_status: 'active', created_at: d(100) },
    { id: 'a2', name: 'Beta', plan: 'starter', billing_interval: 'monthly', subscription_status: 'active', created_at: d(20) },
    { id: 'a3', name: 'Gamma', plan: 'starter', subscription_status: 'trial', trial_ends_at: d(5), created_at: d(25) },
    { id: 'a4', name: 'Delta', plan: 'pro', billing_interval: 'monthly', subscription_status: 'canceled', canceled_at: d(3), created_at: d(200) },
    { id: 'a5', name: 'Epsilon', plan: 'medspa', subscription_status: 'trial', trial_ends_at: iso(now + 5 * DAY), created_at: d(40) },
    { id: 'a6', name: '=HYPERLINK("x")', plan: 'starter', subscription_status: 'canceled', canceled_at: d(45), created_at: d(300) },
  ];
  T.billing_events = [
    { tenant_id: 'a2', type: 'checkout.session.completed', data: { subscription: 'sub_2' }, created_at: d(10) },
    { tenant_id: 'a1', type: 'invoice.payment_succeeded', amount: 39900, created_at: d(5) },
    { tenant_id: 'a2', type: 'invoice.payment_succeeded', amount: 9900, created_at: d(10) },
    { tenant_id: 'a1', type: 'invoice.payment_succeeded', amount: 39900, created_at: d(35) },
    { tenant_id: 'a1', type: 'checkout.session.completed', data: { subscription: null, account: 'acct_x' }, created_at: d(4) },   // a deposit checkout, not a subscription
  ];
  T.calls = [
    { tenant_id: 'a1', direction: 'inbound', duration_seconds: 60, created_at: d(1) }, { tenant_id: 'a1', direction: 'inbound', duration_seconds: 120, created_at: d(2) },
    { tenant_id: 'a1', direction: 'inbound', duration_seconds: 0, created_at: d(3) }, { tenant_id: 'a1', direction: 'outbound', duration_seconds: 30, created_at: d(3) },
    { tenant_id: 'a1', direction: 'inbound', duration_seconds: 30, created_at: d(40) },
  ];
  const u = (kind, n, units = 1, t = 'a1') => ({ tenant_id: t, kind, units, created_at: d(n) });
  T.usage_events = [u('sms_received', 1), u('sms_received', 2), u('sms_sent', 2), u('instagram_received', 3), u('widget_message', 1), u('widget_message', 2), u('widget_load', 1, 5), u('upsell_offered', 2), u('sms_received', 40),
    { tenant_id: 'a1', kind: 'cost_number_month', units: 100, metadata: { unit: 'cents' }, created_at: d(2) }, { tenant_id: 'a2', kind: 'cost_10dlc_brand', units: 400, metadata: { unit: 'cents' }, created_at: d(2) },
    { tenant_id: 'a1', kind: 'cost_number_month', units: 100, metadata: { unit: 'cents' }, created_at: d(40) }];
  T.conversations = [{ id: 'c1', tenant_id: 'a1', channel: 'phone', started_at: d(1) }, { id: 'c2', tenant_id: 'a1', channel: 'sms', started_at: d(3) }, { id: 'c3', tenant_id: 'a1', channel: 'web', started_at: d(4) }, { id: 'c4', tenant_id: 'a2', channel: 'instagram', started_at: d(20) }, { id: 'c5', tenant_id: 'a1', channel: 'phone', started_at: d(40) }];
  T.bookings = [
    { id: 'b1', tenant_id: 'a1', source: 'voice', status: 'confirmed', total_amount: 100, created_at: d(2) },
    { id: 'b2', tenant_id: 'a1', source: 'lola', conversation_id: 'c2', status: 'confirmed', total_amount: 50, created_at: d(3) },
    { id: 'b3', tenant_id: 'a1', source: 'public_widget', status: 'confirmed', total_amount: 80, created_at: d(4) },
    { id: 'b4', tenant_id: 'a1', source: 'dashboard', status: 'confirmed', total_amount: 200, created_at: d(1) },
    { id: 'b5', tenant_id: 'a1', source: 'waitlist', status: 'cancelled', total_amount: 60, created_at: d(6) },
    { id: 'b6', tenant_id: 'a2', source: 'instagram', status: 'confirmed', total_amount: 40, created_at: d(20) },
    { id: 'b7', tenant_id: 'a1', source: 'voice', status: 'confirmed', total_amount: 70, created_at: d(40) },
  ];
  T.booking_fees = [{ tenant_id: 'a1', status: 'earned', fee_cents: 300, created_at: d(2) }];
  T.payments = [{ tenant_id: 'a1', sub_kind: 'no_show_fee', status: 'succeeded', amount: 2500, created_at: d(3) }, { tenant_id: 'a1', sub_kind: 'no_show_fee', status: 'pending', amount: 1000, created_at: d(3) }];
  T.deposits = [{ tenant_id: 'a1', amount: 25, status: 'paid', created_at: d(2) }, { tenant_id: 'a1', amount: 10, status: 'pending', created_at: d(2) }];
  T.rebooking_offers = [{ tenant_id: 'a1', status: 'booked', created_at: d(9), updated_at: d(2) }, { tenant_id: 'a1', status: 'offered', created_at: d(9) }];
  T.booking_reminders = [{ tenant_id: 'a1', status: 'sent', sent_at: d(1), created_at: d(2) }, { tenant_id: 'a1', status: 'sent', sent_at: d(2), created_at: d(3) }];
  T.support_tickets = [
    { id: 's1', status: 'resolved', created_at: d(10), resolved_at: iso(now - 9 * DAY) },
    { id: 's2', status: 'resolved', created_at: d(5), resolved_at: iso(now - 5 * DAY + 2 * 36e5) },
    { id: 's3', status: 'open', created_at: d(1) }, { id: 's4', status: 'open', created_at: d(40) },
  ];
  r = await run('console.js', { headers: ADMIN, query: { action: 'analytics', days: '30' } });
  const A = r.analytics, G = A.growth, L = A.lola, C = A.costs, E = A.engagement;
  ok(r.ok && A.range.days === 30 && G.signups.cur === 2 && G.signups.prev === 1 && G.signups_daily.length === 30 && G.signups_daily.reduce((a, b) => a + b, 0) === 2, 'sign-ups: 2 this period vs 1 before, by day');
  ok(G.new_paying.cur === 1 && G.new_paying.prev === 0 && G.trial_to_paid_pct.cur === 50, 'trial → paid: 1 new subscription, 1 trial lapsed → 50% (a deposit checkout is not a subscription)');
  ok(G.mrr.cur === 39900 + 9900 && G.mrr.prev === 39900 + 39900, `MRR now $${G.mrr.cur / 100} vs start of range $${G.mrr.prev / 100} (rebuilt from Stripe events: Delta was paying, Beta wasn’t yet)`);
  ok(G.churned.cur === 1 && G.churned.prev === 1 && G.revenue_cents.cur === 49800 && G.revenue_cents.prev === 39900 && G.plan_mix.pro === 1 && G.plan_mix.starter === 1, 'churn 1 vs 1 · revenue collected $498 vs $399 · plan mix');
  ok(L.calls.cur === 3 && L.calls.prev === 1 && L.avg_call_seconds.cur === 90, 'calls answered 3 (outbound not counted) vs 1 · avg length 90s');
  ok(L.texts_in.cur === 2 && L.texts_in.prev === 1 && L.texts_out.cur === 1 && L.dms.cur === 1 && L.web_chats.cur === 2, 'texts in/out, DMs, web chats from usage_events');
  ok(L.bookings.cur === 4 && L.bookings.prev === 1 && JSON.stringify(L.bookings_by_channel) === JSON.stringify({ phone: 1, sms: 1, web: 1, dm: 1, other: 0 }), 'Lola bookings 4 (owner-made and cancelled excluded) by channel: phone/sms(via conversation)/web/dm');
  ok(L.value_created.cur === 270 && L.value_created.prev === 70 && L.conversion_pct.cur === 100, 'value Lola created $270 vs $70 · conversations → bookings 100%');
  ok(L.no_show_fees_cents.cur === 2500 && L.deposits_collected.cur === 25 && L.rebooks.cur === 1 && L.reminders_sent.cur === 2 && L.upsells_offered.cur === 1 && L.waitlist_fills.cur === 0, 'no-show fees (succeeded only), deposits (paid only), rebooks, reminders, upsells; a cancelled waitlist booking is no fill');
  ok(C.total_cents.cur === 500 && C.total_cents.prev === 100 && C.by_type.cost_number_month === 100 && C.by_type.cost_10dlc_brand === 400 && C.margin_cents.cur === 49800 + 300 - 500, 'costs by type, vs before; margin = revenue + fees − costs');
  ok(C.most_profitable[0].id === 'a1' && C.least_profitable[0].id === 'a2' && C.least_profitable[0].margin_cents === 9900 - 400, 'most / least profitable salons');
  ok(E.active_salons.cur === 2 && E.active_salons.prev === 1 && E.widget_loads.cur === 5 && E.web_bookings.cur === 1, 'active salons 2 vs 1 · widget loads · web bookings');
  ok(E.at_risk.map((x) => x.id).join(',') === 'a2,a3,a5', 'at risk = live salons with no booking in 14 days, paying first (' + E.at_risk.map((x) => x.id).join(',') + ')');
  ok(E.tickets.cur === 3 && E.tickets.prev === 1 && E.median_resolve_hours.cur === 13, 'tickets 3 vs 1 · median time to resolve 13h');
  ok(E.leaders[0].id === 'a1' && E.leaders[0].value_created === 230 && E.leaders[0].bookings === 4, 'leaderboard by value created');
  const a1 = A.salons.find((x) => x.id === 'a1');
  ok(A.salons.length === 6 && a1.lola_bookings === 3 && a1.calls === 3 && a1.texts === 3 && a1.chats === 3 && a1.revenue_cents === 39900 && a1.margin_cents === 39900 + 300 - 100, 'per-salon table: every salon, with bookings, calls, texts, chats, revenue, margin');
  r = await run('console.js', { headers: ADMIN, query: { action: 'analytics', days: '7' } });
  ok(r.analytics.range.days === 7 && r.analytics.lola.calls.cur === 3 && r.analytics.lola.bookings.cur === 3 && r.analytics.growth.signups.cur === 0, '7-day range recounts everything');
  r = await run('console.js', { headers: ADMIN, query: { action: 'analytics', days: '13' } });
  ok(r.analytics.range.days === 30, 'only 7 / 30 / 90 — anything else is 30');
  globalThis.__missing = new Set(['deposits', 'calls']);
  r = await run('console.js', { headers: ADMIN, query: { action: 'analytics' } });
  ok(r.analytics.lola.deposits_collected.cur === null && r.analytics.lola.calls.cur === null && r.analytics.lola.avg_call_seconds.cur === null && r.analytics.sources.calls === false && r.analytics.lola.bookings.cur === 4, 'a missing source shows — (null), never 0; the rest still works');
  globalThis.__missing = null;
  r = await run('console.js', { headers: ADMIN, query: { action: 'analytics', days: '30', format: 'csv' } });
  const lines = r.body.trim().split('\n');
  ok(r.status === 200 && /text\/csv/.test(r.headers['content-type']) && /attachment; filename="loladesk-salons-30d-/.test(r.headers['content-disposition']) && lines.length === 7 && /^Salon,Plan,Status,Bookings,Lola bookings,Value created/.test(lines[0]), 'CSV: header + one row per salon, downloadable');
  ok(lines.some((l) => l.startsWith('Alpha,pro,active,4,3,230,3,3,3,399.00,399.00,3.00,1.00,401.00,')) && lines.some((l) => l.startsWith(`"'=HYPERLINK(""x"")"`)), 'CSV values in dollars; a formula-looking salon name is neutralised');
  const x = await run('console.js', { headers: OWNER, query: { action: 'analytics', format: 'csv' } });
  ok(x.status === 403 && !x.body, 'a salon owner can’t pull the analytics CSV (403)');
}

// ══ 7. Schema + wiring ══
const mig = R('api/lib/migrate.js'), sql = R('sql/fixall-2026-10.sql');
ok(/SUPPORT_TICKETS_COLUMNS_DDL/.test(mig) && /ensureColumns\(c, 'support_tickets'/.test(mig), 'migrate.js self-adds the support_tickets workflow columns');
for (const col of ['tenant_id', 'admin_note', 'assigned_to', 'replies', 'resolved_at', 'updated_at']) ok(new RegExp('add column if not exists ' + col + '\\b').test(sql), 'fixall SQL adds support_tickets.' + col + ' (idempotent)');
ok(/create table if not exists public\.support_tickets/.test(sql), 'fixall SQL creates support_tickets if missing (safe to run twice)');
const vj = JSON.parse(R('vercel.json'));
ok(vj.rewrites.some((x) => x.source === '/console' && /console(\.html)?$/.test(x.destination)) && vj.rewrites.some((x) => x.source === '/b/:slug'), '/console route (existing rewrites kept)');
ok(/href="\/console"/.test(R('admin.html')) && /href="\/admin"/.test(R('console.html')), 'Command ↔ Console linked');
ok(/data-view="analytics"|\['analytics','Analytics'\]/.test(R('console.html')) && /action=analytics/.test(R('console.html')) && /format=csv/.test(R('console.html')), 'Console has Analytics (range picker, CSV) and Overview links into it');
ok(/data-ln-support/.test(R('sidebar.js')) && /action=contact/.test(R('sidebar.js')), 'Contact support in every app page’s account menu');

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
