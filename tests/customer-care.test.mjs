/**
 * tests/customer-care.test.mjs — LolaDesk's own customer-service line.
 *
 * Run:  node tests/customer-care.test.mjs
 *
 * Covers the admin gate (401/403), GET state with no Telnyx calls, a full
 * provision (assistant create → number attach → persist), idempotent reuse,
 * and refusal of a non-owned number. Telnyx is stubbed at fetch.
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
  '// Generated test double — see tests/customer-care.test.mjs',
  'export function createClient() {',
  "  const fake = globalThis.__CARE_FAKE_SUPABASE__;",
  "  if (!fake) throw new Error('No fake Supabase registered');",
  '  return fake;',
  '}', ''
].join('\n'));

const fake = new FakeSupabase();
globalThis.__CARE_FAKE_SUPABASE__ = fake;
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'fake-service-key';
process.env.TELNYX_API_KEY = 'test-telnyx-key';
process.env.TELNYX_MESSAGING_PROFILE = 'mp-1';
process.env.ADMIN_EMAILS = 'owner@t1.com';
process.env.APP_URL = 'https://www.loladesk.com';

fake.auth.users.set('token-admin', { id: 'admin-1', email: 'owner@t1.com' });
fake.auth.users.set('token-user', { id: 'user-1', email: 'salon@x.com' });
fake.seed('platform_settings', []);
fake.seed('tenant_numbers', []);

// ── Telnyx stub ────────────────────────────────────────────────────────
const state = { assistants: [], created: 0, patched: [], calls: [] };
function telnyxStub(){
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const method = String(init?.method || 'GET').toUpperCase();
    state.calls.push(method + ' ' + u);
    const json = (data) => ({ ok: true, status: 200, json: async () => data });

    if(u.includes('/ai/assistants') && method === 'GET'){
      return json({ data: state.assistants });
    }
    if(u.includes('/ai/assistants') && method === 'POST'){
      const created = { id: 'asst-care-' + (++state.created), name: 'LolaDesk Customer Care', telephony_settings: { default_texml_app_id: 'texml-1' } };
      state.assistants.push(created);
      return json({ data: created });
    }
    if(u.includes('/phone_numbers') && method === 'GET'){
      return json({ data: [
        { id: 'pn-1', phone_number: '+18605799845', connection_id: null },
        { id: 'pn-2', phone_number: '+12254309450', connection_id: null }
      ] });
    }
    if(u.includes('/phone_numbers/') && method === 'PATCH'){
      state.patched.push(u);
      return json({ data: { id: 'pn-1' } });
    }
    throw new Error('Unexpected Telnyx call in test: ' + method + ' ' + u);
  };
}

const { default: handler } = await import('../api/customer-care.js');

function makeRes(){
  const out = { code: 200, headers: {}, body: null };
  return [{
    setHeader(k, v){ out.headers[k] = v; },
    status(c){ out.code = c; return this; },
    json(o){ out.body = o; return o; },
    end(){ out.code = out.code || 200; }
  }, out];
}
const ADMIN = { authorization: 'Bearer token-admin', 'content-type': 'application/json' };
const USER = { authorization: 'Bearer token-user', 'content-type': 'application/json' };

test('customer-care requires a signed-in admin (401 anon, 403 non-admin)', async () => {
  const [r1, o1] = makeRes();
  await handler({ method: 'GET', headers: {} }, r1);
  assert.equal(o1.code, 401);

  const [r2, o2] = makeRes();
  await handler({ method: 'GET', headers: USER }, r2);
  assert.equal(o2.code, 403);

  const [r3, o3] = makeRes();
  await handler({ method: 'POST', headers: {}, body: JSON.stringify({}) }, r3);
  assert.equal(o3.code, 401);
});

test('GET reports unconfigured state without any Telnyx call', async () => {
  state.calls.length = 0;
  const [res, out] = makeRes();
  await handler({ method: 'GET', headers: ADMIN }, res);
  assert.equal(out.code, 200);
  assert.equal(out.body.configured, false);
  assert.equal(out.body.number, null);
  assert.equal(state.calls.length, 0, 'GET must not call Telnyx');
});

test('POST provisions: creates the care assistant, attaches an owned number, persists', async () => {
  telnyxStub();
  const [res, out] = makeRes();
  await handler({ method: 'POST', headers: ADMIN, body: JSON.stringify({}) }, res);
  assert.equal(out.code, 200);
  assert.equal(out.body.ok, true);
  assert.equal(out.body.created_assistant, true);
  assert.equal(out.body.assistant.id, 'asst-care-1');
  assert.equal(out.body.number, '+18605799845');
  assert.equal(out.body.texml_app_id, 'texml-1');
  assert.equal(out.body.attached.voice, true);
  // Persisted for idempotency across redeploys.
  const row = fake.all('platform_settings').find(r => r.key === 'customer_care');
  assert.ok(row, 'pair must be persisted');
  assert.equal(row.value.number, '+18605799845');
  assert.equal(row.value.assistant_id, 'asst-care-1');
  // Attach calls happened.
  assert.ok(state.patched.some(u => u.includes('/phone_numbers/pn-1/voice')));
  assert.ok(state.patched.some(u => u.includes('/phone_numbers/pn-1/messaging')));
});

test('POST is idempotent: reuses the existing assistant, no duplicate create', async () => {
  const before = state.created;
  const [res, out] = makeRes();
  await handler({ method: 'POST', headers: ADMIN, body: JSON.stringify({ phone_number: '+12254309450' }) }, res);
  assert.equal(out.code, 200);
  assert.equal(out.body.created_assistant, false, 'must reuse the existing care assistant');
  assert.equal(state.created, before, 'must not create a second assistant');
  assert.equal(out.body.number, '+12254309450');
});

test('POST refuses a number that is not owned by the account', async () => {
  const [res, out] = makeRes();
  await handler({ method: 'POST', headers: ADMIN, body: JSON.stringify({ phone_number: '+19999999999' }) }, res);
  assert.equal(out.code, 400);
  assert.match(out.body.error, /not an owned/i);
});