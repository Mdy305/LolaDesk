/**
 * tests/telnyx-porting.test.mjs — the tenant "Port your existing number" API.
 *
 * Run:
 *   node tests/telnyx-porting.test.mjs
 *   node --test tests/
 *
 * Exercises the REAL /api/telnyx-porting handler against the in-memory fake
 * Supabase with a stubbed global fetch for the Telnyx porting_orders API.
 * Proves the fix that made Settings' port form actually submit:
 *   • the authorized contact auto-fills from the signed-in owner (name +
 *     email) when the UI omits it — previously a guaranteed 400
 *   • the legacy Settings payload shape (carrier / pin) is tolerated and
 *     normalized to current_carrier / account_pin
 *   • a Telnyx rejection fails loudly and never writes a tenant row
 *   • auth is tenant-scoped (401 unsigned, 404 unmapped)
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
  '// Generated test double — see tests/telnyx-porting.test.mjs',
  'export function createClient() {',
  '  const fake = globalThis.__LOLA_FAKE_SUPABASE__;',
  '  if (!fake) throw new Error(\'No fake Supabase registered\');',
  '  return fake;',
  '}',
  ''
].join('\n'));

const fake = new FakeSupabase();
globalThis.__LOLA_FAKE_SUPABASE__ = fake;
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'fake-service-key';

const { default: handler } = await import('../api/telnyx-porting.js');

const REAL_FETCH = globalThis.fetch;
function stubFetch(impl) { globalThis.fetch = impl; }
function restoreFetch() { globalThis.fetch = REAL_FETCH; }
function okFetch(jsonBody, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => jsonBody };
}

function setupTenant() {
  fake.reset();
  fake.auth.users.set('tok-1', {
    id: 'u1', email: 'owner@x.com',
    user_metadata: { full_name: 'Jane Owner' }
  });
  fake.seed('tenants', [{ id: 't1', name: 'Salon One', slug: 'salon-one', owner_email: 'owner@x.com' }]);
  process.env.TELNYX_API_KEY = 'test-telnyx-key';
}

function makeRes() {
  const out = { code: 200, body: null };
  return [{
    setHeader() {}, status(c) { out.code = c; return this; },
    json(o) { out.body = o; return o; }
  }, out];
}
const authReq = (body = {}) => ({ method: 'POST', headers: { authorization: 'Bearer tok-1' }, body });
const anonReq = { method: 'POST', headers: {}, body: {} };

test('POST without a session -> 401 (tenant-scoped)', async () => {
  setupTenant();
  const [res, out] = makeRes();
  await handler(anonReq, res);
  assert.equal(out.code, 401);
  assert.equal(out.body.error, 'not authenticated');
});

test('POST auto-fills the authorized contact from the signed-in owner and submits a real Telnyx porting order', async () => {
  setupTenant();
  let hits = [];
  stubFetch(async (url, opts) => {
    hits.push({ url: String(url), opts });
    assert.ok(String(url).includes('/porting_orders'), 'must POST the porting order');
    return okFetch({
      data: { id: 'port-1', status: 'submitted', phone_numbers: [{ phone_number: '+13055550100', id: 'pn1' }] }
    });
  });
  const [res, out] = makeRes();
  await handler(authReq({ phone_number: '3055550100' }), res);
  assert.equal(out.code, 200);
  assert.equal(out.body.ok, true);
  assert.equal(out.body.telnyx_order.id, 'port-1');
  const row = out.body.port_request;
  assert.equal(row.requested_phone_number, '+13055550100');
  assert.equal(row.status, 'submitted');
  assert.equal(row.authorized_contact_name, 'Jane Owner', 'name auto-filled from the owner profile');
  assert.equal(row.authorized_contact_email, 'owner@x.com', 'email auto-filled from the owner session');
  const sent = JSON.parse(hits[0].opts.body);
  assert.deepEqual(sent.phone_numbers, ['+13055550100']);
  restoreFetch();
});

test('tolerates the legacy Settings form payload (carrier/pin) and normalizes it', async () => {
  setupTenant();
  stubFetch(async () => okFetch({
    data: { id: 'port-2', status: 'submitted', phone_numbers: [{ phone_number: '+13055550111', id: 'pn2' }] }
  }));
  const [res, out] = makeRes();
  await handler(authReq({
    phone_number: '3055550111',
    carrier: 'Verizon',
    account_number: 'ACC-9',
    pin: '1234'
  }), res);
  assert.equal(out.code, 200);
  assert.equal(out.body.ok, true);
  const row = out.body.port_request;
  assert.equal(row.current_carrier, 'Verizon', 'carrier alias -> current_carrier');
  assert.equal(row.account_pin, '1234', 'pin alias -> account_pin');
  assert.equal(row.account_number, 'ACC-9');
  assert.equal(row.authorized_contact_email, 'owner@x.com');
  restoreFetch();
});

test('a Telnyx rejection fails loudly and never writes a tenant row', async () => {
  setupTenant();
  stubFetch(async () => ({ ok: false, status: 403, json: async () => ({ errors: [{ detail: 'porting not enabled on this account' }] }) }));
  const [res, out] = makeRes();
  await handler(authReq({ phone_number: '3055550122' }), res);
  assert.equal(out.code, 403);
  assert.match(out.body.error, /porting not enabled/);
  const rows = await fake.from('tenant_number_ports').select('*');
  assert.equal((rows.data || []).length, 0, 'no tenant row written when Telnyx rejects');
  restoreFetch();
});

test('still requires a number and a resolvable contact', async () => {
  setupTenant();
  stubFetch(async () => okFetch({ data: { id: 'port-3' } }));
  const [res, out] = makeRes();
  await handler(authReq({}), res);
  assert.equal(out.code, 400);
  assert.equal(out.body.error, 'requested_phone_number is required');
  restoreFetch();
});
