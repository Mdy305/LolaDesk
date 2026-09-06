/**
 * tests/lola-voice-fix.test.mjs — admin voice diagnose/repair endpoint
 *
 *   1. auth gates (unsigned → 401, non-admin → 403)
 *   2. GET reports the assistant's current voice, never the key
 *   3. PATCH validates the Telnyx Provider.Model.VoiceId shape (bare
 *      'af_nova' style ids rejected — they make Telnyx fail silently)
 *   4. PATCH sends voice_settings.voice to Telnyx and reports the result
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
process.env.ADMIN_EMAILS = 'boss@loladesk.com';

const { default: handler } = await import('../api/admin/lola-voice-fix.js');

const REAL_FETCH = globalThis.fetch;
function assistantJson(voice) {
  return { data: { id: 'assistant-test', name: 'LolaBrain', model: 'meta-llama/Llama-3.3-70B-Instruct', voice_settings: { voice } } };
}
function makeRes() {
  const out = { code: 200, body: null };
  return [{
    setHeader() {},
    status(c) { out.code = c; return this; },
    json(o) { out.body = o; return o; }
  }, out];
}

test('unsigned → 401; non-admin → 403', async () => {
  fake.reset();
  fake.auth.users.set('tok-nonadmin', { id: 'u2', email: 'salon@example.com' });
  let [res, out] = makeRes();
  await handler({ method: 'GET', headers: {}, body: {} }, res);
  assert.equal(out.code, 401);
  [res, out] = makeRes();
  await handler({ method: 'GET', headers: { authorization: 'Bearer tok-nonadmin' }, body: {} }, res);
  assert.equal(out.code, 403);
});

test('GET reports the current voice, never the key', async () => {
  fake.reset();
  fake.auth.users.set('tok-admin', { id: 'u1', email: 'boss@loladesk.com' });
  globalThis.fetch = async () => ({ status: 200, json: async () => assistantJson('elevenlabs-voice-abc') });
  try {
    const [res, out] = makeRes();
    await handler({ method: 'GET', headers: { authorization: 'Bearer tok-admin' }, body: {} }, res);
    assert.equal(out.code, 200);
    assert.equal(out.body.voice, 'elevenlabs-voice-abc');
    assert.ok(!JSON.stringify(out.body).includes('test-telnyx-key'), 'no key leak');
  } finally { globalThis.fetch = REAL_FETCH; }
});

test('PATCH rejects malformed voice ids', async () => {
  fake.reset();
  fake.auth.users.set('tok-admin', { id: 'u1', email: 'boss@loladesk.com' });
  globalThis.fetch = async () => { throw new Error('must not call Telnyx for invalid voice'); };
  try {
    for (const bad of ['af_nova', 'Clara', '', 'x']) {
      const [res, out] = makeRes();
      await handler({ method: 'PATCH', headers: { authorization: 'Bearer tok-admin' }, body: { voice: bad } }, res);
      assert.equal(out.code, 400, 'expected 400 for ' + JSON.stringify(bad));
    }
  } finally { globalThis.fetch = REAL_FETCH; }
});

test('PATCH sends voice_settings.voice and reports the patched value', async () => {
  fake.reset();
  fake.auth.users.set('tok-admin', { id: 'u1', email: 'boss@loladesk.com' });
  let sentBody = null;
  globalThis.fetch = async (url, opts = {}) => {
    if (opts.method === 'PATCH') sentBody = JSON.parse(opts.body);
    return { status: 200, json: async () => assistantJson('Telnyx.NaturalHD.astra') };
  };
  try {
    const [res, out] = makeRes();
    await handler({ method: 'PATCH', headers: { authorization: 'Bearer tok-admin' }, body: { voice: 'Telnyx.NaturalHD.astra' } }, res);
    assert.equal(out.code, 200);
    assert.equal(out.body.patched, 'Telnyx.NaturalHD.astra');
    assert.equal(sentBody?.voice_settings?.voice, 'Telnyx.NaturalHD.astra');
    assert.ok(!JSON.stringify(out.body).includes('test-telnyx-key'), 'no key leak');
  } finally { globalThis.fetch = REAL_FETCH; }
});
