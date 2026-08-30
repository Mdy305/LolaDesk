/**
 * tests/admin-embed.test.mjs — the /api/admin/embed widget-adoption panel.
 *
 * Run:
 *   node tests/admin-embed.test.mjs
 *
 * Exercises the REAL handler against the in-memory fake DB: admin gating,
 * embedded-vs-first-party classification from usage_events metadata.host,
 * snippet-copy counts, totals, and empty-state handling.
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
  '// Generated test double — see tests/admin-embed.test.mjs',
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

const { default: handler } = await import('../api/admin/embed.js');

const T1 = '11111111-1111-1111-1111-111111111111';
const T2 = '22222222-2222-2222-2222-222222222222';

function seed(){
  fake.reset();
  fake.seed('tenants', [
    { id: T1, slug: 'salon-a', name: 'Salon A', plan: 'pro', billing_status: 'active' },
    { id: T2, slug: 'salon-b', name: 'Salon B', plan: 'starter', billing_status: 'trial' }
  ]);
  const NOW = new Date().toISOString(); // production: created_at defaults to now()
  fake.seed('usage_events', [
    // T1: 2 real embeds (foreign sites), 2 first-party, 1 snippet copy
    { tenant_id: T1, kind: 'widget_load', created_at: NOW, metadata: { host: 'janesalon.com', origin: 'https://janesalon.com/book' } },
    { tenant_id: T1, kind: 'widget_load', created_at: NOW, metadata: { host: 'www.salon-a-site.net', origin: 'https://www.salon-a-site.net/' } },
    { tenant_id: T1, kind: 'widget_load', created_at: NOW, metadata: { host: 'www.loladesk.com', origin: 'https://www.loladesk.com/book' } },
    { tenant_id: T1, kind: 'widget_load', created_at: NOW, metadata: { host: 'loladesk.com', origin: 'https://loladesk.com/book' } },
    { tenant_id: T1, kind: 'widget_load', created_at: NOW, metadata: { host: '', origin: '' } }, // missing host → first-party
    { tenant_id: T1, kind: 'embed_copied', created_at: NOW, metadata: { snippet: 'embedInline', source: 'settings' } },
    // T2: 1 embed, no copies
    { tenant_id: T2, kind: 'widget_load', created_at: NOW, metadata: { host: 'spa-b.com', origin: 'https://spa-b.com' } }
  ]);
  fake.auth.users.set('tok-admin', { id: 'u1', email: 'boss@loladesk.com' });
  fake.auth.users.set('tok-user', { id: 'u2', email: 'salon@example.com' });
  process.env.ADMIN_EMAILS = 'boss@loladesk.com';
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

test('admin gate: 401 anonymous, 403 non-admin, 200 admin', async () => {
  seed();
  let [res, out] = makeRes();
  await handler(getReq(null), res);
  assert.equal(out.code, 401);
  [res, out] = makeRes();
  await handler(getReq('tok-user'), res);
  assert.equal(out.code, 403);
  [res, out] = makeRes();
  await handler(getReq('tok-admin'), res);
  assert.equal(out.code, 200);
  assert.equal(out.body.ok, true);
});

test('widget_load counts split embedded vs first-party per tenant', async () => {
  seed();
  const [res, out] = makeRes();
  await handler(getReq('tok-admin'), res);
  assert.equal(out.code, 200);
  const a = out.body.tenants.find(t => t.tenant_id === T1);
  const b = out.body.tenants.find(t => t.tenant_id === T2);
  // T1: 5 loads → 2 embedded, 3 first-party (www.loladesk.com, loladesk.com, missing-host)
  assert.equal(a.widget_loads, 5);
  assert.equal(a.embedded, 2);
  assert.equal(a.first_party, 3);
  assert.equal(a.embed_ratio_pct, 40);
  assert.equal(a.snippet_copies, 1);
  // T2: 1 load → embedded
  assert.equal(b.widget_loads, 1);
  assert.equal(b.embedded, 1);
  assert.equal(b.first_party, 0);
  assert.equal(b.snippet_copies, 0);
});

test('totals roll up loads, embeds, copies, and salons embedding', async () => {
  seed();
  const [res, out] = makeRes();
  await handler(getReq('tok-admin'), res);
  const t = out.body.totals;
  assert.equal(t.widget_loads, 6);
  assert.equal(t.embedded, 3);
  assert.equal(t.first_party, 3);
  assert.equal(t.snippet_copies, 1);
  assert.equal(t.salons_embedding, 2);
});

test('empty activity returns zero totals and an empty list', async () => {
  seed();
  fake.seed('usage_events', []);
  const [res, out] = makeRes();
  await handler(getReq('tok-admin'), res);
  assert.equal(out.code, 200);
  assert.equal(out.body.totals.widget_loads, 0);
  assert.equal(out.body.totals.salons_embedding, 0);
  assert.deepEqual(out.body.tenants, []);
});

console.log('\nadmin-embed: adoption report ✅');
