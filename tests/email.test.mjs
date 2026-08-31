/**
 * tests/email.test.mjs — the real /api/email app-email path.
 *
 * Run:  node tests/email.test.mjs
 *
 * Covers: provider-config GET, auth gate, tenant-scoped recipient validation,
 * loud no-provider failure, a successful send via an injected sender (asserting
 * subject + the required unsubscribe footer), opt-out skip for non-transactional
 * kinds, and the unsubscribe flip.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeSupabase } from './fake-supabase.js';
import { renderEmail } from '../api/lib/email-templates.js';

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STUB_DIR = join(API_ROOT, 'node_modules', '@supabase', 'supabase-js');
mkdirSync(STUB_DIR, { recursive: true });
writeFileSync(join(STUB_DIR, 'package.json'), JSON.stringify({
  name: '@supabase/supabase-js', version: '0.0.0-test', type: 'module',
  main: 'index.js', exports: { '.': './index.js' }
}, null, 2));
writeFileSync(join(STUB_DIR, 'index.js'), [
  '// Generated test double — see tests/email.test.mjs',
  'export function createClient() {',
  "  const fake = globalThis.__EMAIL_FAKE_SUPABASE__;",
  "  if (!fake) throw new Error('No fake Supabase registered');",
  '  return fake;',
  '}', ''
].join('\n'));

const fake = new FakeSupabase();
globalThis.__EMAIL_FAKE_SUPABASE__ = fake;
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'fake-service-key';
process.env.APP_URL = 'https://www.loladesk.com';
delete process.env.SENDGRID_API_KEY;
delete process.env.MAILGUN_API_KEY;
delete process.env.MAILGUN_DOMAIN;
delete process.env.AWS_SES_REGION;
delete process.env.AWS_ACCESS_KEY_ID;

fake.auth.users.set('token-t1', { id: 'user-1', email: 'owner@t1.com' });
fake.seed('tenants', [
  { id: 't1', name: 'Salon One', owner_email: 'owner@t1.com' }
]);
fake.seed('tenant_users', []);
fake.seed('clients', [
  { id: 'c1', tenant_id: 't1', email: 'client@t1.com', first_name: 'Ava', opted_out: false },
  { id: 'c2', tenant_id: 't1', email: 'opto@t1.com', first_name: 'Bo', opted_out: true }
]);

const sent = [];
function fakeSend(args){
  sent.push(args);
  return { success: true, provider: 'test', messageId: 'msg-1' };
}

function makeRes(){
  const out = { code: 200, headers: {}, body: null };
  return [{
    setHeader(k, v){ out.headers[k] = v; },
    status(c){ out.code = c; return this; },
    json(o){ out.body = o; return o; },
    send(s){ out.body = s; return this; },
    end(){ out.code = out.code || 200; }
  }, out];
}

// Dynamic import AFTER the fake + stub are wired (static imports hoist above
// this setup, letting auth/lib/db create their Supabase client before the fake
// is registered — the same reason the voice-session test uses dynamic import).
const { default: emailDefault, createHandler: makeEmailHandler } = await import('../api/email.js');
const authedHandler = makeEmailHandler({ send: fakeSend });

const AUTH = { authorization: 'Bearer token-t1', 'content-type': 'application/json' };


test('template rendering includes the CAN-SPAM unsubscribe footer for every kind', () => {
  assert.match(renderEmail('confirmation', { to: 'a@x.com', tenantId: 't1' }).html, /Unsubscribe/);
  assert.match(renderEmail('follow_up', { to: 'a@x.com', tenantId: 't1' }).html, /Unsubscribe/);
  assert.match(renderEmail('review_request', { to: 'a@x.com', tenantId: 't1' }).html, /Unsubscribe/);
  assert.match(renderEmail('confirmation', { to: 'a@x.com', tenantId: 't1' }).text, /Unsubscribe/);
});

test('GET reports provider config without leaking any key', async () => {
  const [res, out] = makeRes();
  await emailDefault({ method: 'GET', query: {} }, res);
  assert.equal(out.code, 200);
  assert.equal(out.body.configured, false);
  assert.deepEqual(out.body.providers, { sendgrid: false, mailgun: false, ses: false });
});

test('POST requires authentication', async () => {
  const [res, out] = makeRes();
  await authedHandler({ method: 'POST', headers: {}, body: JSON.stringify({ kind: 'confirmation', to: 'client@t1.com' }) }, res);
  assert.equal(out.code, 401);
});

test('POST refuses a recipient that is not one of the tenant\u2019s clients', async () => {
  const [res, out] = makeRes();
  await authedHandler({ method: 'POST', headers: AUTH, body: JSON.stringify({ kind: 'confirmation', to: 'stranger@evil.com' }) }, res);
  assert.equal(out.code, 400);
  assert.match(out.body.error, /one of your clients/i);
});

test('POST fails loudly when no email provider is configured', async () => {
  const [res, out] = makeRes();
  await authedHandler({ method: 'POST', headers: AUTH, body: JSON.stringify({ kind: 'confirmation', to: 'client@t1.com' }) }, res);
  assert.equal(out.code, 503);
  assert.match(out.body.error, /SENDGRID_API_KEY/i);
  assert.equal(sent.length, 0, 'must not attempt a send with no provider');
});

test('POST confirmation sends through the injected sender with the footer', async () => {
  process.env.SENDGRID_API_KEY = 'test-sg-key'; // presence gates config; the sender is injected
  const [res, out] = makeRes();
  await authedHandler({ method: 'POST', headers: AUTH, body: JSON.stringify({ kind: 'confirmation', to: 'client@t1.com', service: 'Balayage' }) }, res);
  assert.equal(out.code, 200);
  assert.equal(out.body.ok, true);
  assert.equal(out.body.provider, 'test');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'client@t1.com');
  assert.match(sent[0].subject, /Confirmed: Balayage/i);
  assert.match(sent[0].html, /Unsubscribe/);
  delete process.env.SENDGRID_API_KEY;
});

test('POST review_request skips an opted-out client (send untouched)', async () => {
  const before = sent.length;
  const [res, out] = makeRes();
  await authedHandler({ method: 'POST', headers: AUTH, body: JSON.stringify({ kind: 'review_request', to: 'opto@t1.com' }) }, res);
  assert.equal(out.code, 200);
  assert.deepEqual(out.body, { ok: true, skipped: true, reason: 'opted_out', to: 'opto@t1.com' });
  assert.equal(sent.length, before);
});

test('unsubscribe flips the client\u2019s opt-out', async () => {
  const [res, out] = makeRes();
  await emailDefault({ method: 'GET', query: { email: 'client@t1.com', tenant: 't1' } }, res);
  assert.equal(out.code, 200);
  const row = fake.all('clients').find(c => c.id === 'c1');
  assert.equal(row.opted_out, true);
});