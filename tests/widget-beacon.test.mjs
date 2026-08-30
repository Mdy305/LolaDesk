/**
 * tests/widget-beacon.test.mjs — embed-adoption telemetry.
 *
 * Run:
 *   node tests/widget-beacon.test.mjs
 *   node --test tests/
 *
 * Drives the REAL /api/widget-beacon endpoint against the in-memory fake
 * Supabase: widget_load beacons, copy/preview tracking, the demo-tenant
 * guard, and junk-input silence.
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
  '// Generated test double — see tests/widget-beacon.test.mjs',
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

const handler = (await import('../api/widget-beacon.js')).default;
fake.seed('tenants', [
  { id: 't1', slug: 'test-salon', name: 'Test Salon' },
  { id: 't2', slug: 'dedupe-salon', name: 'Dedupe Salon' }
]);
fake.seed('usage_events', []);

function makeRes() {
  const out = { code: 200, headers: {}, body: null };
  return [{
    setHeader(k, v) { out.headers[k] = v; },
    status(c) { out.code = c; return this; },
    json(o) { out.body = o; return o; },
    end() { out.code = out.code || 200; }
  }, out];
}

test('widget_load beacon writes a usage row with origin metadata', async () => {
  const [res, out] = makeRes();
  await handler({ method: 'GET', query: { tenant: 'test-salon', kind: 'widget_load', origin: 'https://client-site.com/book', host: 'client-site.com' }, headers: { host: 'client-site.com', 'user-agent': 'test' }, body: undefined }, res);
  assert.equal(out.code, 200);
  assert.equal(out.body.ok, true);
  const rows = fake.all('usage_events');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tenant_id, 't1');
  assert.equal(rows[0].kind, 'widget_load');
  assert.equal(rows[0].metadata.origin, 'https://client-site.com/book');
});

test('embed_copied POST from the settings page logs the snippet kind', async () => {
  const [res, out] = makeRes();
  await handler({ method: 'POST', query: {}, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tenant: 'test-salon', kind: 'embed_copied', snippet: 'embedInline', source: 'settings' }) }, res);
  assert.equal(out.code, 200);
  const rows = fake.all('usage_events');
  assert.equal(rows.length, 2);
  assert.equal(rows[1].kind, 'embed_copied');
  assert.equal(rows[1].metadata.snippet, 'embedInline');
  assert.equal(rows[1].metadata.source, 'settings');
});

test('widget_load dedupes to one row per tenant per UTC day', async () => {
  const before = fake.all('usage_events').length;
  const [res, out] = makeRes();
  await handler({ method: 'GET', query: { tenant: 'dedupe-salon', kind: 'widget_load', origin: 'https://client-site.com/a', host: 'client-site.com' }, headers: {}, body: undefined }, res);
  assert.equal(out.code, 200);
  assert.equal(out.body.ok, true);
  assert.equal(fake.all('usage_events').length, before + 1, 'first load writes a row');
  const [res2, out2] = makeRes();
  await handler({ method: 'GET', query: { tenant: 'dedupe-salon', kind: 'widget_load', origin: 'https://client-site.com/b', host: 'client-site.com' }, headers: {}, body: undefined }, res2);
  assert.equal(out2.code, 200);
  assert.equal(out2.body.deduped, true, 'second load the same day must be deduped');
  assert.equal(fake.all('usage_events').length, before + 1, 'only one widget_load row per day');
});

test('embed_copied is NOT deduped — every copy is a distinct action', async () => {
  const before = fake.all('usage_events').length;
  for (let i = 0; i < 3; i++) {
    const [res, out] = makeRes();
    await handler({ method: 'POST', query: {}, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tenant: 'test-salon', kind: 'embed_copied', snippet: 'embedInline' }) }, res);
    assert.equal(out.body.ok, true);
  }
  assert.equal(fake.all('usage_events').length, before + 3, 'copies stay one row each');
});

test('unknown tenant is silent — the demo fallback is never logged', async () => {
  const before = fake.all('usage_events').length;
  const [res, out] = makeRes();
  await handler({ method: 'GET', query: { tenant: 'does-not-exist', kind: 'widget_load' }, headers: {}, body: undefined }, res);
  assert.equal(out.code, 200);
  assert.equal(out.body.ok, true);
  assert.equal(fake.all('usage_events').length, before, 'demo tenant must not be recorded');
});

test('unknown kinds are ignored silently', async () => {
  const before = fake.all('usage_events').length;
  const [res, out] = makeRes();
  await handler({ method: 'GET', query: { tenant: 'test-salon', kind: 'garbage' }, headers: {}, body: undefined }, res);
  assert.equal(out.code, 200);
  assert.equal(fake.all('usage_events').length, before);
});

test('CORS is wide open (widget embeds on any site)', async () => {
  const [res, out] = makeRes();
  await handler({ method: 'OPTIONS', query: {}, headers: {}, body: undefined }, res);
  assert.equal(out.code, 204);
  const [res2, out2] = makeRes();
  await handler({ method: 'GET', query: { tenant: 'test-salon', kind: 'widget_load' }, headers: {}, body: undefined }, res2);
  assert.equal(out2.headers['Access-Control-Allow-Origin'], '*');
});

console.log('\nwidget-beacon: adoption telemetry ✅');
