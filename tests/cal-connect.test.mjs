/**
 * tests/cal-connect.test.mjs — auto-seed provider_mappings on Cal.com connect.
 *
 * Run:
 *   node tests/cal-connect.test.mjs
 *   node --test tests/
 *
 * Drives the REAL /api/cal-connect handler against the in-memory fake
 * Supabase. Proves an owner can connect the Cal.com mesh node: the connected
 * integration row is upserted, event types are listed from the mocked Cal.com
 * API, services match by name, and provider_mappings rows land so
 * booking-brain can resolve service -> event type id. Also proves the
 * unconfigured case fails loudly (no silent "connected" lie).
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
  '// Generated test double — see tests/cal-connect.test.mjs',
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
const REAL_FETCH = globalThis.fetch;

const { default: handler } = await import('../api/cal-connect.js');

const T1 = '11111111-1111-1111-1111-111111111111';
function seed(){
  fake.reset();
  fake.seed('tenants', [{ id: T1, slug: 'salon-a', name: 'Salon A', owner_email: 'owner@salon.com' }]);
  fake.seed('services', [
    { id: 'srv-1', tenant_id: T1, name: 'Balayage', price: 250, duration_minutes: 60, is_active: true },
    { id: 'srv-2', tenant_id: T1, name: 'Keratin Treatment', price: 300, duration_minutes: 90, is_active: true }
  ]);
  fake.auth.users.set('tok-owner', { id: 'u1', email: 'owner@salon.com' });
}
function makeRes(){
  const out = { code: 200, body: null };
  return [{
    setHeader(){}, status(c){ out.code = c; return this; },
    json(o){ out.body = o; return o; }
  }, out];
}
function postReq(){
  return { method: 'POST', query: {}, headers: { authorization: 'Bearer tok-owner', 'content-type': 'application/json' }, body: '{}', url: '/api/cal-connect' };
}

function mockEventTypes(){
  globalThis.fetch = async (url) => {
    assert.ok(String(url).includes('/v2/event-types'), 'expected cal event-types call');
    return { ok: true, status: 200, json: async () => ({
      status: 'success',
      data: [
        { id: 7, slug: 'balayage', title: 'Balayage', lengthInMinutes: 60 },
        { id: 9, slug: 'keratin-treatment', title: 'Keratin Treatment', lengthInMinutes: 90 }
      ]
    }) };
  };
}

test('connect auto-seeds service -> event type mappings', async () => {
  seed();
  process.env.CAL_COM_API_KEY = 'cal_test_key';
  mockEventTypes();
  const [res, out] = makeRes();
  try{
    await handler(postReq(), res);
    assert.equal(out.code, 200);
    assert.equal(out.body.ok, true);
    assert.equal(out.body.connected, true);
    assert.equal(out.body.event_types, 2);
    assert.equal(out.body.services, 2);
    assert.equal(out.body.matched, 2);
    assert.equal(out.body.mappings.length, 2);
    assert.equal(out.body.unmatched_services.length, 0);

    const row = fake.all('integrations')[0];
    assert.equal(row.provider, 'cal_platform');
    assert.equal(row.status, 'connected');

    const mappings = fake.all('provider_mappings');
    assert.equal(mappings.length, 2);
    const bal = mappings.find(m => m.local_id === 'srv-1');
    assert.equal(bal.provider, 'cal_platform');
    assert.equal(bal.entity_type, 'service');
    assert.equal(bal.external_id, '7');
    assert.equal(bal.metadata.matched_by, 'exact');
  }finally{ delete process.env.CAL_COM_API_KEY; globalThis.fetch = REAL_FETCH; }
});

test('connect reports unmatched services instead of failing', async () => {
  seed();
  process.env.CAL_COM_API_KEY = 'cal_test_key';
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ status: 'success', data: [{ id: 7, slug: 'balayage', title: 'Balayage' }] }) });
  const [res, out] = makeRes();
  try{
    await handler(postReq(), res);
    assert.equal(out.body.ok, true);
    assert.equal(out.body.matched, 1);
    assert.deepEqual(out.body.unmatched_services, ['Keratin Treatment']);
  }finally{ delete process.env.CAL_COM_API_KEY; globalThis.fetch = REAL_FETCH; }
});

test('connect fails loudly when Cal.com is not configured (no silent lie)', async () => {
  seed();
  delete process.env.CAL_COM_API_KEY;
  delete process.env.CAL_COM_CLIENT_ID;
  delete process.env.CAL_COM_CLIENT_SECRET;
  globalThis.fetch = async () => { throw new Error('network must not be hit when unconfigured'); };
  const [res, out] = makeRes();
  try{
    await handler(postReq(), res);
    assert.equal(out.code, 200);
    assert.equal(out.body.ok, false);
    assert.match(String(out.body.error), /CAL_COM/);
    assert.equal(fake.all('provider_mappings').length, 0, 'no mappings written when unconfigured');
  }finally{ globalThis.fetch = REAL_FETCH; }
});

test('unauthenticated connect is rejected', async () => {
  seed();
  const [res, out] = makeRes();
  const req = postReq();
  req.headers = {};
  await handler(req, res);
  assert.equal(out.code, 401);
});

console.log('\ncal-connect: Cal.com connect + auto-seed conforms ✅');
