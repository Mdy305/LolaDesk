/**
 * tests/reviews-list.test.mjs — the tenant-facing reviews page backend.
 *
 * Run:
 *   node tests/reviews-list.test.mjs
 *   node --test tests/
 *
 * Drives the REAL /api/reviews/list and /api/reviews/upload handlers against
 * the in-memory fake Supabase: auth gating, status counts, tenant isolation,
 * and a Facebook CSV import through the full filter → dedupe → stagger path.
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
  '// Generated test double — see tests/reviews-list.test.mjs',
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

fake.auth.users.set('token-t1', { id: 'user-1', email: 'owner@t1.com' });
fake.auth.users.set('token-t2', { id: 'user-2', email: 'owner@t2.com' });

const listHandler = (await import('../api/reviews/list.js')).default;
const uploadHandler = (await import('../api/reviews/upload.js')).default;

fake.seed('tenants', [
  { id: 't1', name: 'Salon One', owner_email: 'owner@t1.com' },
  { id: 't2', name: 'Salon Two', owner_email: 'owner@t2.com' }
]);
fake.seed('tenant_users', []);
fake.seed('review_queue', [
  { id: 'r1', tenant_id: 't1', source: 'google_gmb', author_name: 'Sarah', rating: 5, review_body: 'Amazing balayage experience, best salon ever.', status: 'published', scheduled_for: '2026-08-01T00:00:00Z', created_at: '2026-08-01T00:00:00Z' },
  { id: 'r2', tenant_id: 't1', source: 'facebook', author_name: 'Mia', rating: 5, review_body: 'Loved the cut and the whole vibe.', status: 'scheduled', scheduled_for: '2026-08-20T00:00:00Z', created_at: '2026-08-02T00:00:00Z' },
  { id: 'r3', tenant_id: 't1', source: 'yelp_csv', author_name: 'Leo', rating: 5, review_body: 'Ten out of ten, will be back.', status: 'failed', error_message: 'Meta not configured', scheduled_for: '2026-08-03T00:00:00Z', created_at: '2026-08-03T00:00:00Z' },
  { id: 'r4', tenant_id: 't2', source: 'google_gmb', author_name: 'OtherSalon', rating: 5, review_body: 'Should never leak to Salon One.', status: 'published', scheduled_for: '2026-08-01T00:00:00Z', created_at: '2026-08-01T00:00:00Z' }
]);

function makeRes() {
  const out = { code: 200, headers: {}, body: null };
  return [{
    setHeader(k, v) { out.headers[k] = v; },
    status(c) { out.code = c; return this; },
    json(o) { out.body = o; return o; },
    end() { out.code = out.code || 200; }
  }, out];
}

test('list requires authentication', async () => {
  const [res, out] = makeRes();
  await listHandler({ method: 'GET', headers: {}, body: undefined }, res);
  assert.equal(out.code, 401);
});

test('list returns tenant-scoped reviews with status counts', async () => {
  const [res, out] = makeRes();
  await listHandler({ method: 'GET', headers: { authorization: 'Bearer token-t1' }, body: undefined }, res);
  assert.equal(out.code, 200);
  assert.equal(out.body.ok, true);
  assert.equal(out.body.tenant.name, 'Salon One');
  assert.deepEqual(out.body.counts, { queued: 0, scheduled: 1, published: 1, failed: 1 });
  assert.equal(out.body.reviews.length, 3, 'only Salon One reviews, newest first');
  assert.ok(out.body.reviews.every(r => r.tenant_id === 't1' || !('tenant_id' in r)), 'no cross-tenant leak');
  assert.ok(out.body.reviews.every(r => r.author_name !== 'OtherSalon'), 't2 review must not appear');
});

test('upload imports a Facebook CSV through filter → dedupe → stagger', async () => {
  const csv = [
    'rating,author,review',
    '5,"Sarah","Incredible balayage, best I have ever had!"',
    '4,Jim,Meh it was fine',
    '5,Mia,"short"',
    '5,"Leo","Loved every minute of it, will be back for sure"'
  ].join('\n');

  const [res, out] = makeRes();
  await uploadHandler({ method: 'POST', headers: { authorization: 'Bearer token-t1', 'content-type': 'application/json' }, body: JSON.stringify({ source: 'facebook', csv }) }, res);
  assert.equal(out.code, 200);
  assert.equal(out.body.ok, true);
  assert.equal(out.body.accepted, 2, 'two 5-star reviews longer than 10 chars');
  assert.equal(out.body.scheduled, 2);
  assert.equal(out.body.skipped.not_five_star, 1);
  assert.equal(out.body.skipped.too_short, 1);

  const rows = fake.all('review_queue').filter(r => r.source === 'facebook');
  assert.equal(rows.length, 3, 'the pre-seeded facebook row + 2 new');
  const fresh = rows.filter(r => !r.id || !String(r.id).startsWith('r'));
  assert.equal(fresh.length, 2);
  assert.ok(fresh.every(r => r.tenant_id === 't1' && r.status === 'scheduled' && r.rating === 5));
  assert.ok(new Date(fresh[1].scheduled_for) > new Date(fresh[0].scheduled_for), 'staggered +48h apart');
});

test('upload rejects an unknown source', async () => {
  const [res, out] = makeRes();
  await uploadHandler({ method: 'POST', headers: { authorization: 'Bearer token-t1' }, body: JSON.stringify({ source: 'tiktok', csv: 'rating,author,review\n5,Sarah,A really nice experience here.' }) }, res);
  assert.equal(out.code, 400);
  assert.match(out.body.error, /source must be one of/);
});

test('upload is tenant-scoped — t2 rows never mix into t1', async () => {
  const [res, out] = makeRes();
  await uploadHandler({ method: 'POST', headers: { authorization: 'Bearer token-t2' }, body: JSON.stringify({ source: 'manual_csv', rows: [{ rating: '5', author: 'T2 Client', body: 'Great experience at salon two, loved it.' }] }) }, res);
  assert.equal(out.code, 200);
  const t2rows = fake.all('review_queue').filter(r => r.tenant_id === 't2');
  assert.equal(t2rows.length, 2, 'pre-seeded r4 + new manual row');
  assert.ok(t2rows.every(r => r.tenant_id === 't2'));
});

console.log('\\nreviews-list: tenant review page backend ✅');
