/**
 * tests/admin-test-call.test.mjs — /api/admin/test-call live test call.
 *
 * Run:
 *   node tests/admin-test-call.test.mjs
 *
 * Exercises the REAL handler against the in-memory fake DB with the Telnyx
 * API stubbed via global fetch: admin gating, E.164 validation, explicit
 * from, auto-discovered from, the legacy connection-id upgrade, upstream
 * error mapping, and routing info for the dialed number.
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
  '// Generated test double — see tests/admin-test-call.test.mjs',
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
process.env.TELNYX_API_KEY = 'test-telnyx-key';
process.env.TELNYX_VOICE_APP_ID = 'CONN-LOLA';
process.env.ADMIN_EMAILS = 'boss@loladesk.com';

const { default: handler } = await import('../api/admin/test-call.js');

const T1 = '11111111-1111-1111-1111-111111111111';
const TENANT_LINE = '+19294568227';
const OWNED_A = '+13055550100';
const OWNED_B = '+13055550101';

function seed() {
  fake.reset();
  fake.seed('tenants', [
    { id: T1, slug: 'mma', name: 'MMΛ Salon', phone_number: TENANT_LINE, plan: 'pro', billing_status: 'active' }
  ]);
  fake.seed('tenant_numbers', [
    { tenant_id: T1, phone_number: TENANT_LINE, kind: 'primary', status: 'active' }
  ]);
  fake.auth.users.set('tok-admin', { id: 'u1', email: 'boss@loladesk.com' });
  fake.auth.users.set('tok-user', { id: 'u2', email: 'salon@example.com' });
}

function json(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300, status,
    text: async () => JSON.stringify(payload),
    json: async () => payload
  };
}

// Telnyx stub — records the /v2/calls POST body so tests can assert what was
// actually sent, and serves /phone_numbers for auto-from discovery.
function stubTelnyx({ failCalls = false, numbers = [OWNED_A, OWNED_B] } = {}) {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (!u.includes('api.telnyx.com')) throw new Error('unexpected non-Telnyx call: ' + u);
    const path = u.replace('https://api.telnyx.com/v2', '').split('?')[0];

    if (path === '/calls') {
      calls.push(JSON.parse(opts.body || '{}'));
      if (failCalls) return json({ errors: [{ detail: 'invalid caller ID — number not owned' }] }, 400);
      return json({ data: { id: 'call-1', record_type: 'call', call_control_id: 'v3:test-call-control', call_leg_id: 'leg-1' } });
    }
    if (path === '/phone_numbers') {
      return json({ data: numbers.map((n, i) => ({ id: 'PN' + i, phone_number: n, status: 'active', connection_id: 'CONN-LOLA' })) });
    }
    throw new Error('unmocked Telnyx path: ' + path);
  };
  return { realFetch, calls };
}

function call(req) {
  const res = {};
  res.statusCode = 200;
  res._json = null;
  res.setHeader = () => {};
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => { res._json = obj; return res; };
  res.end = () => {};
  return handler(req, res).then(() => ({ status: res.statusCode, json: res._json }));
}

test('rejects anonymous and non-admin users', async () => {
  seed();
  const t = stubTelnyx();
  try {
    const anon = await call({ method: 'POST', headers: {}, body: JSON.stringify({ to: TENANT_LINE }) });
    assert.equal(anon.status, 401);

    const denied = await call({ method: 'POST', headers: { authorization: 'Bearer tok-user' }, body: JSON.stringify({ to: TENANT_LINE }) });
    assert.equal(denied.status, 403);
  } finally { globalThis.fetch = t.realFetch; }
});

test('rejects non-POST methods', async () => {
  seed();
  const t = stubTelnyx();
  try {
    const r = await call({ method: 'GET', headers: { authorization: 'Bearer tok-admin' } });
    assert.equal(r.status, 405);
  } finally { globalThis.fetch = t.realFetch; }
});

test('requires a valid E.164 destination', async () => {
  seed();
  const t = stubTelnyx();
  try {
    const missing = await call({ method: 'POST', headers: { authorization: 'Bearer tok-admin' }, body: '{}' });
    assert.equal(missing.status, 400);
    assert.match(missing.json.error, /to/);

    const bad = await call({ method: 'POST', headers: { authorization: 'Bearer tok-admin' }, body: JSON.stringify({ to: 'not-a-phone' }) });
    assert.equal(bad.status, 400);

    const badFrom = await call({ method: 'POST', headers: { authorization: 'Bearer tok-admin' }, body: JSON.stringify({ to: TENANT_LINE, from: 'abc' }) });
    assert.equal(badFrom.status, 400);
    assert.match(badFrom.json.error, /from/);
  } finally { globalThis.fetch = t.realFetch; }
});

test('originates a real call with an explicit from and reports routing', async () => {
  seed();
  const t = stubTelnyx();
  try {
    const { status, json: j } = await call({
      method: 'POST', headers: { authorization: 'Bearer tok-admin' },
      body: JSON.stringify({ to: TENANT_LINE, from: OWNED_A })
    });
    assert.equal(status, 200);
    assert.equal(j.ok, true);

    // The exact Telnyx request that was sent
    assert.equal(t.calls.length, 1);
    assert.deepEqual(t.calls[0], { connection_id: 'CONN-LOLA', from: OWNED_A, to: TENANT_LINE, if_machine: 'continue' });

    assert.equal(j.call_control_id, 'v3:test-call-control');
    assert.equal(j.connection_id, 'CONN-LOLA');
    assert.equal(j.from, OWNED_A);
    assert.equal(j.to, TENANT_LINE);

    // The dialed number resolves to the tenant — who will answer is visible
    assert.equal(j.routing.status, 'resolved');
    assert.equal(j.routing.tenant.id, T1);
    assert.equal(j.routing.tenant.name, 'MMΛ Salon');
  } finally { globalThis.fetch = t.realFetch; }
});

test('auto-discovers an owned from number when none is given', async () => {
  seed();
  const t = stubTelnyx({ numbers: [OWNED_A, TENANT_LINE] });
  try {
    const { status, json: j } = await call({
      method: 'POST', headers: { authorization: 'Bearer tok-admin' },
      body: JSON.stringify({ to: TENANT_LINE })
    });
    assert.equal(status, 200);
    assert.equal(j.ok, true);
    // Picks the first owned number that isn't the destination
    assert.equal(j.from, OWNED_A);
    assert.equal(t.calls[0].from, OWNED_A);
  } finally { globalThis.fetch = t.realFetch; }
});

test('upgrades the legacy app id to the live connection', async () => {
  seed();
  process.env.TELNYX_VOICE_APP_ID = '2982432232334951429';
  const t = stubTelnyx();
  try {
    const { json: j } = await call({
      method: 'POST', headers: { authorization: 'Bearer tok-admin' },
      body: JSON.stringify({ to: TENANT_LINE, from: OWNED_A })
    });
    assert.equal(j.connection_id, '2991758319724529273');
    assert.equal(t.calls[0].connection_id, '2991758319724529273');
  } finally {
    globalThis.fetch = t.realFetch;
    process.env.TELNYX_VOICE_APP_ID = 'CONN-LOLA';
  }
});

test('maps Telnyx upstream errors loudly', async () => {
  seed();
  const t = stubTelnyx({ failCalls: true });
  try {
    const { status, json: j } = await call({
      method: 'POST', headers: { authorization: 'Bearer tok-admin' },
      body: JSON.stringify({ to: TENANT_LINE, from: OWNED_A })
    });
    assert.equal(status, 400);
    assert.equal(j.ok, false);
    assert.match(j.error, /invalid caller ID/);
  } finally { globalThis.fetch = t.realFetch; }
});

test('calls a number that routes nowhere — reported, not blocked', async () => {
  seed();
  const t = stubTelnyx();
  try {
    const { status, json: j } = await call({
      method: 'POST', headers: { authorization: 'Bearer tok-admin' },
      body: JSON.stringify({ to: '+19999999999', from: OWNED_A })
    });
    assert.equal(status, 200);
    assert.equal(j.ok, true);
    assert.equal(j.routing.status, 'not_found');
    assert.equal(j.routing.tenant, null);
    assert.equal(t.calls.length, 1); // the call still went out
  } finally { globalThis.fetch = t.realFetch; }
});

test('fails cleanly when TELNYX_VOICE_APP_ID is missing', async () => {
  seed();
  delete process.env.TELNYX_VOICE_APP_ID;
  const t = stubTelnyx();
  try {
    const { status, json: j } = await call({
      method: 'POST', headers: { authorization: 'Bearer tok-admin' },
      body: JSON.stringify({ to: TENANT_LINE, from: OWNED_A })
    });
    assert.equal(status, 400);
    assert.match(j.error, /TELNYX_VOICE_APP_ID/);
    assert.equal(t.calls.length, 0);
  } finally {
    globalThis.fetch = t.realFetch;
    process.env.TELNYX_VOICE_APP_ID = 'CONN-LOLA';
  }
});