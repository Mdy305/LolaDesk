/**
 * tests/payments-system.test.mjs — money home, Get paid now, the front-desk reader,
 * and Lola's money phrases.
 *
 * Run:
 *   node --test tests/payments-system.test.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeSupabase } from './fake-supabase.js';

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STUB_DIR = join(API_ROOT, 'node_modules', '@supabase', 'supabase-js');
mkdirSync(STUB_DIR, { recursive: true });
writeFileSync(join(STUB_DIR, 'package.json'), JSON.stringify({ name: '@supabase/supabase-js', version: '0.0.0-test', type: 'module', main: 'index.js', exports: { '.': './index.js' } }, null, 2));
writeFileSync(join(STUB_DIR, 'index.js'), "export function createClient(){const f=globalThis.__LOLA_FAKE_SUPABASE__;if(!f)throw new Error('No fake Supabase registered');return f;}\n");

const fake = new FakeSupabase();
globalThis.__LOLA_FAKE_SUPABASE__ = fake;
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'fake-service-key';
process.env.STRIPE_SECRET_KEY = 'sk_test_x';
process.env.PAYMENTS_FEE_PERCENT = '3.4';
process.env.PAYMENTS_FEE_CENTS = '30';

// Stripe REST double: readers belong to tenants by metadata; records every call.
const calls = [];
const readers = { tmr_mine: { id: 'tmr_mine', label: 'Front desk', status: 'online', metadata: { tenant_id: 't1' } }, tmr_other: { id: 'tmr_other', metadata: { tenant_id: 't2' } } };
globalThis.fetch = async (url, init = {}) => {
  const u = String(url).replace('https://api.stripe.com/v1', '');
  const body = String(init.body || '');
  calls.push({ method: init.method || 'GET', path: u, body });
  let json = {};
  const m = u.match(/^\/terminal\/readers\/(tmr_[a-z_]+)$/);
  if (m) json = readers[m[1]] || { error: { message: 'No such reader' } };
  else if (u === '/payment_intents' && init.method === 'POST') json = { id: 'pi_new', status: 'requires_payment_method' };
  else if (/process_payment_intent$/.test(u)) json = { id: 'tmr_mine', action: { status: 'in_progress' } };
  return { ok: !json.error, status: json.error ? 404 : 200, json: async () => json };
};

const { readyFromBalance, collectedToday, payOut } = await import('../api/lib/money.js');
const { startReaderSale } = await import('../api/lib/terminal.js');
const { routeOwnerIntent } = await import('../api/lib/owner-intents.js');

test('ready = the instant amount after LolaDesk’s instant fee, to the best destination', () => {
  const r = readyFromBalance({
    available: [{ amount: 100000, currency: 'usd' }], pending: [{ amount: 5000, currency: 'usd' }],
    instant_available: [{ amount: 128400, currency: 'usd', net_available: [{ amount: 126474, destination: 'card_1' }, { amount: 120000, destination: 'ba_2' }] }],
  });
  assert.deepEqual([r.ready_cents, r.instant, r.destination, r.instant_fee_cents], [126474, true, 'card_1', 1926]);
});

test('no instant destination → the normal available balance, standard payout', () => {
  const r = readyFromBalance({ available: [{ amount: 42000, currency: 'usd' }], pending: [], instant_available: [{ amount: 42000, currency: 'usd' }] });
  assert.deepEqual([r.ready_cents, r.instant, r.destination], [42000, false, null]);
  assert.equal(readyFromBalance(null).ready_cents, 0);
});

test('today: deposits (dollars), no-show fees and card sales (cents), clients counted once each', async () => {
  fake.reset();
  const now = new Date('2026-10-26T18:00:00Z');
  const today = '2026-10-26T15:00:00Z', yesterday = '2026-10-25T15:00:00Z';
  fake.seed('deposits', [
    { tenant_id: 't1', amount: 50, status: 'paid', booking_id: 'b1', created_at: today },
    { tenant_id: 't1', amount: 50, status: 'pending', booking_id: 'b2', created_at: today },
    { tenant_id: 't1', amount: 75, status: 'paid', booking_id: 'b3', created_at: yesterday },
  ]);
  fake.seed('payments', [{ tenant_id: 't1', sub_kind: 'no_show_fee', status: 'succeeded', amount: 4500, client_id: 'c9', created_at: today }]);
  fake.seed('pos_transactions', [
    { tenant_id: 't1', status: 'paid', total_cents: 21000, client_id: 'c1', paid_at: today },
    { tenant_id: 't1', status: 'pending_card', total_cents: 9900, client_id: 'c2', paid_at: null },
  ]);
  const t = await collectedToday(fake, 't1', { tz: 'America/New_York', now });
  assert.deepEqual([t.deposits_cents, t.no_show_cents, t.card_sales_cents, t.total_cents, t.clients], [5000, 4500, 21000, 30500, 3]);
});

test('Get paid now: instant to the eligible card, with a one-tap key', async () => {
  fake.reset();
  fake.seed('stripe_connect_accounts', [{ tenant_id: 't1', stripe_account_id: 'acct_salon', charges_enabled: true, payouts_enabled: true }]);
  const made = [];
  const api = {
    balance: { retrieve: async () => ({ available: [{ amount: 90000, currency: 'usd' }], pending: [], instant_available: [{ amount: 90000, currency: 'usd', net_available: [{ amount: 88650, destination: 'card_1' }] }] }) },
    payouts: { create: async (p, o) => { made.push([p, o]); return { id: 'po_1', amount: p.amount, method: p.method, arrival_date: 1793000000 }; } },
  };
  const r = await payOut('t1', { c: fake, api, idempotencyKey: 'k1' });
  assert.equal(r.ok, true);
  assert.deepEqual(made[0][0], { amount: 88650, currency: 'usd', method: 'instant', destination: 'card_1' });
  assert.deepEqual(made[0][1], { stripeAccount: 'acct_salon', idempotencyKey: 'k1' });
  assert.match(r.say, /\$886\.5 is on its way and usually lands in about 30 minutes/);
});

test('Get paid now: nothing ready / payments off / Stripe still needs details', async () => {
  fake.reset();
  assert.match((await payOut('t1', { c: fake, api: {} })).say, /Turn on payments first/);
  fake.seed('stripe_connect_accounts', [{ tenant_id: 't1', stripe_account_id: 'acct_salon', payouts_enabled: false }]);
  assert.match((await payOut('t1', { c: fake, api: {} })).say, /Stripe still needs a few details/);
  fake.seed('stripe_connect_accounts', [{ tenant_id: 't1', stripe_account_id: 'acct_salon', payouts_enabled: true }]);
  const api = { balance: { retrieve: async () => ({ available: [], pending: [{ amount: 3000, currency: 'usd' }] }) }, payouts: { create: async () => { throw new Error('should not pay'); } } };
  assert.match((await payOut('t1', { c: fake, api })).say, /\$30 is still clearing/);
});

test('reader sale: only the salon’s own reader; card_present to the salon with LolaDesk’s fee; sent to the reader', async () => {
  fake.reset();
  fake.seed('stripe_connect_accounts', [{ tenant_id: 't1', stripe_account_id: 'acct_salon', charges_enabled: true }]);
  calls.length = 0;
  const no = await startReaderSale({ id: 't1' }, { readerId: 'tmr_other', amountCents: 10000 });
  assert.equal(no.ok, false);
  assert.equal(calls.some((x) => x.path === '/payment_intents'), false);

  calls.length = 0;
  const ok = await startReaderSale({ id: 't1' }, { readerId: 'tmr_mine', amountCents: 10000, description: 'Balayage' });
  assert.equal(ok.ok, true);
  const pi = calls.find((x) => x.path === '/payment_intents' && x.method === 'POST');
  assert.match(pi.body, /payment_method_types\[0\]=card_present/);
  assert.match(pi.body, /transfer_data%5Bdestination%5D=acct_salon/);
  assert.match(pi.body, /on_behalf_of=acct_salon/);
  assert.match(pi.body, /application_fee_amount=370/);   // $100 → 3.4% + 30¢
  assert.match(pi.body, /metadata%5Bpos_sale%5D=true/);
  assert.ok(calls.some((x) => x.path === '/terminal/readers/tmr_mine/process_payment_intent' && /payment_intent=pi_new/.test(x.body)));
});

test('reader sale refuses when payments are off', async () => {
  fake.reset();
  const r = await startReaderSale({ id: 't1' }, { readerId: 'tmr_mine', amountCents: 10000 });
  assert.equal(r.ok, false);
  assert.match(r.say, /Turn on payments first/);
});

test('Lola hears money phrases', () => {
  assert.equal(routeOwnerIntent('pay me now')?.tool, 'pay_me_now');
  assert.equal(routeOwnerIntent('send the money to my bank')?.tool, 'pay_me_now');
  assert.equal(routeOwnerIntent('how much can I take out?')?.tool, 'money_today');
  assert.equal(routeOwnerIntent('did my deposits arrive')?.tool, 'verify_deposits');
  assert.equal(routeOwnerIntent('how much did I make today')?.tool, 'revenue_report');
});

// ── Transactions in detail ─────────────────────────────────────────
const { txFromIntent, listTransactions, refundTransaction } = await import('../api/lib/money.js');

test('a deposit paid with Apple Pay: amount, LolaDesk fee, what the salon receives', () => {
  const r = txFromIntent({ id: 'pi_d', created: 1792990000, status: 'succeeded', amount: 5000, amount_received: 5000, application_fee_amount: 200,
    metadata: { tenant_id: 't1', kind: 'deposit', booking_id: 'b1' },
    latest_charge: { amount_refunded: 0, receipt_url: 'https://pay.stripe.com/r/1', payment_method_details: { card: { brand: 'visa', last4: '4242', wallet: { type: 'apple_pay' } } } } });
  assert.equal(r.kind_label, 'Booking deposit');
  assert.deepEqual([r.amount_cents, r.fee_cents, r.net_cents, r.status], [5000, 200, 4800, 'paid']);
  assert.deepEqual(r.card, { brand: 'visa', last4: '4242', wallet: 'apple_pay' });
});

test('reader sale with tip, partly refunded; salon-account payments carry no LolaDesk fee', () => {
  const r = txFromIntent({ id: 'pi_p', created: 1, status: 'succeeded', amount: 21000, amount_received: 21000, application_fee_amount: 744,
    metadata: { pos_sale: 'true', payment_method: 'card', tip_cents: '3000', client_name: 'Ana Ruiz' },
    latest_charge: { amount_refunded: 5000, payment_method_details: { card_present: { brand: 'mastercard', last4: '1111' } } } });
  assert.deepEqual([r.kind, r.tip_cents, r.net_cents, r.status, r.card.last4], ['pos', 3000, 21000 - 744 - 5000, 'partially_refunded', '1111']);
  const d = txFromIntent({ id: 'pi_x', created: 1, status: 'succeeded', amount: 1000, amount_received: 1000, application_fee_amount: 99, metadata: {} }, { source: 'account' });
  assert.equal(d.fee_cents, 0);
});

test('transactions: both Stripe accounts, newest first, client and appointment filled in, totals', async () => {
  fake.reset();
  fake.seed('stripe_connect_accounts', [{ tenant_id: 't1', stripe_account_id: 'acct_salon' }]);
  fake.seed('bookings', [{ id: 'b1', tenant_id: 't1', client_id: 'c1', service: 'Balayage', stylist: 'Ana', start_time: '2026-10-30T18:00:00Z' }]);
  fake.seed('clients', [{ id: 'c1', tenant_id: 't1', first_name: 'Sarah', last_name: 'Cole' }]);
  const now = Math.floor(Date.now() / 1000);
  const queries = [];
  const api = { paymentIntents: { search: async (p, o) => {
    queries.push([p.query, o?.stripeAccount || null]);
    if (o?.stripeAccount) return { data: [{ id: 'pi_old', created: now - 60, status: 'succeeded', amount: 1500, amount_received: 1500, metadata: { tenant_id: 't1' }, latest_charge: {} }] };
    return { data: [{ id: 'pi_dep', created: now - 10, status: 'succeeded', amount: 5000, amount_received: 5000, application_fee_amount: 200, metadata: { tenant_id: 't1', kind: 'deposit', booking_id: 'b1' }, latest_charge: {} }] };
  } } };
  const out = await listTransactions('t1', { c: fake, api, since: new Date(Date.now() - 864e5) });
  assert.match(queries[0][0], /^metadata\['tenant_id'\]:'t1' AND created>\d+$/);
  assert.deepEqual(queries.map((q) => q[1]).sort(), [null, 'acct_salon'].sort());
  assert.deepEqual(out.rows.map((r) => r.id), ['pi_dep', 'pi_old']);
  assert.equal(out.rows[0].client_name, 'Sarah Cole');
  assert.equal(out.rows[0].booking.service, 'Balayage');
  assert.deepEqual([out.totals.count, out.totals.gross_cents, out.totals.fees_cents, out.totals.net_cents], [2, 6500, 200, 6300]);
});

test('refund: only the salon’s own paid payment; deposits pull the money back from the salon', async () => {
  fake.reset();
  const made = [];
  const api = {
    paymentIntents: { retrieve: async (id) => ({ pi_mine: { id: 'pi_mine', status: 'succeeded', metadata: { tenant_id: 't1' }, transfer_data: { destination: 'acct_salon' } }, pi_theirs: { id: 'pi_theirs', status: 'succeeded', metadata: { tenant_id: 't2' } } }[id] || (() => { throw new Error('no'); })()) },
    refunds: { create: async (p, o) => { made.push([p, o]); return { amount: 5000 }; } },
  };
  assert.equal((await refundTransaction('t1', 'pi_theirs', { c: fake, api })).ok, false);
  assert.equal(made.length, 0);
  const r = await refundTransaction('t1', 'pi_mine', { c: fake, api });
  assert.equal(r.ok, true);
  assert.equal(made[0][0].reverse_transfer, true);
  assert.equal(made[0][1].idempotencyKey, 'owner_refund_pi_mine');
});
