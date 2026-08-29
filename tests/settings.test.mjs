/**
 * tests/settings.test.mjs — Settings contract + Lola's "special instructions".
 *
 * Run:
 *   node tests/settings.test.mjs
 *
 * Exercises the REAL /api/settings handler and tenantKnowledgePrompt against
 * the in-memory fake DB:
 *   • instructions round-trips (GET loads it, POST persists it)
 *   • instructions surface into Lola's call prompt
 *   • a posted field with no backend column is surfaced (400 + ignored), never
 *     silently reported as saved
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
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
  '// Generated test double — see tests/settings.test.mjs',
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

const { default: settingsHandler } = await import('../api/settings.js');
const { tenantKnowledgePrompt } = await import('../api/lib/db.js');

const TID = '11111111-1111-1111-1111-111111111111';
const EMAIL = 'owner@salon.com';
const USER = { id: 'u1', email: EMAIL };
const TOKEN = 'tok-owner';

function seed(instructions = undefined) {
  fake.reset();
  const tenant = { id: TID, slug: 'salon-a', name: 'Salon A', owner_email: EMAIL, operator_phone: null };
  if (instructions !== undefined) tenant.instructions = instructions;
  fake.seed('tenants', [tenant]);
  fake.seed('integrations', []);
  fake.auth.users.set(TOKEN, USER);
}

function call(handler, method, body, token = TOKEN) {
  const req = {
    method, headers: {}, body: typeof body === 'string' ? body : (body === undefined ? null : JSON.stringify(body)),
    query: {}
  };
  if (token) req.headers.Authorization = 'Bearer ' + token;
  let sent = null;
  const res = {
    setHeader(){}, status(c){ sent = c; return res; },
    json(obj){ return obj; }
  };
  return (async () => {
    const out = await handler(req, res);
    return { status: res.statusCode ?? sent, json: out || {} };
  })();
}

test('GET loads the owner-written instructions back', async () => {
  seed('Never quote a discount over the phone.');
  const { status, json } = await call(settingsHandler, 'GET');
  assert.equal(status, 200);
  assert.equal(json.tenant.instructions, 'Never quote a discount over the phone.');
});

test('POST persists instructions and reports nothing ignored', async () => {
  seed();
  const { status, json } = await call(settingsHandler, 'POST', { instructions: 'Always mention the 30% newcomer promotion.' });
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.deepEqual(json.saved, ['instructions']);
  assert.deepEqual(json.ignored, []);
  assert.equal(fake.all('tenants')[0].instructions, 'Always mention the 30% newcomer promotion.');
});

test('instructions are surfaced into Lola call prompt', async () => {
  seed('Never end a call without offering a next appointment.');
  const prompt = tenantKnowledgePrompt(fake.all('tenants')[0]);
  assert.match(prompt, /Owner instructions: Never end a call without offering a next appointment\./);
});

test('a posted field with no backend column fails loud instead of false success', async () => {
  seed();
  const { status, json } = await call(settingsHandler, 'POST', { voice_enabled: true });
  assert.equal(status, 400);
  assert.equal(json.ok, false);
  assert.deepEqual(json.ignored, ['voice_enabled']);
  // Nothing persisted for the unsupported field (schema has no such column).
  assert.equal(fake.all('tenants')[0].voice_enabled, undefined);
});

test('an entire unsupported panel is reported, not silently dropped', async () => {
  seed();
  const { status, json } = await call(settingsHandler, 'POST', {
    can_book: true, can_quote: true, can_upsell: false
  });
  assert.equal(status, 400);
  assert.ok(json.ignored.includes('can_book'));
  assert.ok(json.ignored.includes('can_quote'));
  assert.ok(json.ignored.includes('can_upsell'));
});