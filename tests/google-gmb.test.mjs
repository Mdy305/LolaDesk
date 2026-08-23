/**
 * tests/google-gmb.test.mjs — Google Business Profile reviews connector +
 * /api/reviews/import-google endpoint.
 *
 * Run: node tests/google-gmb.test.mjs
 *
 * Stubs the Google APIs via global fetch: OAuth URL shape, token exchange,
 * accounts/locations discovery, review listing (rating enum → number), and
 * the import endpoint routing 5-star Google reviews into the review_queue.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert';
import { FakeSupabase } from './fake-supabase.js';

// Stub @supabase/supabase-js so api/lib/db.js + api/lib/auth.js use the fake
// (same pattern as reviews-list.test.mjs).
const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STUB_DIR = join(API_ROOT, 'node_modules', '@supabase', 'supabase-js');
mkdirSync(STUB_DIR, { recursive: true });
writeFileSync(join(STUB_DIR, 'package.json'), JSON.stringify({
  name: '@supabase/supabase-js', version: '0.0.0-test', type: 'module',
  main: 'index.js', exports: { '.': './index.js' }
}, null, 2));
writeFileSync(join(STUB_DIR, 'index.js'), [
  '// Generated test double — see tests/google-gmb.test.mjs',
  'export function createClient() {',
  "  const fake = globalThis.__LOLA_FAKE_SUPABASE__;",
  "  if (!fake) throw new Error('No fake Supabase registered');",
  '  return fake;',
  '}', ''
].join('\n'));

const fake = new FakeSupabase();
globalThis.__LOLA_FAKE_SUPABASE__ = fake;

process.env.APP_URL = 'https://www.loladesk.com';
process.env.GOOGLE_CLIENT_ID = 'g-client';
process.env.GOOGLE_CLIENT_SECRET = 'g-secret';
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'fake-service-key';

function json(payload, status = 200){
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload), json: async () => payload };
}

function stubGoogle(reviews){
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('oauth2.googleapis.com/token')) return json({ access_token: 'gtok', refresh_token: 'gref', expires_in: 3600 });
    if (u.includes('/accounts?') || u.endsWith('/accounts')) return json({ accounts: [{ name: 'accounts/ACCT1', accountName: 'Salon A' }] });
    if (u.includes('/locations?')) return json({ locations: [{ name: 'accounts/ACCT1/locations/LOC1', locationName: 'Salon A' }] });
    if (u.includes('/reviews?')) return json({ reviews });
    throw new Error('unmocked Google path: ' + u);
  };
  return realFetch;
}

function call(handler, req){
  const res = {};
  res.statusCode = 200; res._json = null;
  res.setHeader = () => {};
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => { res._json = obj; return res; };
  res.end = () => {};
  return handler(req, res).then(() => ({ status: res.statusCode, json: res._json }));
}

test('google-gmb OAuth URL uses the business.manage scope and correct redirect', async () => {
  const { getAuthUrl } = await import('../api/lib/connectors/google-gmb.js');
  const url = getAuthUrl('state-1');
  assert.ok(url.startsWith('https://accounts.google.com/o/oauth2/v2/auth?'));
  assert.ok(url.includes('scope=' + encodeURIComponent('https://www.googleapis.com/auth/business.manage')));
  assert.ok(url.includes('redirect_uri=' + encodeURIComponent('https://www.loladesk.com/api/oauth/callback?provider=google_gmb')));
  assert.ok(url.includes('state=state-1'));
});

test('listReviews discovers account/location and normalizes the star enum', async () => {
  const realFetch = stubGoogle([
    { starRating: 'FIVE', comment: 'Absolutely incredible blowout, best in the city!', reviewer: { displayName: 'Sarah K' }, createTime: '2026-08-01T10:00:00Z' },
    { starRating: 'FOUR', comment: 'Good haircut, decent value.', reviewer: { displayName: 'Marco R' }, createTime: '2026-07-20T09:00:00Z' },
    { starRating: 'ONE', comment: 'Terrible service, never again.', reviewer: { displayName: 'Angry A' }, createTime: '2026-07-01T08:00:00Z' }
  ]);
  try{
    const { listReviews } = await import('../api/lib/connectors/google-gmb.js');
    const reviews = await listReviews({ access_token: 'gtok' });
    assert.equal(reviews.length, 3);
    assert.equal(reviews[0].rating, 5);
    assert.equal(reviews[0].author, 'Sarah K');
    assert.equal(reviews[1].rating, 4);
    assert.equal(reviews[2].rating, 1);
  } finally { globalThis.fetch = realFetch; }
});

test('import-google schedules only 5-star Google reviews into the queue', async () => {
  fake.reset();
  fake.auth.users.set('token-t1', { id: 'user-1', email: 'owner@t1.com' });
  fake.seed('tenants', [{ id: 't1', slug: 'salon-a', name: 'Salon A', owner_email: 'owner@t1.com' }]);
  fake.seed('integrations', [{ tenant_id: 't1', provider: 'google_gmb', access_token: 'gtok', status: 'connected' }]);
  const realFetch = stubGoogle([
    { starRating: 'FIVE', comment: 'Lola booked me in seconds, amazing salon experience!', reviewer: { displayName: 'Sarah K' }, createTime: '2026-08-01T10:00:00Z' },
    { starRating: 'FOUR', comment: 'Fine haircut but nothing special honestly.', reviewer: { displayName: 'Marco R' }, createTime: '2026-07-20T09:00:00Z' }
  ]);
  try{
    const { default: handler } = await import('../api/reviews/import-google.js');
    const res = await call(handler, {
      method: 'POST',
      headers: { authorization: 'Bearer token-t1' },
      body: {}
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.fetched, 2);
    assert.equal(res.json.scheduled, 1); // only the 5-star one
    const rows = fake.all('review_queue');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].author_name, 'Sarah K');
    assert.equal(rows[0].rating, 5);
    assert.equal(rows[0].source, 'google_gmb');
  } finally { globalThis.fetch = realFetch; }
});

test('import-google 400s with a clear message when Google is not connected', async () => {
  fake.reset();
  fake.auth.users.set('token-t1', { id: 'user-1', email: 'owner@t1.com' });
  fake.seed('tenants', [{ id: 't1', slug: 'salon-a', name: 'Salon A', owner_email: 'owner@t1.com' }]);
  const { default: handler } = await import('../api/reviews/import-google.js');
  const res = await call(handler, {
    method: 'POST',
    headers: { authorization: 'Bearer token-t1' },
    body: {}
  });
  assert.equal(res.status, 400);
  assert.ok(res.json.error.includes('Connect Google reviews first'));
});
