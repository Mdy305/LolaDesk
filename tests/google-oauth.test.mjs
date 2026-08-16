/**
 * tests/google-oauth.test.mjs — tests for the Google OAuth login flow.
 *
 * Covers the server side of the flow: googleAuthUrl() builds an implicit-flow
 * authorize URL, /api/auth/google 302-redirects the browser there, and
 * /api/auth/google/finalize provisions a workspace for a first-time Google
 * user (and stays idempotent on retry).
 *
 * Run:
 *   node --test tests/google-oauth.test.mjs
 *
 * Uses the same in-memory Supabase stand-in as the booking tests.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeSupabase } from './fake-supabase.js';

// ── provision the @supabase/supabase-js test double ────────────────
const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STUB_DIR = join(API_ROOT, 'node_modules', '@supabase', 'supabase-js');
mkdirSync(STUB_DIR, { recursive: true });
writeFileSync(join(STUB_DIR, 'package.json'), JSON.stringify({
  name: '@supabase/supabase-js',
  version: '0.0.0-test',
  type: 'module',
  main: 'index.js',
  exports: { '.': './index.js' }
}, null, 2));
writeFileSync(join(STUB_DIR, 'index.js'), [
  '// Generated test double — see tests/booking-brain.test.mjs',
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
process.env.APP_URL = 'https://test.loladesk.com';
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

const { googleAuthUrl } = await import('../api/lib/auth.js');
const googleHandler = (await import('../api/auth/google.js')).default;
const finalizeHandler = (await import('../api/auth/google/finalize.js')).default;

// Minimal Vercel-style req/res capture.
function call(handler, { method = 'GET', url = '/', token = null, body = null } = {}) {
  const req = { method, url, body, headers: token ? { authorization: `Bearer ${token}` } : {} };
  const res = {
    status: 200, body: undefined, location: null, _json: null,
    setHeader() {},
    status(code) { this.status = code; return this; },
    json(obj) { this._json = obj; this.body = JSON.stringify(obj); return this; },
    writeHead(code, headers = {}) { this.status = code; this.location = headers.Location || null; return this; },
    end() { return this; }
  };
  return Promise.resolve(handler(req, res)).then(() => res);
}

function registerUser(token, user) {
  fake.auth.users.set(token, user);
  return token;
}

test('googleAuthUrl builds an implicit-flow authorize URL for redirectTo', async () => {
  const url = await googleAuthUrl('https://test.loladesk.com/oauth-callback.html');

  assert.ok(url.startsWith('https://fake.supabase.co/auth/v1/authorize?'));
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('provider'), 'google');
  assert.equal(parsed.searchParams.get('redirect_to'), 'https://test.loladesk.com/oauth-callback.html');
  assert.equal(parsed.searchParams.get('flow'), 'implicit');
});

test('/api/auth/google redirects the browser to the authorize URL', async () => {
  const res = await call(googleHandler, { url: '/api/auth/google' });

  assert.equal(res.status, 302);
  assert.ok(res.location && res.location.startsWith('https://fake.supabase.co/auth/v1/authorize?'));
  const parsed = new URL(res.location);
  assert.equal(parsed.searchParams.get('redirect_to'), 'https://test.loladesk.com/oauth-callback.html');
  // No query params on the callback — implicit-flow tokens go in the fragment.
  assert.ok(!parsed.searchParams.get('redirect_to').includes('?'));
});

test('/api/auth/google/finalize provisions a workspace for a new Google user', async () => {
  fake.reset();
  registerUser('tok-new', {
    id: 'user-new', email: 'owner@salon.com', user_metadata: { full_name: 'Owner One' }
  });

  const res = await call(finalizeHandler, { method: 'POST', url: '/api/auth/google/finalize', token: 'tok-new' });

  assert.equal(res.status, 200);
  assert.equal(res._json.created, true);
  assert.ok(res._json.tenant?.id);

  const tenants = fake.all('tenants');
  assert.equal(tenants.length, 1);
  assert.equal(tenants[0].owner_email, 'owner@salon.com');
  assert.equal(tenants[0].name, 'Owner One');

  const memberships = fake.all('tenant_users');
  assert.equal(memberships.length, 1);
  assert.equal(memberships[0].user_id, 'user-new');
  assert.equal(memberships[0].role, 'owner');

  const onboarding = fake.all('tenant_onboarding');
  assert.equal(onboarding.length, 1);
  assert.equal(onboarding[0].tenant_id, tenants[0].id);
});

test('/api/auth/google/finalize is idempotent (no duplicate workspace)', async () => {
  fake.reset();
  registerUser('tok-existing', {
    id: 'user-existing', email: 'owner@salon.com', user_metadata: { full_name: 'Owner One' }
  });

  const first = await call(finalizeHandler, { method: 'POST', url: '/api/auth/google/finalize', token: 'tok-existing' });
  assert.equal(first._json.created, true);

  // A retried callback (same token, tenant now exists) must not mint a second salon.
  const second = await call(finalizeHandler, { method: 'POST', url: '/api/auth/google/finalize', token: 'tok-existing' });
  assert.equal(second.status, 200);
  assert.equal(second._json.created, false);
  assert.equal(fake.all('tenants').length, 1);
});
