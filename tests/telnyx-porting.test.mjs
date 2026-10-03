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

// The Settings form now feeds the same engine Lola uses (api/lib/setup/telecom.js): details are
// saved as a draft (PIN + account number encrypted only), Lola asks for what's missing, and a
// complete, confirmed request runs the full documented Telnyx flow.
process.env.INTEGRATION_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const { decrypt } = await import('../api/lib/crypto.js');
const telnyxStub = (calls, { rejectCreate = false } = {}) => async (url, opts = {}) => {
  const u = String(url), m = (opts.method || 'GET').toUpperCase();
  calls.push({ u, m, body: opts.body ? JSON.parse(opts.body) : null });
  const J = (o, s = 200) => ({ ok: s < 300, status: s, json: async () => o, text: async () => JSON.stringify(o), arrayBuffer: async () => new ArrayBuffer(0) });
  if (u.endsWith('/portability_checks')) return J({ data: [{ phone_number: '+13055550111', portable: true, fast_portable: false }] });
  if (u.endsWith('/porting_orders') && m === 'POST') return rejectCreate ? J({ errors: [{ detail: 'porting not enabled on this account' }] }, 403) : J({ data: { id: 'port-2', status: { value: 'draft' } } });
  if (u.endsWith('/porting_orders/port-2/actions/confirm')) return J({ data: { id: 'port-2', status: { value: 'in-process' } } });
  if (u.endsWith('/porting_orders/port-2/requirements')) return J({ data: [] });
  if (u.endsWith('/porting_orders/port-2')) return J({ data: { id: 'port-2', status: { value: 'draft' }, requirements_met: true } });
  if (u.endsWith('/documents')) return J({ data: { id: 'doc-1' } });
  return J({ data: [] });
};

test('tolerates the legacy Settings form payload (carrier/pin): saved as a draft, secrets encrypted, owner auto-filled, nothing sent yet', async () => {
  setupTenant();
  const calls = []; stubFetch(telnyxStub(calls));
  const [res, out] = makeRes();
  await handler(authReq({ phone_number: '3055550111', carrier: 'Verizon', account_number: 'ACC-9', pin: '1234' }), res);
  assert.equal(out.code, 200);
  assert.equal(out.body.ok, true);
  assert.match(out.body.say, /name on the phone account/);
  const row = ((await fake.from('tenant_number_ports').select('*')).data || [])[0];
  assert.equal(row.requested_phone_number, '+13055550111');
  assert.equal(row.current_carrier, 'Verizon', 'carrier alias -> current_carrier');
  assert.equal(row.authorized_contact_name, 'Jane Owner', 'name auto-filled from the owner profile');
  assert.equal(row.authorized_contact_email, 'owner@x.com', 'email auto-filled from the owner session');
  assert.equal(row.account_pin ?? null, null, 'no plaintext PIN');
  assert.equal(row.account_number ?? null, null, 'no plaintext account number');
  assert.equal(decrypt(row.pin_enc), '1234');
  assert.equal(decrypt(row.account_number_enc), 'ACC-9');
  assert.ok(!calls.some((c) => c.u.endsWith('/porting_orders')), 'no Telnyx order until the details are complete and confirmed');
  restoreFetch();
});

test('a complete, confirmed request submits a real Telnyx porting order (create → details → confirm)', async () => {
  setupTenant();
  const calls = []; stubFetch(telnyxStub(calls));
  const [res, out] = makeRes();
  await handler(authReq({ phone_number: '3055550111', carrier: 'Verizon', account_number: 'ACC-9', pin: '1234', entity_name: 'Salon One LLC',
    street: '1 Main St', city: 'Miami', state: 'FL', zip: '33101', no_bill: true, confirmed: true }), res);
  assert.equal(out.code, 200);
  assert.equal(out.body.ok, true);
  assert.equal(out.body.submitted, true);
  const create = calls.find((c) => c.m === 'POST' && c.u.endsWith('/porting_orders'));
  assert.deepEqual(create.body.phone_numbers, ['+13055550111']);
  const patch = calls.find((c) => c.m === 'PATCH' && c.body?.end_user);
  assert.equal(patch.body.end_user.admin.pin_passcode, '1234');
  assert.equal(patch.body.end_user.admin.auth_person_name, 'Jane Owner');
  assert.ok(calls.some((c) => c.u.endsWith('/porting_orders/port-2/actions/confirm')));
  const row = ((await fake.from('tenant_number_ports').select('*')).data || [])[0];
  assert.equal(row.telnyx_order_id, 'port-2');
  assert.equal(row.status, 'submitted');
  restoreFetch();
});

test('a Telnyx rejection fails loudly and never records an order', async () => {
  setupTenant();
  const calls = []; stubFetch(telnyxStub(calls, { rejectCreate: true }));
  const [res, out] = makeRes();
  await handler(authReq({ phone_number: '3055550111', account_number: 'ACC-9', pin: '1234', entity_name: 'Salon One LLC',
    street: '1 Main St', city: 'Miami', state: 'FL', zip: '33101', no_bill: true, confirmed: true }), res);
  assert.equal(out.code, 400);
  assert.equal(out.body.ok, false);
  const row = ((await fake.from('tenant_number_ports').select('*')).data || [])[0];
  assert.equal(row.telnyx_order_id ?? null, null, 'no order recorded when Telnyx rejects');
  assert.equal(row.status, 'failed');
  assert.match(row.last_error, /porting not enabled/);
  restoreFetch();
});

test('still requires a number: asks for it in plain words', async () => {
  setupTenant();
  stubFetch(telnyxStub([]));
  const [res, out] = makeRes();
  await handler(authReq({}), res);
  assert.equal(out.code, 200);
  assert.deepEqual(out.body.needs, ['phone_number']);
  assert.match(out.body.say, /salon number you want to move/);
  restoreFetch();
});
