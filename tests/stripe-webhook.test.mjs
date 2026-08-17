/**
 * tests/stripe-webhook.test.mjs — production Stripe webhook pipeline.
 *
 * checkout.session.completed -> Telnyx auto-provision -> tenant activation,
 * with idempotency, subscription lifecycle, and the provisioning_pending
 * fallback when Telnyx fails. The REAL api/stripe-webhook.js runs against
 * an in-memory Supabase stand-in and a stubbed Telnyx API (global fetch).
 */

import { createHmac } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeSupabase } from './fake-supabase.js';

// ── provision the @supabase/supabase-js test double (as in booking-brain) ──
const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STUB_DIR = join(API_ROOT, 'node_modules', '@supabase', 'supabase-js');
mkdirSync(STUB_DIR, { recursive: true });
writeFileSync(join(STUB_DIR, 'package.json'), JSON.stringify({
  name: '@supabase/supabase-js', version: '0.0.0-test', type: 'module', main: 'index.js', exports: { '.': './index.js' }
}, null, 2));
writeFileSync(join(STUB_DIR, 'index.js'), [
  '// Generated test double — see tests/stripe-webhook.test.mjs',
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
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
process.env.TELNYX_API_KEY = 'key123';
process.env.TELNYX_ORDER_SETTLE_MS = '0';
process.env.APP_URL = 'https://www.loladesk.com';

const { default: handler } = await import('../api/stripe-webhook.js');

// ── helpers ─────────────────────────────────────────────────────────
function sign(body){
  const t = '1700000000';
  const v1 = createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(`${t}.${body}`).digest('hex');
  return `t=${t},v1=${v1}`;
}
function makeReq(payload){
  const body = JSON.stringify(payload);
  let sent = false;
  return {
    method: 'POST',
    headers: { 'stripe-signature': sign(body) },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if(sent) return Promise.resolve({ done: true });
          sent = true;
          return Promise.resolve({ value: body, done: false });
        }
      };
    }
  };
}
function makeRes(){
  const res = { statusCode: 200, headers: {}, body: null };
  res.status = function(code){ this.statusCode = code; return this; };
  res.setHeader = function(k, v){ this.headers[k] = v; return this; };
  res.json = function(data){ this.body = data; return this; };
  return res;
}
function event(id, type, object){
  return { id, type, data: { object } };
}

// Telnyx API stub: real endpoint shapes, counted calls.
function stubTelnyx({ failSearch = false } = {}){
  const calls = { search: 0, orders: 0, phoneLookup: 0 };
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = opts.method || 'GET';
    if(u.includes('/available_phone_numbers')){
      calls.search++;
      if(failSearch) return { ok: false, status: 422, json: async () => ({ errors: [{ detail: 'best_effort: no numbers found' }] }) };
      return { ok: true, status: 200, json: async () => ({ data: [{ phone_number: '+13055550100', region_information: [{ region_name: 'Florida' }] }] }) };
    }
    if(u.includes('/texml_applications')) return { ok: true, status: 200, json: async () => ({ data: [{ id: 'app-1', name: 'LolaDesk', webhook_url: 'https://www.loladesk.com/api/telnyx-voice' }] }) };
    if(u.includes('/number_orders')){
      calls.orders++;
      return { ok: true, status: 200, json: async () => ({ data: { id: 'order-1' } }) };
    }
    if(u.includes('/phone_numbers?filter')){
      calls.phoneLookup++;
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 'pn-1' }] }) };
    }
    return { ok: true, status: 200, json: async () => ({ data: {} }) };
  };
  return calls;
}

const TENANT = { id: 'tenant-1', slug: 'salon-a', name: 'Salon A', booking_url: null, stripe_customer_id: null, stripe_subscription_id: null, subscription_status: 'trial', plan: 'starter', provisioning_status: null };

