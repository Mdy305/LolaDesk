/**
 * tests/call-center-callback.test.mjs — /api/call-center/callback
 * (Lola calls a client back, tenant-scoped).
 *
 * Run:
 *   node tests/call-center-callback.test.mjs
 *
 * Exercises the REAL handler against the in-memory fake DB with the Telnyx
 * API stubbed via global fetch: auth gating, tenant scoping (an owner can
 * only call back from their OWN salon line), E.164 validation, originating
 * on the tenant's own connection, the canonical fallback connection, the
 * usage log, and upstream Telnyx error mapping.
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
  '// Generated test double — see tests/call-center-callback.test.mjs',
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
process.env.TELNYX_API_KEY = 'test-telnyx-key';
process.env.TELNYX_LOLA_BRAIN_ID = 'assistant-lola';
delete process.env.TELNYX_VOICE_APP_ID;

const { default: handler } = await import('../api/call-center/callback.js');

const T1 = '11111111-1111-1111-1111-111111111111';
const T2 = '22222222-2222-2222-2222-222222222222';
const LINE_1 = '+19294568227';
const LINE_2 = '+13055550101';

function seed() {
  fake.reset();
  fake.seed('tenants', [
    { id: T1, slug: 'mma', name: 'MMΛ Salon', phone_number: LINE_1, plan: 'pro', billing_status: 'active', owner_email: 'owner@mma.com' },
    { id: T2, slug: 'bloom', name: 'Bloom', phone_number: LINE_2, plan: 'pro', billing_status: 'active', owner_email: 'owner@bloom.com' }
  ]);
  fake.seed('tenant_numbers', [
    { tenant_id: T1, phone_number: LINE_1, kind: 'primary', status: 'active', connection_id: 'CONN-BRAIN' }
  ]);
  fake.seed('usage_events', []);
  fake.auth.users.set('tok-owner-a', { id: 'u1', email: 'owner@mma.com' });
  fake.auth.users.set('tok-owner-b', { id: 'u2', email: 'owner@bloom.com' });
}

// Telnyx stub: record every /calls originate, respond with a call id.
let telnyxCalls = [];
const realFetch = globalThis.fetch;
function stubTelnyx({ fail = false } = {}) {
  telnyxCalls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    // Both fetch wrappers are used: telnyx-client reads .text(), while
    // telnyx-provision's tFetch reads .json() — return both.
    const respond = (payload, status = 200) => ({
      ok: status < 400, status,
      text: async () => JSON.stringify(payload),
      json: async () => JSON.parse(JSON.stringify(payload))
    });
    if (u.includes('/v2/calls') && (opts.method === 'POST')) {
      telnyxCalls.push({ url: u, body: JSON.parse(opts.body || '{}') });
      if (fail) return respond({ errors: [{ detail: 'Simulated Telnyx rejection' }] }, 422);
      return respond({ data: { call_control_id: 'v3:cb-1', id: 'v3:cb-1' } });
    }
    if (u.includes('/v2/phone_numbers')) {
      return respond({ data: [
        { phone_number: '+13055550100', connection_id: 'CONN-OWNED' },
        { phone_number: '+19294568227', connection_id: 'CONN-BRAIN' }
      ] });
    }
    // LolaBrain assistant lookup (canonical connection fallback path).
    // Telnyx returns the assistant object UNWRAPPED (no .data envelope), and
    // tFetch in telnyx-provision.js passes the raw body through.
    if (u.includes('/v2/ai/assistants/')) {
      return respond({ telephony_settings: { default_texml_app_id: 'CONN-CANON' } });
    }
    return realFetch(url, opts);
  };
}
function restoreFetch() {
  globalThis.fetch = realFetch;
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
function postReq(token, body) {
  return {
    method: 'POST', headers: token ? { Authorization: 'Bearer ' + token } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
    url: '/api/call-center/callback'
  };
}

test('auth gate: 401 without a token', async () => {
  seed(); stubTelnyx();
  const [res, out] = makeRes();
  await handler(postReq(null, { to: '+14155550123' }), res);
  assert.equal(out.code, 401);
  restoreFetch();
});

test('rejects an invalid destination number', async () => {
  seed(); stubTelnyx();
  const [res, out] = makeRes();
  await handler(postReq('tok-owner-a', { to: 'abc' }), res);
  assert.equal(out.code, 400);
  assert.match(out.body.error, /valid "to"/);
  restoreFetch();
});

test('originates from the tenant OWN line on the FIRST connection Telnyx accepts', async () => {
  seed(); stubTelnyx();
  const [res, out] = makeRes();
  await handler(postReq('tok-owner-a', { to: '+14155550123' }), res);
  assert.equal(out.code, 200);
  assert.equal(out.body.ok, true);
  assert.equal(out.body.from, LINE_1);           // tenant's own primary line
  assert.equal(out.body.connection_id, 'CONN-BRAIN'); // first candidate accepted
  assert.equal(out.body.call_control_id, 'v3:cb-1');
  assert.equal(telnyxCalls.length, 1);           // first candidate wins — no fallback probes
  const call = telnyxCalls[0].body;
  assert.equal(call.from, LINE_1);
  assert.equal(call.to, '+14155550123');
  assert.equal(call.connection_id, 'CONN-BRAIN');
  // usage logged
  const usage = fake.all('usage_events');
  assert.equal(usage.length, 1);
  assert.equal(usage[0].tenant_id, T1);
  assert.equal(usage[0].kind, 'callback_originated');
  restoreFetch();
});

test('falls through rejected connections until Telnyx accepts one', async () => {
  seed(); stubTelnyx();
  // The tenant line's attachment is an AI-assistant app Telnyx REJECTS for
  // outbound originate (real behavior: the LolaBrain TeXML app). The
  // endpoint must advance to the next candidate instead of failing.
  fake.seed('tenant_numbers', [
    { tenant_id: T1, phone_number: LINE_1, kind: 'primary', status: 'active', connection_id: 'CONN-REJECTED' }
  ]);
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const respond = (payload, status = 200) => ({
      ok: status < 400, status,
      text: async () => JSON.stringify(payload),
      json: async () => JSON.parse(JSON.stringify(payload))
    });
    if (u.includes('/v2/calls') && (opts.method === 'POST')) {
      telnyxCalls.push({ url: u, body: JSON.parse(opts.body || '{}') });
      const body = JSON.parse(opts.body || '{}');
      if (body.connection_id === 'CONN-REJECTED') {
        return respond({ errors: [{ detail: 'connection invalid for outbound originate' }] }, 422);
      }
      return respond({ data: { call_control_id: 'v3:cb-2', id: 'v3:cb-2' } });
    }
    if (u.includes('/v2/phone_numbers')) {
      return respond({ data: [{ phone_number: '+13055550100', connection_id: 'CONN-OWNED' }] });
    }
    if (u.includes('/v2/ai/assistants/')) {
      return respond({ telephony_settings: { default_texml_app_id: 'CONN-CANON' } });
    }
    return realFetch(url, opts);
  };
  const [res, out] = makeRes();
  await handler(postReq('tok-owner-a', { to: '+14155550123' }), res);
  assert.equal(out.code, 200);
  assert.equal(out.body.ok, true);
  assert.equal(out.body.connection_id, 'CONN-CANON'); // canonical beat the owned number
  const accepted = telnyxCalls.filter(c => c.body.connection_id !== 'CONN-REJECTED');
  assert.ok(accepted.length >= 1);
  assert.equal(accepted[0].body.connection_id, 'CONN-CANON');
  assert.equal(accepted[0].body.from, LINE_1);
  restoreFetch();
});

test('tenant scoping: another salon never originates from this salon\u2019s line', async () => {
  seed(); stubTelnyx();
  const [res, out] = makeRes();
  await handler(postReq('tok-owner-b', { to: '+14155550123' }), res);
  assert.equal(out.code, 200);
  assert.equal(out.body.from, LINE_2); // Bloom's own line, never T1's
  assert.notEqual(out.body.from, LINE_1);
  restoreFetch();
});

test('cannot call the salon\u2019s own line back', async () => {
  seed(); stubTelnyx();
  const [res, out] = makeRes();
  await handler(postReq('tok-owner-a', { to: LINE_1 }), res);
  assert.equal(out.code, 400);
  assert.match(out.body.error, /must differ/);
  restoreFetch();
});

test('salon with no line at all gets a clear error', async () => {
  seed(); stubTelnyx();
  fake.seed('tenant_numbers', []);
  fake.seed('tenants', [{ id: T1, slug: 'mma', name: 'MMΛ Salon', phone_number: null, plan: 'pro', billing_status: 'active', owner_email: 'owner@mma.com' }]);
  const [res, out] = makeRes();
  await handler(postReq('tok-owner-a', { to: '+14155550123' }), res);
  assert.equal(out.code, 400);
  assert.match(out.body.error, /no Lola line/);
  restoreFetch();
});

test('falls back to the canonical voice connection when the line has none', async () => {
  seed(); stubTelnyx();
  fake.seed('tenant_numbers', [
    { tenant_id: T1, phone_number: LINE_1, kind: 'primary', status: 'active', connection_id: null }
  ]);
  const [res, out] = makeRes();
  await handler(postReq('tok-owner-a', { to: '+14155550123' }), res);
  assert.equal(out.code, 200);
  assert.equal(out.body.connection_id, 'CONN-CANON'); // resolved from LolaBrain assistant
  assert.equal(telnyxCalls[0].body.connection_id, 'CONN-CANON');
  restoreFetch();
});

test('maps a total Telnyx rejection to a clear error with the tried list', async () => {
  seed(); stubTelnyx({ fail: true });
  const [res, out] = makeRes();
  await handler(postReq('tok-owner-a', { to: '+14155550123' }), res);
  assert.equal(out.code, 502);
  assert.match(out.body.error, /Telnyx rejected every connection/);
  assert.match(out.body.error, /Simulated Telnyx rejection/);
  assert.ok(Array.isArray(out.body.tried_connections) || typeof out.body.tried_connections === 'string');
  restoreFetch();
});
