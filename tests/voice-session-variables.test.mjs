/**
 * tests/voice-session-variables.test.mjs — the orb's FIRST-FRAME contract
 *
 * The dashboard orb sends session.update with dynamic_variables as its
 * first relay frame. This test proves /api/voice-session hands the client
 * everything it needs for that frame:
 *   1. the response carries dynamic_variables for the signed-in owner's
 *      tenant (company_name resolved from the DB, not a template),
 *   2. the phone-call webhook (agent-variables) and the orb builder agree —
 *      same company_name/services facts for the same tenant,
 *   3. the variables still come back when the catalog tables are empty
 *      (degraded but never silent-by-missing-data).
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
process.env.TELNYX_ASSISTANT_ID = 'assistant-test';
process.env.TELNYX_PUBLIC_KEY = 'test-public-key';

fake.auth.users.set('tok-owner', { id: 'u1', email: 'owner@x.com' });
fake.seed('tenants', [
  { id: 't1', name: 'Glow Salon', slug: 'glow', owner_email: 'owner@x.com', location: 'Miami', hours: 'Tue-Sat 9-7' }
]);
fake.seed('services', [
  { id: 's1', tenant_id: 't1', name: 'Balayage', price: 300, duration_minutes: 150, is_active: true }
]);
fake.seed('staff', [
  { id: 'st1', tenant_id: 't1', name: 'Jerome', role: 'Master Colorist', is_active: true }
]);

const { default: voiceSession } = await import('../api/voice-session.js');
const { default: agentVariables } = await import('../api/agent-variables.js');

function makeRes() {
  const out = { code: 200, body: null };
  return [{
    setHeader() {},
    status(c) { out.code = c; return this; },
    json(o) { out.body = o; return o; }
  }, out];
}

test('voice-session returns dynamic_variables for the signed-in owner', async () => {
  fake.reset();
  fake.auth.users.set('tok-owner', { id: 'u1', email: 'owner@x.com' });
  fake.seed('tenants', [
    { id: 't1', name: 'Glow Salon', slug: 'glow', owner_email: 'owner@x.com', location: 'Miami', hours: 'Tue-Sat 9-7' }
  ]);
  const [res, out] = makeRes();
  await voiceSession({ method: 'POST', headers: { authorization: 'Bearer tok-owner' }, body: {} }, res);
  assert.equal(out.code, 200);
  assert.ok(out.body.session_token, 'session token present');
  assert.ok(out.body.dynamic_variables, 'dynamic_variables present');
  assert.equal(out.body.dynamic_variables.company_name, 'Glow Salon');
  assert.equal(out.body.dynamic_variables.tenant_id, 't1');
  assert.ok(out.body.dynamic_variables.knowledge, 'knowledge prompt present');
});

test('voice-session variables agree with the phone webhook for the same tenant', async () => {
  fake.reset();
  fake.auth.users.set('tok-owner', { id: 'u1', email: 'owner@x.com' });
  fake.seed('tenants', [
    { id: 't1', name: 'Glow Salon', slug: 'glow', owner_email: 'owner@x.com', location: 'Miami', hours: 'Tue-Sat 9-7' }
  ]);
  fake.seed('services', [
    { id: 's1', tenant_id: 't1', name: 'Balayage', price: 300, duration_minutes: 150, is_active: true }
  ]);
  fake.seed('staff', [
    { id: 'st1', tenant_id: 't1', name: 'Jerome', role: 'Master Colorist', is_active: true }
  ]);
  fake.seed('tenant_numbers', [
    { phone_number: '+13055550001', tenant_id: 't1' }
  ]);

  const [res1, out1] = makeRes();
  await voiceSession({ method: 'POST', headers: { authorization: 'Bearer tok-owner' }, body: {} }, res1);
  const orbVars = out1.body?.dynamic_variables;

  const [res2, out2] = makeRes();
  await agentVariables({ method: 'POST', headers: {}, url: '/', body: {
    data: { payload: { to: '+13055550001', from: '+13055550002' } }
  } }, res2);
  const phoneVars = out2.body?.dynamic_variables;

  assert.ok(orbVars && phoneVars, 'both paths returned variables');
  assert.equal(orbVars.company_name, phoneVars.company_name, 'same salon');
  assert.equal(orbVars.services, phoneVars.services, 'same services');
  assert.equal(orbVars.staff, phoneVars.staff, 'same staff');
  assert.equal(orbVars.tenant_id, phoneVars.tenant_id, 'same tenant');
});

test('variables still return when the catalog tables are empty', async () => {
  fake.reset();
  fake.auth.users.set('tok-owner', { id: 'u1', email: 'owner@x.com' });
  fake.seed('tenants', [
    { id: 't1', name: 'Glow Salon', slug: 'glow', owner_email: 'owner@x.com' }
  ]);
  const [res, out] = makeRes();
  await voiceSession({ method: 'POST', headers: { authorization: 'Bearer tok-owner' }, body: {} }, res);
  assert.equal(out.code, 200);
  assert.equal(out.body.dynamic_variables.company_name, 'Glow Salon');
  assert.equal(out.body.dynamic_variables.services, '');
});
