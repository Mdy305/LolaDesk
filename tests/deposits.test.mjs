/**
 * tests/deposits.test.mjs — the no-show protection loop (deposits), end to end.
 *
 * Run:
 *   node tests/deposits.test.mjs
 *   node --test tests/
 *
 * Before this, the deposit surface was dead code: a `deposits` table and
 * helpers existed with ZERO callers — no booking ever requested a deposit,
 * nothing enforced payment, nothing refunded in-window cancels. Proves the
 * revived loop against the in-memory fake DB:
 *   • policy resolution tolerates junk config (off / bad types / clamps)
 *   • deposit math (percent of total, floored at min, zero → null)
 *   • requestDeposit fires exactly one Payment-Link SMS with the persona copy
 *   • the skip ladder (policy off, no Stripe key, past start, no phone, $0)
 *   • the createCanonicalBooking seam (dashboard/public/voice/brain) and its
 *     sendConfirmation:false suppression (series bookings confirm once)
 *   • the Stripe webhook flips pending→paid and records the PaymentIntent
 *   • the hourly sweep: refund in-window, keep no-show/late-cancel/completed
 *     (silently), flag + text unpaid at start, void dead bookings
 *   • exactly-once: a second sweep pass re-runs nothing
 *   • settings metadata merge: a deposits save never clobbers sibling keys
 *   • the persona owns the client-facing copy (Beverly Hills valet voice)
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { FakeSupabase } from './fake-supabase.js';

// ── provision the @supabase/supabase-js test double ────────────────
const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STUB_DIR = join(API_ROOT, 'node_modules', '@supabase', 'supabase-js');
mkdirSync(STUB_DIR, { recursive: true });
writeFileSync(join(STUB_DIR, 'package.json'), JSON.stringify({
  name: '@supabase/supabase-js', version: '0.0.0-test', type: 'module', main: 'index.js', exports: { '.': './index.js' }
}, null, 2));
writeFileSync(join(STUB_DIR, 'index.js'), [
  '// Generated test double — see tests/deposits.test.mjs',
  'export function createClient() {',
  '  const fake = globalThis.__LOLA_FAKE_SUPABASE__;',
  "  if (!fake) throw new Error('No fake Supabase registered');",
  '  return fake;',
  '}',
  ''
].join('\n'));

const fake = new FakeSupabase();
globalThis.__LOLA_FAKE_SUPABASE__ = fake;
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'fake-service-key';

const deposits = await import('../api/lib/deposits.js');
const persona = await import('../api/lib/lola-persona.js');
const repo = await import('../api/lib/booking-repository.js');
const { default: webhook } = await import('../api/stripe-webhook.js');
const { default: settingsHandler } = await import('../api/booking-settings.js');

const T1 = 'tenant-dep';
const GHOST = 'tenant-ghost'; // no tenant row — SaaS-checkout events with it never touch provision
const TENANT = { id: T1, name: 'Valet Suites Beverly Hills', phone_number: '+15551000001', owner_email: 'owner@valetsuites.com' };
const CLIENT = { id: 'cl-1', tenant_id: T1, name: 'Maya', phone: '+15551000002' };
const SERVICE = { id: 'svc-1', tenant_id: T1, name: 'Balayage', price: 200, duration_minutes: 120, is_active: true };

function fresh({ depositsOn = true, settings } = {}){
  fake.reset();
  fake.seed('tenants', [TENANT]);
  fake.seed('booking_settings', [settings === undefined
    ? { tenant_id: T1, metadata: { public_note: 'keep me', ...(depositsOn ? { deposits: { enabled: true, percent: 25, min_cents: 0, grace_minutes: 0 } } : {}) } }
    : settings]);
  fake.seed('clients', [CLIENT]);
  fake.seed('services', [SERVICE]);
  fake.seed('bookings', []);
  fake.seed('deposits', []);
  fake.seed('billing_events', []);
}

// One fetch stub covering both vendors the loop talks to: Stripe REST
// (payment links + refunds) and the Telnyx SMS POST (recorded).
function stubVendors(){
  const sms = [];
  const stripe = { links: 0, refunds: [] };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/v2/messages')){
      sms.push(JSON.parse(opts.body || '{}'));
      return { ok: true, status: 200, json: async () => ({ data: { id: 'msg-1' } }) };
    }
    if (u.includes('api.stripe.com/v1/payment_links')){
      stripe.links++;
      return { ok: true, status: 200, json: async () => ({ id: `plink_${stripe.links}`, url: `https://buy.stripe.com/test_${stripe.links}` }) };
    }
    if (u.includes('api.stripe.com/v1/refunds')){
      const body = opts.body || '';
      stripe.refunds.push(String(body));
      return { ok: true, status: 200, json: async () => ({ id: 're_1', status: 'succeeded' }) };
    }
    return realFetch(url, opts);
  };
  return { sms, stripe, restore: () => { globalThis.fetch = realFetch; } };
}

const HOUR = 3600000;
function futureBooking(overrides = {}){
  return {
    id: 'bk-1', tenant_id: T1, client_id: CLIENT.id, service_id: SERVICE.id,
    start_time: new Date(Date.now() + 24 * HOUR).toISOString(),
    end_time: new Date(Date.now() + 24 * HOUR + 2 * HOUR).toISOString(),
    status: 'confirmed', total_amount: 200, ...overrides
  };
}
function seedBooking(b){ fake.seed('bookings', [b]); }

function depositRow(overrides = {}){
  return { id: 'dep-1', tenant_id: T1, booking_id: 'bk-1', amount: 50,
    status: 'pending', stripe_payment_intent_id: 'plink_1', created_at: new Date().toISOString(), ...overrides };
}

// ── policy resolution ──────────────────────────────────────────────
test('resolvePolicy is null when deposits are off or junk', () => {
  assert.equal(deposits.resolvePolicy(null), null);
  assert.equal(deposits.resolvePolicy({ metadata: {} }), null);
  assert.equal(deposits.resolvePolicy({ metadata: { deposits: { enabled: false, percent: 50 } } }), null);
  assert.equal(deposits.resolvePolicy({ metadata: { deposits: 'yes' } }), null);
});

test('resolvePolicy clamps and defaults bad values', () => {
  const p = deposits.resolvePolicy({ metadata: { deposits: { enabled: true, percent: 500, min_cents: -5, grace_minutes: 'x' } } });
  assert.equal(p.percent, 100);
  assert.equal(p.min_cents, 0);
  assert.equal(p.grace_minutes, 0);
  const d = deposits.resolvePolicy({ metadata: { deposits: { enabled: true } } });
  assert.equal(d.percent, deposits.DEPOSIT_DEFAULTS.percent);
});

// ── deposit math ───────────────────────────────────────────────────
// total_amount is dollars (repo convention); result is Stripe cents.
test('depositAmountCents: percent of total, floored at min, zero → null', () => {
  const p = { percent: 25, min_cents: 0 };
  assert.equal(deposits.depositAmountCents(200, p), 5000);   // $200 → $50
  assert.equal(deposits.depositAmountCents(19.99, p), 500);  // $4.9975 → rounds
  assert.equal(deposits.depositAmountCents(20, { percent: 25, min_cents: 1000 }), 1000); // floored at $10
  assert.equal(deposits.depositAmountCents(0, p), null);
  assert.equal(deposits.depositAmountCents('junk', p), null);
});

// ── requestDeposit ─────────────────────────────────────────────────
test('requestDeposit creates the deposit and texts the Payment Link', async () => {
  fresh();
  const v = stubVendors();
  process.env.STRIPE_SECRET_KEY = 'sk_test_dep';
  try{
    const r = await deposits.requestDeposit({ tenantId: T1, booking: futureBooking(), policy: { enabled: true, percent: 25, min_cents: 0, grace_minutes: 0 } });
    assert.equal(r.ok, true);
    assert.equal(r.amount_cents, 5000);
    const rows = fake.tables.get('deposits') || [];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'pending');
    assert.equal(rows[0].amount, 50);
    assert.equal(rows[0].stripe_payment_intent_id, 'plink_1');
    assert.equal(v.sms.length, 1);
    assert.ok(v.sms[0].to === CLIENT.phone);
    assert.ok(v.sms[0].text.includes('https://buy.stripe.com/test_1'));
    assert.ok(v.sms[0].text.includes('$50.00'));
    assert.ok(v.sms[0].text.includes('Balayage'));
  } finally { v.restore(); delete process.env.STRIPE_SECRET_KEY; }
});

test('requestDeposit skip ladder: policy off, no stripe key, past start, no phone, $0', async () => {
  fresh({ depositsOn: false });
  const v = stubVendors();
  process.env.STRIPE_SECRET_KEY = 'sk_test_dep';
  try{
    let r = await deposits.requestDeposit({ tenantId: T1, booking: futureBooking() });
    assert.equal(r.reason, 'policy_off');

    fresh();
    delete process.env.STRIPE_SECRET_KEY;
    r = await deposits.requestDeposit({ tenantId: T1, booking: futureBooking() });
    assert.equal(r.reason, 'stripe_not_configured');
    process.env.STRIPE_SECRET_KEY = 'sk_test_dep';

    r = await deposits.requestDeposit({ tenantId: T1, booking: futureBooking({ start_time: new Date(Date.now() - HOUR).toISOString() }) });
    assert.equal(r.reason, 'start_passed');

    r = await deposits.requestDeposit({ tenantId: T1, booking: futureBooking({ client_id: 'cl-none' }) });
    assert.equal(r.reason, 'no_client_phone');

    r = await deposits.requestDeposit({ tenantId: T1, booking: futureBooking({ total_amount: 0 }) });
    assert.equal(r.reason, 'zero_amount');

    assert.equal((fake.tables.get('deposits') || []).length, 0);
    assert.equal(v.sms.length, 0);
  } finally { v.restore(); process.env.STRIPE_SECRET_KEY = 'sk_test_dep'; }
});

// ── the booking seam ───────────────────────────────────────────────
test('createCanonicalBooking fires the deposit request for confirmed bookings', async () => {
  fresh();
  const v = stubVendors();
  process.env.STRIPE_SECRET_KEY = 'sk_test_dep';
  try{
    const row = await repo.createCanonicalBooking({
      tenantId: T1, clientId: CLIENT.id, serviceId: SERVICE.id,
      startTime: futureBooking().start_time, endTime: futureBooking().end_time,
      status: 'confirmed', totalAmount: 200, source: 'dashboard', sendConfirmation: true
    });
    assert.ok(row && row.id);
    await new Promise(r => setImmediate(r)); // the deposit seam is fire-and-forget
    const rows = fake.tables.get('deposits') || [];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].booking_id, row.id);
    assert.equal(v.sms.length, 2); // confirmation + deposit request
    assert.ok(v.sms.some(s => String(s.text).includes('buy.stripe.com')));
  } finally { v.restore(); delete process.env.STRIPE_SECRET_KEY; }
});

test('series bookings (sendConfirmation:false) never request a deposit — one confirmation per series', async () => {
  fresh();
  const v = stubVendors();
  process.env.STRIPE_SECRET_KEY = 'sk_test_dep';
  try{
    await repo.createCanonicalBooking({
      tenantId: T1, clientId: CLIENT.id, serviceId: SERVICE.id,
      startTime: futureBooking().start_time, endTime: futureBooking().end_time,
      status: 'confirmed', totalAmount: 200, source: 'salon', sendConfirmation: false
    });
    assert.equal((fake.tables.get('deposits') || []).length, 0);
    assert.equal(v.sms.length, 0);
  } finally { v.restore(); delete process.env.STRIPE_SECRET_KEY; }
});

// ── the Stripe webhook flip ────────────────────────────────────────
function webhookReq(payload){
  const body = JSON.stringify(payload);
  const t = '1700000000';
  const v1 = createHmac('sha256', 'whsec_test').update(`${t}.${body}`).digest('hex');
  let sent = false;
  return {
    method: 'POST',
    headers: { 'stripe-signature': `t=${t},v1=${v1}` },
    [Symbol.asyncIterator]() {
      return { next() {
        if (sent) return Promise.resolve({ done: true });
        sent = true;
        return Promise.resolve({ value: body, done: false });
      } };
    }
  };
}
async function callWebhook(payload){
  const res = { statusCode: 200, headers: {}, body: null };
  res.status = function(code){ this.statusCode = code; return this; };
  res.setHeader = function(k, val){ this.headers[k] = val; return this; };
  res.json = function(data){ this.body = data; return this; };
  await webhook(webhookReq(payload), res);
  return res;
}

test('checkout.session.completed on a payment link flips the deposit to paid with the real intent', async () => {
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  process.env.TELNYX_API_KEY = 'key123';
  fresh();
  fake.seed('deposits', [depositRow()]);
  const res = await callWebhook({ id: 'evt_1', type: 'checkout.session.completed',
    data: { object: { id: 'cs_1', payment_link: 'plink_1', payment_intent: 'pi_1', metadata: {} } } });
  assert.equal(res.statusCode, 200);
  const row = (fake.tables.get('deposits') || [])[0];
  assert.equal(row.status, 'paid');
  assert.equal(row.stripe_payment_intent_id, 'pi_1');
});

test('SaaS checkouts (no payment_link) never touch deposits; duplicate events are idempotent', async () => {
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  process.env.TELNYX_API_KEY = 'key123';
  fresh();
  fake.seed('deposits', [depositRow()]);
  await callWebhook({ id: 'evt_2', type: 'checkout.session.completed',
    data: { object: { id: 'cs_2', payment_intent: 'pi_9', metadata: { tenantId: GHOST } } } });
  assert.equal((fake.tables.get('deposits') || [])[0].status, 'pending');
  // The dup guard keys on billing_events: evt_1 was consumed earlier in this
  // file; replaying it must short-circuit before touching anything.
  const dup = await callWebhook({ id: 'evt_2', type: 'checkout.session.completed',
    data: { object: { id: 'cs_1', payment_link: 'plink_1', payment_intent: 'pi_1', metadata: {} } } });
  assert.equal(dup.body.duplicate, true);
});

// ── the hourly sweep ───────────────────────────────────────────────
test('sweep: unpaid inside the window is skipped silently', async () => {
  fresh();
  seedBooking(futureBooking({ start_time: new Date(Date.now() + 60 * 60000).toISOString() }));
  fake.seed('deposits', [depositRow()]);
  const r = await deposits.runDepositSweep(new Date());
  assert.equal(r.checked, 1);
  assert.equal(r.skipped, 1);
  assert.equal((fake.tables.get('deposits') || [])[0].status, 'pending');
});

test('sweep: unpaid at start time is flagged with one text', async () => {
  fresh();
  const v = stubVendors();
  try{
    seedBooking(futureBooking({ start_time: new Date(Date.now() - 60000).toISOString() }));
    fake.seed('deposits', [depositRow()]);
    const r = await deposits.runDepositSweep(new Date());
    assert.equal(r.flagged, 1);
    assert.equal((fake.tables.get('deposits') || [])[0].status, 'flagged');
    assert.equal(v.sms.length, 1);
    assert.ok(v.sms[0].text.includes('Maya'));
  } finally { v.restore(); }
});

test('sweep: unpaid on a dead booking is voided without a text', async () => {
  fresh();
  const v = stubVendors();
  try{
    seedBooking(futureBooking({ start_time: new Date(Date.now() - 60000).toISOString(), status: 'cancelled' }));
    fake.seed('deposits', [depositRow()]);
    const r = await deposits.runDepositSweep(new Date());
    assert.equal(r.voided, 1);
    assert.equal(v.sms.length, 0);
  } finally { v.restore(); }
});

test('sweep: paid + in-window cancellation is refunded and texted', async () => {
  fresh();
  const v = stubVendors();
  try{
    seedBooking(futureBooking({
      start_time: new Date(Date.now() + 24 * HOUR).toISOString(),
      status: 'cancelled', updated_at: new Date(Date.now() - 60000).toISOString()
    }));
    fake.seed('deposits', [depositRow({ status: 'paid', stripe_payment_intent_id: 'pi_refund' })]);
    const r = await deposits.runDepositSweep(new Date());
    assert.equal(r.refunded, 1);
    const row = (fake.tables.get('deposits') || [])[0];
    assert.equal(row.status, 'refunded');
    assert.equal(v.stripe.refunds.length, 1);
    assert.ok(v.stripe.refunds[0].includes('pi_refund'));
    assert.equal(v.sms.length, 1);
    assert.ok(v.sms[0].text.includes('$50.00'));
  } finally { v.restore(); }
});

test('sweep: paid + late cancellation (after the cutoff) keeps the deposit', async () => {
  fresh();
  const v = stubVendors();
  try{
    seedBooking(futureBooking({
      start_time: new Date(Date.now() - 30 * 60000).toISOString(),
      status: 'cancelled', updated_at: new Date(Date.now() - 5 * 60000).toISOString()
    }));
    fake.seed('deposits', [depositRow({ status: 'paid', stripe_payment_intent_id: 'pi_keep' })]);
    const r = await deposits.runDepositSweep(new Date());
    assert.equal(r.kept, 1);
    assert.equal((fake.tables.get('deposits') || [])[0].status, 'kept');
    assert.equal(v.stripe.refunds.length, 0);
    assert.equal(v.sms.length, 1); // kept text
  } finally { v.restore(); }
});

test('sweep: no-show keeps the deposit with the kept text; completed keeps it silently', async () => {
  fresh();
  const v = stubVendors();
  try{
    seedBooking(futureBooking({ start_time: new Date(Date.now() - HOUR).toISOString(), status: 'no_show' }));
    fake.seed('deposits', [depositRow({ status: 'paid', stripe_payment_intent_id: 'pi_ns' })]);
    let r = await deposits.runDepositSweep(new Date());
    assert.equal(r.kept, 1);
    assert.equal(v.sms.length, 1);

    seedBooking(futureBooking({ start_time: new Date(Date.now() - HOUR).toISOString(), status: 'completed' }));
    fake.seed('deposits', [depositRow({ id: 'dep-2', status: 'paid', stripe_payment_intent_id: 'pi_done' })]);
    r = await deposits.runDepositSweep(new Date());
    assert.equal(r.kept, 1);
    assert.equal(v.sms.length, 1); // unchanged — completed is silent
  } finally { v.restore(); }
});

test('sweep is exactly-once: a second pass re-runs nothing', async () => {
  fresh();
  const v = stubVendors();
  try{
    seedBooking(futureBooking({ start_time: new Date(Date.now() - 60000).toISOString() }));
    fake.seed('deposits', [depositRow()]);
    await deposits.runDepositSweep(new Date());
    const r2 = await deposits.runDepositSweep(new Date());
    assert.equal(r2.flagged, 0);
    assert.equal(r2.checked, 0); // row left the pending/paid queues
    assert.equal(v.sms.length, 1);
  } finally { v.restore(); }
});

// ── settings metadata merge ────────────────────────────────────────
test('saving the deposit policy merges into metadata instead of clobbering sibling keys', async () => {
  process.env.ADMIN_EMAILS = '';
  fresh();
  fake.auth.users.set('tok-owner', { id: 'u1', email: 'owner@valetsuites.com' });
  const res = { statusCode: 200, headers: {}, body: null };
  res.status = function(code){ this.statusCode = code; return this; };
  res.setHeader = function(){ return res; };
  res.json = function(data){ res.body = data; return res; };
  await settingsHandler({
    method: 'POST',
    headers: { authorization: 'Bearer tok-owner' },
    body: JSON.stringify({ metadata: { deposits: { enabled: true, percent: 30 } } }),
    query: {}
  }, res);
  assert.equal(res.statusCode, 200);
  const saved = (fake.tables.get('booking_settings') || [])[0];
  assert.equal(saved.metadata.deposits.percent, 30);
  assert.equal(saved.metadata.public_note, 'keep me'); // sibling key survived
});

// ── persona owns the copy ──────────────────────────────────────────
test('deposit copy speaks in the Beverly Hills valet voice with the facts intact', () => {
  const req = persona.depositRequestText({ firstName: 'Maya', salon: 'Valet Suites', serviceName: 'Balayage', when: 'Fri, Jan 9, 2:00 PM', amount: '$50.00', link: 'https://buy.stripe.com/x' });
  assert.ok(req.includes('Maya') && req.includes('$50.00') && req.includes('https://buy.stripe.com/x') && req.includes('Valet Suites'));
  assert.ok(req.includes('STOP'));
  const kept = persona.depositKeptText({ firstName: 'Maya', salon: 'Valet Suites', amount: '$50.00' });
  assert.ok(kept.includes('$50.00') && kept.includes('STOP'));
  const ref = persona.depositRefundText({ firstName: 'Maya', salon: 'Valet Suites', amount: '$50.00' });
  assert.ok(ref.includes('refund') || ref.includes('on its way back'), 'refund text should say the money is coming back');
  const un = persona.depositUnpaidText({ firstName: 'Maya', salon: 'Valet Suites', serviceName: 'Balayage', when: 'Fri, Jan 9, 2:00 PM' });
  assert.ok(un.includes('Balayage') && un.includes('STOP'));
});
