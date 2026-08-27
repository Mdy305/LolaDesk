/**
 * tests/provision-existing.test.mjs — /api/provision-number "use a number I
 * already own" path.
 *
 * Run:
 *   node tests/provision-existing.test.mjs
 *
 * Exercises the REAL handler against the in-memory fake DB with Telnyx
 * stubbed via global fetch: GET surfaces owned numbers, POST with
 * use_existing attaches voice + SMS + LolaBrain with NO number order (so no
 * credit is consumed), a number not on the account is rejected politely, and
 * the routing row + tenant.phone_number are persisted.
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
  '// Generated test double — see tests/provision-existing.test.mjs',
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
process.env.TELNYX_VOICE_APP_ID = '2982432232334951429';
process.env.TELNYX_MESSAGING_PROFILE_ID = 'mp-1';
process.env.TELNYX_LOLA_BRAIN_ID = 'asst-lolabrain';
process.env.TELNYX_ORDER_SETTLE_MS = '0';

const { default: handler } = await import('../api/provision-number.js');

const T1 = '11111111-1111-1111-1111-111111111111';
const OWNED = '+13055550100';

let numberOrdersCalls = 0;
let ownedOnAccount = true;
globalThis.fetch = async (url, opts = {}) => {
  const path = String(url);
  const method = opts.method || 'GET';
  const json = (o, ok = true) => ({ ok, json: async () => o });
  if (path.includes('/balance')) {
    return json({ data: { balance: '1.50', available_credit: '1.50', currency: 'USD' } });
  }
  if (path.includes('/available_phone_numbers')) {
    return json({ data: [{ phone_number: '+13055550123', region_information: [{ region_name: 'Florida' }], cost: { amount: '2.00' } }] });
  }
  if (path.includes('/number_orders')) {
    numberOrdersCalls += 1;
    return json({ errors: [{ detail: 'should never be called' }] }, false);
  }
  if (path.includes('/phone_numbers')) {
    if (path.includes('filter[phone_number]')) {
      return json({ data: ownedOnAccount ? [{ id: 'pn-1', phone_number: OWNED, status: 'active', connection_id: null }] : [] });
    }
    // list all owned numbers (page[size]=100)
    return json({ data: [{ id: 'pn-1', phone_number: OWNED, status: 'active', connection_id: null }, { id: 'pn-2', phone_number: '+17622620243', status: 'active', connection_id: 'legacy' }] });
  }
  if (path.includes('/phone_numbers/pn-1/voice') && method === 'PATCH') return json({ data: { id: 'pn-1' } });
  if (path.includes('/phone_numbers/pn-1/messaging') && method === 'PATCH') return json({ data: { id: 'pn-1' } });
  if (path.includes('/ai/assistants/asst-lolabrain') && method === 'GET') {
    // The LolaBrain attach resolves the assistant's own TeXML app and points
    // the number's voice connection at it — the real routing into the AI.
    return json({ id: 'asst-lolabrain', telephony_settings: { default_texml_app_id: '2958004434761680608' } });
  }
  if (path.includes('/ai/assistants/asst-lolabrain') && method === 'PATCH') return json({ data: {} });
  return json({ data: [] });
};

function seed() {
  fake.reset();
  numberOrdersCalls = 0;
  ownedOnAccount = true;
  fake.seed('tenants', [
    { id: T1, slug: 'salon-a', name: 'Salon A', owner_email: 'owner@salon-a.com', phone_number: null, booking_url: null }
  ]);
  fake.seed('tenant_onboarding', [{ tenant_id: T1, stage: 'number', status: 'in_progress', progress: 40 }]);
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

test('GET surfaces owned numbers next to available ones (zero-cost attach path)', async () => {
  seed();
  const [res, out] = makeRes();
  await handler(req('GET'), res);
  assert.equal(out.code, 200);
  assert.equal(out.body.ok, true);
  assert.ok(Array.isArray(out.body.owned));
  assert.equal(out.body.owned[0].phone_number, OWNED);
  assert.equal(out.body.owned[1].phone_number, '+17622620243');
  assert.equal(out.body.numbers[0].phone_number, '+13055550123');
});

test('POST use_existing attaches an owned number with NO purchase and persists routing', async () => {
  seed();
  const [res, out] = makeRes();
  await handler(req('POST', { phone_number: OWNED, use_existing: true }), res);
  assert.equal(out.code, 200);
  assert.equal(out.body.ok, true);
  assert.equal(out.body.attachedExisting, true);
  assert.equal(out.body.phoneNumber, OWNED);
  assert.equal(out.body.messagingProfileLinked, true);
  assert.equal(out.body.lolaBrainLinked, true);
  assert.equal(numberOrdersCalls, 0, 'attaching an owned number must never place a number order');

  const tenant = fake.all('tenants')[0];
  assert.equal(tenant.phone_number, OWNED);
  assert.equal(tenant.provisioning_status, 'active');
  const route = fake.all('tenant_numbers')[0];
  assert.equal(route.phone_number, OWNED);
  // the canonical voice connection is now the LolaBrain assistant's TeXML app
  assert.equal(route.connection_id, '2958004434761680608');
  assert.equal(route.status, 'active');
});

test('POST use_existing with a number NOT on the account fails politely, no purchase, no persist', async () => {
  seed();
  ownedOnAccount = false;
  const [res, out] = makeRes();
  await handler(req('POST', { phone_number: '+12025550199', use_existing: true }), res);
  assert.equal(out.code, 500);
  assert.match(String(out.body.error), /not on this Telnyx account/i);
  assert.equal(numberOrdersCalls, 0);
  assert.equal(fake.all('tenants')[0].phone_number, null);
  assert.equal(fake.all('tenant_numbers').length, 0);
});

test('POST use_existing with a malformed number is rejected before any Telnyx call', async () => {
  seed();
  const [res, out] = makeRes();
  await handler(req('POST', { phone_number: 'not-a-number', use_existing: true }), res);
  assert.equal(out.code, 500);
  assert.match(String(out.body.error), /valid phone number/i);
  assert.equal(numberOrdersCalls, 0);
});

test('persist fails LOUDLY when the tenants update is rejected (the schema-drift defect)', async () => {
  seed();
  fake.failWrite('tenants', 'column tenants.provisioning_status does not exist');
  const [res, out] = makeRes();
  await handler(req('POST', { phone_number: OWNED, use_existing: true }), res);
  // A 500 with the failing step + column — never a silent ok:true.
  assert.equal(out.code, 500);
  assert.equal(out.body.ok, false);
  assert.match(String(out.body.error), /persist failed updating tenants/i);
  assert.match(String(out.body.error), /provisioning_status does not exist/);
  assert.equal(numberOrdersCalls, 0);
  assert.equal(fake.all('tenants')[0].phone_number, null);
});

test('persist fails LOUDLY when the routing-row upsert is rejected', async () => {
  seed();
  fake.failWrite('tenant_numbers', 'permission denied for table tenant_numbers');
  const [res, out] = makeRes();
  await handler(req('POST', { phone_number: OWNED, use_existing: true }), res);
  assert.equal(out.code, 500);
  assert.equal(out.body.ok, false);
  assert.match(String(out.body.error), /persist failed upserting tenant_numbers routing row/);
  assert.equal(numberOrdersCalls, 0);
  // Fail-loud means the caller sees a 500, not a silent ok:true. The tenants
  // write precedes the routing upsert in the persist sequence, so phone_number
  // may already be set — rollback is out of scope (no cross-table transaction).
});
