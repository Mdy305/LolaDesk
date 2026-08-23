/**
 * tests/provision-balance.test.mjs — /api/provision-number credit handling.
 *
 * Run:
 *   node tests/provision-balance.test.mjs
 *
 * Exercises the REAL handler against the in-memory fake DB with Telnyx
 * stubbed via global fetch: a purchase rejected for insufficient credit
 * returns a friendly 402 (not a raw 500), GET surfaces the account balance,
 * and unrelated Telnyx failures still 500 with the real message.
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
writeFileSync(join(STUB_DIR, 'package.json'), JSON.stringify({
  name: '@supabase/supabase-js', version: '0.0.0-test', type: 'module',
  main: 'index.js', exports: { '.': './index.js' }
}, null, 2));
writeFileSync(join(STUB_DIR, 'index.js'), [
  '// Generated test double — see tests/provision-balance.test.mjs',
  'export function createClient() {',
  "  const fake = globalThis.__LOLA_FAKE_SUPABASE__;",
  "  if (!fake) throw new Error('No fake Supabase registered');",
  '  return fake;',
  '}', ''
].join('\n'));

const fake = new FakeSupabase();
globalThis.__LOLA_FAKE_SUPABASE__ = fake;
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'fake-service-key';
process.env.APP_URL = 'https://www.loladesk.com';
process.env.TELNYX_API_KEY = 'test-telnyx-key';
process.env.TELNYX_ORDER_SETTLE_MS = '0';

const { default: handler } = await import('../api/provision-number.js');

const T1 = '11111111-1111-1111-1111-111111111111';

// Telnyx stub — routable per test.
let numberOrdersMode = 'credit'; // 'credit' | 'generic'
globalThis.fetch = async (url, opts = {}) => {
  const path = String(url);
  const body = opts.body ? JSON.parse(opts.body) : {};
  const json = (o, ok = true) => ({ ok, json: async () => o });
  if (path.includes('/balance')) {
    return json({ data: { balance: '1.56', available_credit: '1.56', currency: 'USD' } });
  }
  if (path.includes('/available_phone_numbers')) {
    return json({ data: [{ phone_number: '+13055550123', region_information: [{ region_name: 'Florida' }], cost: { amount: '2.00' } }] });
  }
  if (path.includes('/texml_applications')) {
    if (opts.method === 'POST') return json({ data: { id: 'app-1' } });
    return json({ data: [] });
  }
  if (path.includes('/number_orders')) {
    if (numberOrdersMode === 'credit') {
      return json({ errors: [{ detail: 'Not enough credit for the order. Credit available: 1.56 Total cost of Order: 2.0' }] }, false);
    }
    return json({ errors: [{ detail: 'Telnyx exploded' }] }, false);
  }
  return json({ data: [] });
};

function seed() {
  fake.reset();
  fake.seed('tenants', [
    { id: T1, slug: 'salon-a', name: 'Salon A', owner_email: 'owner@salon-a.com', booking_url: 'https://www.loladesk.com/book.html?t=salon-a' }
  ]);
  fake.auth.users.set('tok-owner', { id: 'u1', email: 'owner@salon-a.com' });
}

function makeRes() {
  const out = { code: 200, body: null };
  return [{
    setHeader() {},
    status(c) { out.code = c; return this; },
    json(o) { out.body = o; return o; },
    end() { out.code = out.code || 200; }
  }, out];
}
function req(method, body) {
  const headers = { Authorization: 'Bearer tok-owner' };
  return { method, query: {}, headers, body: body ? JSON.stringify(body) : undefined, url: '/api/provision-number' };
}

test('low credit: POST returns friendly 402, not a raw 500', async () => {
  seed();
  numberOrdersMode = 'credit';
  const [res, out] = makeRes();
  await handler(req('POST', { phone_number: '+13055550123' }), res);
  assert.equal(out.code, 402);
  assert.equal(out.body.ok, false);
  assert.equal(out.body.code, 'insufficient_credit');
  assert.match(out.body.error, /top-up/i);
  assert.equal(out.body.balance.available_credit, 1.56);
  assert.match(out.body.detail, /Not enough credit/);
});

test('GET surfaces Telnyx account credit next to available numbers', async () => {
  seed();
  const [res, out] = makeRes();
  await handler(req('GET'), res);
  assert.equal(out.code, 200);
  assert.equal(out.body.ok, true);
  assert.equal(out.body.balance.available_credit, 1.56);
  assert.equal(out.body.numbers[0].phone_number, '+13055550123');
});

test('unrelated Telnyx failures still 500 with the real message', async () => {
  seed();
  numberOrdersMode = 'generic';
  const [res, out] = makeRes();
  await handler(req('POST', { phone_number: '+13055550123' }), res);
  assert.equal(out.code, 500);
  assert.equal(out.body.ok, false);
  assert.equal(out.body.error, 'Telnyx exploded');
});
