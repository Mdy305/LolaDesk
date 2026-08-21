/**
 * tests/sync-connections-cron.test.mjs — /api/cron/sync-connections daily run.
 *
 * Run:
 *   node tests/sync-connections-cron.test.mjs
 *
 * Exercises the REAL handler against the in-memory fake DB with Telnyx
 * stubbed via global fetch: CRON_SECRET gating (no secret → 503, wrong
 * secret → 401), and a full reconcile run that writes Telnyx's live
 * attachments back into tenant_numbers via the shared lib.
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
  '// Generated test double — see tests/sync-connections-cron.test.mjs',
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
process.env.CRON_SECRET = 'test-cron-secret';
process.env.TELNYX_API_KEY = 'test-telnyx-key';
process.env.TELNYX_VOICE_APP_ID = '2982432232334951429';
process.env.TELNYX_LOLA_BRAIN_ID = 'ASSIST-BRAIN';

const { default: handler } = await import('../api/cron/sync-connections.js');

function seed() {
  fake.reset();
  fake.seed('tenants', [
    { id: 't1', name: 'Salon A', slug: 'salon-a', phone_number: '+13055550100' },
    { id: 't2', name: 'Salon B', slug: 'salon-b', phone_number: '+13055550101' }
  ]);
  fake.seed('tenant_numbers', [
    { id: 'tn1', tenant_id: 't1', phone_number: '+13055550100', kind: 'primary', status: 'active', connection_id: '2982432232334951429', tenants: { name: 'Salon A', slug: 'salon-a' } },
    // tn2 is stale — recorded the rejected legacy id, Telnyx says LolaBrain.
    { id: 'tn2', tenant_id: 't2', phone_number: '+13055550101', kind: 'primary', status: 'active', connection_id: '2991758319724529273', tenants: { name: 'Salon B', slug: 'salon-b' } }
  ]);
}

function json(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload), json: async () => payload };
}

function stubTelnyx() {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (!u.includes('api.telnyx.com')) throw new Error('unexpected non-Telnyx call: ' + u);
    const path = u.replace('https://api.telnyx.com/v2', '').split('?')[0];
    if (path === '/phone_numbers') return json({ data: [
      { id: 'PN1', phone_number: '+13055550100', status: 'active', connection_id: '2982432232334951429' },
      { id: 'PN2', phone_number: '+13055550101', status: 'active', connection_id: 'ASSIST-BRAIN' }
    ] });
    if (path === '/connections') return json({ data: [
      { id: '2982432232334951429', connection_name: 'LolaDesk' }
    ] });
    if (path === '/ai/assistants') return json({ data: [
      { id: 'ASSIST-BRAIN', name: 'LolaBrain' }
    ] });
    throw new Error('unmocked Telnyx path: ' + path);
  };
  return { realFetch };
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

test('disabled without CRON_SECRET, rejects wrong secret', async () => {
  seed();
  const t = stubTelnyx();
  try {
    delete process.env.CRON_SECRET;
    const disabled = await call({ method: 'GET', headers: { authorization: 'Bearer anything' } });
    assert.equal(disabled.status, 503);
    process.env.CRON_SECRET = 'test-cron-secret';
    const wrong = await call({ method: 'GET', headers: { authorization: 'Bearer nope' } });
    assert.equal(wrong.status, 401);
  } finally { globalThis.fetch = t.realFetch; }
});

test('daily run reconciles tenant_numbers with live Telnyx attachments', async () => {
  seed();
  const t = stubTelnyx();
  try {
    const { status, json: j } = await call({ method: 'GET', headers: { authorization: 'Bearer test-cron-secret' } });
    assert.equal(status, 200);
    assert.equal(j.ok, true);
    assert.ok(j.generated_at);
    assert.equal(j.error, null);

    // The stale rejected-legacy row got rewritten to the live LolaBrain id.
    assert.equal(j.updated.length, 1);
    assert.equal(j.updated[0].phone_number, '+13055550101');
    assert.equal(j.updated[0].from, '2991758319724529273');
    assert.equal(j.updated[0].to, 'ASSIST-BRAIN');
    assert.equal(j.updated[0].connection_name, 'LolaBrain');
    // Already-correct row untouched.
    assert.equal(j.unchanged_count, 1);
    // Name map resolved.
    assert.equal(j.connection_names['ASSIST-BRAIN'], 'LolaBrain');

    // DB now carries the live id.
    const rows = fake.all('tenant_numbers');
    assert.equal(rows.find(r => r.phone_number === '+13055550101').connection_id, 'ASSIST-BRAIN');
  } finally { globalThis.fetch = t.realFetch; }
});

test('reports Telnyx unreachable as 502 with ok:false', async () => {
  seed();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (!String(url).includes('api.telnyx.com')) throw new Error('unexpected');
    return json({ errors: [{ detail: 'forbidden' }] }, 403);
  };
  try {
    const { status, json: j } = await call({ method: 'GET', headers: { authorization: 'Bearer test-cron-secret' } });
    assert.equal(status, 502);
    assert.equal(j.ok, false);
    assert.ok(j.error);
  } finally { globalThis.fetch = realFetch; }
});
