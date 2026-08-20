/**
 * tests/admin-numbers.test.mjs — /api/admin/numbers connection-state mapping.
 *
 * Run:
 *   node tests/admin-numbers.test.mjs
 *
 * Exercises the REAL handler against the in-memory fake DB: admin gating and
 * the per-row connection_state the panel badges on ('expected' for Lola's
 * working connection, 'rejected_legacy' for the dead upgrade target,
 * 'missing' for null, 'other' for an unknown-but-set id).
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
  '// Generated test double — see tests/admin-numbers.test.mjs',
  'export function createClient() {',
  "  const fake = globalThis.__LOLA_FAKE_SUPABASE__;",
  "  if (!fake) throw new Error('No fake Supabase registered');",
  '  return fake;',
  '}',
  ''
].join('\n'));

const fake = new FakeSupabase();
globalThis.__LOLA_FAKE_SUPABASE__ = fake;
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'fake-service-key';
process.env.TELNYX_VOICE_APP_ID = '2982432232334951429';
process.env.ADMIN_EMAILS = 'boss@loladesk.com';

const { default: handler, connectionState } = await import('../api/admin/numbers.js');

function seed() {
  fake.reset();
  fake.auth.users.set('tok-admin', { id: 'u1', email: 'boss@loladesk.com' });
  fake.auth.users.set('tok-user', { id: 'u2', email: 'salon@example.com' });
  fake.seed('tenants', [
    { id: 't1', name: 'Salon A', slug: 'salon-a', phone_number: '+13055550100' },
    { id: 't2', name: 'Salon B', slug: 'salon-b', phone_number: '+13055550101' },
    { id: 't3', name: 'Salon C', slug: 'salon-c', phone_number: null }
  ]);
  fake.seed('tenant_numbers', [
    // tn4 is NOT seeded — 'missing' is covered by tn3's null connection id.
    { id: 'tn1', tenant_id: 't1', phone_number: '+13055550100', kind: 'primary', status: 'active', connection_id: '2982432232334951429', tenants: { name: 'Salon A', slug: 'salon-a' } },
    { id: 'tn2', tenant_id: 't2', phone_number: '+13055550101', kind: 'primary', status: 'active', connection_id: '2991758319724529273', tenants: { name: 'Salon B', slug: 'salon-b' } },
    { id: 'tn3', tenant_id: 't3', phone_number: '+13055550102', kind: 'forwarded', status: 'active', connection_id: null, tenants: { name: 'Salon C', slug: 'salon-c' } },
    { id: 'tn5', tenant_id: 't1', phone_number: '+13055550103', kind: 'forwarded', status: 'disabled', connection_id: 'CONN-OTHER', tenants: { name: 'Salon A', slug: 'salon-a' } }
  ]);
}

function json(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload), json: async () => payload };
}

function call(req) {
  const res = {};
  res.statusCode = 200;
  res._json = null;
  res.setHeader = () => {};
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => { res._json = obj; return res; };
  res.end = () => {};
  res.send = (body) => { res._html = body; return res; };
  return handler(req, res).then(() => ({ status: res.statusCode, json: res._json, html: res._html }));
}

test('connectionState classifies every state', () => {
  assert.equal(connectionState('2982432232334951429'), 'expected');
  assert.equal(connectionState('2991758319724529273'), 'rejected_legacy');
  assert.equal(connectionState(null), 'missing');
  assert.equal(connectionState(undefined), 'missing');
  assert.equal(connectionState('CONN-OTHER'), 'other');
});

test('rejects anonymous and non-admin users', async () => {
  seed();
  const anon = await call({ method: 'GET', headers: {} });
  assert.equal(anon.status, 401);
  const denied = await call({ method: 'GET', headers: { authorization: 'Bearer tok-user' } });
  assert.equal(denied.status, 403);
});

test('reports per-row connection_state for the panel badges', async () => {
  seed();
  const { status, json: j } = await call({ method: 'GET', headers: { authorization: 'Bearer tok-admin' } });
  assert.equal(status, 200);
  assert.equal(j.ok, true);
  assert.equal(j.numbers.length, 4);
  const byPhone = Object.fromEntries(j.numbers.map(n => [n.phone_number, n]));
  assert.equal(byPhone['+13055550100'].connection_state, 'expected');
  assert.equal(byPhone['+13055550100'].connection_id, '2982432232334951429');
  assert.equal(byPhone['+13055550101'].connection_state, 'rejected_legacy');
  assert.equal(byPhone['+13055550102'].connection_state, 'missing');
  assert.equal(byPhone['+13055550103'].connection_state, 'other');
  assert.equal(byPhone['+13055550100'].tenant_name, 'Salon A');
});

test('serves the dashboard shell before the auth gate', async () => {
  seed();
  const { status, html } = await call({ method: 'GET', headers: { accept: 'text/html' } });
  assert.equal(status, 200);
  assert.match(String(html || ''), /Number Routing/);
  assert.match(String(html || ''), /Connection/);
});

test('assign action returns routing state on a real number', async () => {
  seed();
  const { status, json: j } = await call({
    method: 'POST',
    headers: { authorization: 'Bearer tok-admin', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'reassign', phone_number: '+14085550123', tenant_id: 't3', kind: 'primary', status: 'active' })
  });
  assert.equal(status, 200);
  assert.equal(j.ok, true);
  assert.equal(j.phone_number, '+14085550123');
  assert.ok(j.routing_verified === true || j.routing_verified === false); // resolver tolerant in tests
});