/**
 * tests/embed-status.test.mjs — the per-tenant "is my widget installed?"
 * endpoint that powers the settings Share & embed badge.
 *
 * Run:
 *   node tests/embed-status.test.mjs
 *
 * Exercises the REAL handler against the in-memory fake DB: auth gate,
 * embedded detection (foreign hosts → installed), first-party-only is NOT
 * installed, and host rollup with first/last seen.
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
  '// Generated test double — see tests/embed-status.test.mjs',
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

const { default: handler } = await import('../api/embed-status.js');

const T1 = '11111111-1111-1111-1111-111111111111';
const NOW = new Date().toISOString();
const EARLIER = new Date(Date.now() - 5 * 86400000).toISOString();

function seed(usage){
  fake.reset();
  fake.seed('tenants', [{ id: T1, slug: 'salon-a', name: 'Salon A' }]);
  fake.seed('tenant_users', [{ tenant_id: T1, user_id: 'u1', role: 'owner' }]);
  fake.seed('usage_events', usage || []);
  fake.auth.users.set('tok-user', { id: 'u1', email: 'owner@salon-a.com' });
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
function getReq(token) {
  return { method: 'GET', query: {}, headers: token ? { Authorization: 'Bearer ' + token } : {}, body: undefined };
}

test('gate: anonymous is 401', async () => {
  seed();
  const [res, out] = makeRes();
  await handler(getReq(null), res);
  assert.equal(out.code, 401);
});

test('no widget activity → not installed', async () => {
  seed([]);
  const [res, out] = makeRes();
  await handler(getReq('tok-user'), res);
  assert.equal(out.code, 200);
  assert.equal(out.body.installed, false);
  assert.deepEqual(out.body.hosts, []);
});

test('first-party loads only → NOT installed', async () => {
  seed([
    { tenant_id: T1, kind: 'widget_load', created_at: NOW, metadata: { host: 'www.loladesk.com' } },
    { tenant_id: T1, kind: 'widget_load', created_at: NOW, metadata: { host: '' } }
  ]);
  const [res, out] = makeRes();
  await handler(getReq('tok-user'), res);
  assert.equal(out.body.installed, false, 'first-party visits must not count as an install');
  assert.equal(out.body.loads, 2);
  assert.equal(out.body.embedded_loads, 0);
});

test('a foreign-origin load → installed with the host and first/last seen', async () => {
  seed([
    { tenant_id: T1, kind: 'widget_load', created_at: EARLIER, metadata: { host: 'janesalon.com', origin: 'https://janesalon.com/book' } },
    { tenant_id: T1, kind: 'widget_load', created_at: NOW, metadata: { host: 'janesalon.com', origin: 'https://janesalon.com/book?utm=1' } },
    { tenant_id: T1, kind: 'widget_load', created_at: NOW, metadata: { host: 'www.loladesk.com' } }
  ]);
  const [res, out] = makeRes();
  await handler(getReq('tok-user'), res);
  assert.equal(out.body.installed, true);
  assert.equal(out.body.embedded_loads, 2);
  assert.equal(out.body.first_party_loads, 1);
  assert.equal(out.body.hosts.length, 1);
  assert.equal(out.body.hosts[0].host, 'janesalon.com');
  assert.equal(out.body.hosts[0].loads, 2);
  assert.equal(out.body.hosts[0].first_seen, EARLIER);
  assert.equal(out.body.hosts[0].last_seen, NOW);
});

console.log('\nembed-status: installed badge state ✅');