// ── tests ───────────────────────────────────────────────────────────
test('checkout.session.completed auto-provisions a Telnyx number and activates the tenant', async () => {
  fake.reset();
  fake.seed('tenants', [{ ...TENANT }]);
  const calls = stubTelnyx();

  const res = makeRes();
  await handler(makeReq(event('evt-1', 'checkout.session.completed', {
    metadata: { tenant_id: 'tenant-1', tenantId: 'tenant-1', plan: 'pro', preferred_area_code: '305' },
    customer: 'cus_1', subscription: 'sub_1'
  })), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { received: true });

  const tenant = fake.all('tenants')[0];
  assert.equal(tenant.phone_number, '+13055550100');
  assert.equal(tenant.stripe_customer_id, 'cus_1');
  assert.equal(tenant.stripe_subscription_id, 'sub_1');
  assert.equal(tenant.subscription_status, 'active');
  assert.equal(tenant.plan, 'pro');
  assert.equal(tenant.provisioning_status, 'active');
  assert.equal(tenant.telnyx_phone_id, 'pn-1');

  // routing table kept in sync so inbound calls resolve immediately
  const route = fake.all('tenant_numbers').find(r => r.phone_number === '+13055550100');
  assert.ok(route, 'tenant_numbers routing row should exist');
  assert.equal(route.tenant_id, 'tenant-1');

  // idempotency log recorded
  assert.ok(fake.all('billing_events').some(b => b.stripe_event_id === 'evt-1'));

  // replaying the same event is a no-op (no second number order)
  const res2 = makeRes();
  await handler(makeReq(event('evt-1', 'checkout.session.completed', {
    metadata: { tenant_id: 'tenant-1' }, customer: 'cus_1', subscription: 'sub_1'
  })), res2);
  assert.equal(res2.body.duplicate, true);
  assert.equal(calls.orders, 1);
});

test('Telnyx failure falls back to provisioning_pending without losing the payment status', async () => {
  fake.reset();
  fake.seed('tenants', [{ ...TENANT }]);
  stubTelnyx({ failSearch: true });

  const res = makeRes();
  await handler(makeReq(event('evt-2', 'checkout.session.completed', {
    metadata: { tenant_id: 'tenant-1' }, customer: 'cus_2', subscription: 'sub_2'
  })), res);

  assert.equal(res.statusCode, 200);
  const tenant = fake.all('tenants')[0];
  assert.equal(tenant.subscription_status, 'active');        // paid — never punish the customer
  assert.equal(tenant.provisioning_status, 'provisioning_pending');
  assert.ok(tenant.provisioning_error);
});

test('invalid signature is rejected with 400', async () => {
  fake.reset();
  const body = JSON.stringify(event('evt-9', 'invoice.payment_failed', { customer: 'cus_1' }));
  const req = {
    method: 'POST',
    headers: { 'stripe-signature': 't=1,v1=deadbeef' },
    [Symbol.asyncIterator]() { let s = false; return { next: () => s ? Promise.resolve({ done: true }) : (s = true, Promise.resolve({ value: body, done: false })) }; }
  };
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'Invalid signature');
});

test('subscription lifecycle: deleted -> canceled, payment_failed -> past_due', async () => {
  fake.reset();
  fake.seed('tenants', [{ ...TENANT, stripe_subscription_id: 'sub_9', stripe_customer_id: 'cus_9', subscription_status: 'active' }]);
  stubTelnyx();

  // customer.subscription.deleted
  await handler(makeReq(event('evt-3', 'customer.subscription.deleted', { id: 'sub_9' })), makeRes());
  assert.equal(fake.all('tenants')[0].subscription_status, 'canceled');

  // invoice.payment_failed
  fake.seed('tenants', [{ ...TENANT, stripe_customer_id: 'cus_9', subscription_status: 'active' }]);
  await handler(makeReq(event('evt-4', 'invoice.payment_failed', { customer: 'cus_9' })), makeRes());
  assert.equal(fake.all('tenants')[0].subscription_status, 'past_due');

  // invoice.payment_succeeded restores active
  await handler(makeReq(event('evt-5', 'invoice.payment_succeeded', { customer: 'cus_9' })), makeRes());
  assert.equal(fake.all('tenants')[0].subscription_status, 'active');
});
