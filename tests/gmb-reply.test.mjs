/**
 * tests/gmb-reply.test.mjs — Lola auto-replies to Google reviews
 * (connector replyToReview + /api/reviews/gmb-reply).
 *
 * Run: node tests/gmb-reply.test.mjs
 *
 * Stubs Google via global fetch (accounts/locations/reviews + :updateReply)
 * and relies on the deterministic fallback reply (no TELNYX_API_KEY set, so
 * llm.chat degrades and Lola's template answers): POST replies only to
 * unreplied reviews, posts each via the real updateReply shape, logs the
 * reply forever (dedupe), PATCH toggles the per-salon opt-in, GET returns
 * state, and unauthenticated callers get 401.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert';
import { FakeSupabase } from './fake-supabase.js';

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STUB_DIR = join(API_ROOT, 'node_modules', '@supabase', 'supabase-js');
mkdirSync(STUB_DIR, { recursive: true });
writeFileSync(join(STUB_DIR, 'package.json'), JSON.stringify({
  name: '@supabase/supabase-js', version: '0.0.0-test', type: 'module',
  main: 'index.js', exports: { '.': './index.js' }
}, null, 2));
writeFileSync(join(STUB_DIR, 'index.js'), [
  '// Generated test double — see tests/gmb-reply.test.mjs',
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
// No TELNYX_API_KEY → llm.chat fails → deterministic fallback replies.

const { default: handler } = await import('../api/reviews/gmb-reply.js');

const R1 = 'accounts/ACCT1/locations/LOC1/reviews/REV1';
const R2 = 'accounts/ACCT1/locations/LOC1/reviews/REV2';

function json(payload, status = 200){
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload), json: async () => payload };
}

let postedReplies = [];
function stubGoogle(reviews){
  postedReplies = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('oauth2.googleapis.com/token')) return json({ access_token: 'gtok', expires_in: 3600 });
    if (u.endsWith('/accounts') || u.includes('/accounts?')) return json({ accounts: [{ name: 'accounts/ACCT1' }] });
    if (u.includes('/locations?')) return json({ locations: [{ name: 'accounts/ACCT1/locations/LOC1' }] });
    if (u.includes(':updateReply')) {
      const body = JSON.parse(opts.body || '{}');
      postedReplies.push({ name: u.split('/v1/')[1].split(':updateReply')[0], comment: body?.comment?.comment || '' });
      return json({ comment: { comment: body?.comment?.comment } });
    }
    if (u.includes('/reviews?')) return json({ reviews });
    throw new Error('unmocked Google path: ' + u);
  };
  return realFetch;
}

function call(req){
  const res = { statusCode: 200, _json: null };
  res.setHeader = () => {};
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => { res._json = obj; return res; };
  res.end = () => {};
  return handler(req, res).then(() => ({ status: res.statusCode, json: res._json }));
}

function seed(extra = {}){
  fake.reset();
  fake.auth.users.set('token-t1', { id: 'user-1', email: 'owner@t1.com' });
  fake.seed('tenants', [{ id: 't1', slug: 'salon-a', name: 'Salon A', owner_email: 'owner@t1.com', phone_number: '+13055550100', auto_reply_gmb: false }]);
  fake.seed('integrations', [{ tenant_id: 't1', provider: 'google_gmb', access_token: 'gtok', status: 'connected' }]);
  if (extra.replies) fake.seed('gmb_review_replies', extra.replies);
}

test('GET returns connection state, toggle, and recent replies', async () => {
  seed({ replies: [{ tenant_id: 't1', review_id: R1, rating: 5, reviewer: 'Prior', reply: 'Thanks!', posted_at: '2026-08-25T00:00:00Z' }] });
  const res = await call({ method: 'GET', headers: { authorization: 'Bearer token-t1' } });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.connected, true);
  assert.equal(res.json.auto_reply_gmb, false);
  assert.equal(res.json.recent.length, 1);
  assert.ok(res.json.note.includes('retired'));
});

test('POST replies only to UNREPLIED reviews and logs them forever', async () => {
  seed({ replies: [{ tenant_id: 't1', review_id: R2, rating: 5, reviewer: 'Prior', reply: 'Already answered', posted_at: '2026-08-24T00:00:00Z' }] });
  const realFetch = stubGoogle([
    { name: R1, starRating: 'FIVE', comment: 'Best blowout in the city, Lola booked me instantly!', reviewer: { displayName: 'Sarah K' }, createTime: '2026-08-01T10:00:00Z' },
    { name: R2, starRating: 'ONE', comment: 'Terrible service, never again.', reviewer: { displayName: 'Angry A' }, createTime: '2026-07-01T08:00:00Z' }
  ]);
  try{
    const res = await call({ method: 'POST', headers: { authorization: 'Bearer token-t1' }, body: {} });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.reviewed, 2);
    assert.equal(res.json.replied, 1);   // R2 was already logged
    assert.equal(res.json.already, 1);
    assert.equal(postedReplies.length, 1);
    assert.equal(postedReplies[0].name, R1);
    assert.ok(postedReplies[0].comment.includes('Thank you so much'), 'deterministic Lola thank-you used');

    const log = fake.all('gmb_review_replies');
    assert.equal(log.length, 2); // seeded R2 + new R1
    const newRow = log.find(r => r.review_id === R1);
    assert.ok(newRow);
    assert.equal(newRow.tenant_id, 't1');
    assert.equal(newRow.rating, 5);
    assert.ok(newRow.reply.includes('Sarah'));
  } finally { globalThis.fetch = realFetch; }
});

test('POST is idempotent — a second run replies to nothing', async () => {
  seed();
  const realFetch = stubGoogle([
    { name: R1, starRating: 'FIVE', comment: 'Amazing!', reviewer: { displayName: 'Sarah K' }, createTime: '2026-08-01T10:00:00Z' }
  ]);
  try{
    await call({ method: 'POST', headers: { authorization: 'Bearer token-t1' }, body: {} });
    const res = await call({ method: 'POST', headers: { authorization: 'Bearer token-t1' }, body: {} });
    assert.equal(res.json.replied, 0);
    assert.equal(res.json.already, 1);
    assert.equal(postedReplies.length, 1, 'only the first run posts');
  } finally { globalThis.fetch = realFetch; }
});

test('PATCH toggles the per-salon auto-reply flag', async () => {
  seed();
  const on = await call({ method: 'PATCH', headers: { authorization: 'Bearer token-t1' }, body: { auto_reply_gmb: true } });
  assert.equal(on.status, 200);
  assert.equal(on.json.ok, true);
  assert.equal(on.json.auto_reply_gmb, true);
  assert.equal(fake.all('tenants')[0].auto_reply_gmb, true);

  const off = await call({ method: 'PATCH', headers: { authorization: 'Bearer token-t1' }, body: { auto_reply_gmb: false } });
  assert.equal(off.json.auto_reply_gmb, false);
  assert.equal(fake.all('tenants')[0].auto_reply_gmb, false);

  const bad = await call({ method: 'PATCH', headers: { authorization: 'Bearer token-t1' }, body: { auto_reply_gmb: 'yes' } });
  assert.equal(bad.status, 400);
});

test('unauthenticated callers get 401', async () => {
  seed();
  const res = await call({ method: 'GET', headers: {} });
  assert.equal(res.status, 401);
});
