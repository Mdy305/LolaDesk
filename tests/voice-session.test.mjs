/**
 * tests/voice-session.test.mjs — the DIRECT voice session (Jarvis path)
 *
 * Run:
 *   node tests/voice-session.test.mjs
 *   node --test tests/
 *
 * Proves the architectural decoupling the orb depends on:
 *   1. The direct voice session is TELEPHONY-INDEPENDENT — with ZERO rows in
 *      the calls table (in fact with the calls table never even touched),
 *      Lola still wakes, thinks, and returns a reply + canonical voice.
 *   2. Auth gating (owner-scoped, same gate as /api/lola).
 *   3. When ElevenLabs is configured, the session returns Lola's canonical
 *      voice audio IN BAND (base64 MP3) — one round trip, no telephony id.
 *   4. The refactored /api/lola thin handler still serves the same brain.
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
  '// Generated test double — see tests/voice-session.test.mjs',
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
delete process.env.ELEVENLABS_API_KEY;
delete process.env.ELEVENLABS_VOICE_ID;

fake.auth.users.set('token-t1', { id: 'user-1', email: 'owner@t1.com' });

// NOTE: deliberately NO calls table and NO call rows. The direct voice
// session must work identically for a salon with zero telephony history —
// that is the coupling this test exists to forbid.
fake.seed('tenants', [
  {
    id: 't1', name: 'Salon One', owner_email: 'owner@t1.com',
    location: 'Miami', hours: 'Tue–Sat 9am–7pm',
    services: [{ name: 'Balayage', price: 395 }]
  }
]);
fake.seed('tenant_users', []);

const sessionHandler = (await import('../api/voice/session.js')).default;
const lolaHandler = (await import('../api/lola.js')).default;

const LOLA_REPLY = 'Right this way — what can I do for you today?';
const MP3_BYTES = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]); // tiny ID3 header

const realFetch = globalThis.fetch;
function stubFetch({ telnyx = true, elevenlabs = false } = {}) {
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (telnyx && u.includes('api.telnyx.com/v2/ai/openai/chat/completions')) {
      return {
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: LOLA_REPLY } }] })
      };
    }
    if (elevenlabs && u.includes('api.elevenlabs.io/v1/text-to-speech')) {
      return {
        ok: true, status: 200,
        arrayBuffer: async () => MP3_BYTES.buffer.slice(MP3_BYTES.byteOffset, MP3_BYTES.byteOffset + MP3_BYTES.byteLength)
      };
    }
    throw new Error('Unexpected fetch in test: ' + u);
  };
}

function makeRes() {
  const out = { code: 200, headers: {}, body: null };
  return [{
    setHeader(k, v) { out.headers[k] = v; },
    status(c) { out.code = c; return this; },
    json(o) { out.body = o; return o; },
    end() { out.code = out.code || 200; }
  }, out];
}

test('direct voice session requires authentication', async () => {
  const [res, out] = makeRes();
  await sessionHandler({ method: 'POST', headers: {}, body: JSON.stringify({ text: 'hi' }) }, res);
  assert.equal(out.code, 401);
});

test('direct voice session answers with ZERO telephony state (calls table never touched)', async () => {
  stubFetch({ telnyx: true, elevenlabs: false });
  const [res, out] = makeRes();
  await sessionHandler({
    method: 'POST',
    headers: { authorization: 'Bearer token-t1', 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'hi', system: 'You are Lola, a salon concierge.' })
  }, res);
  assert.equal(out.code, 200);
  assert.equal(out.body.ok, true);
  assert.ok(out.body.reply && out.body.reply.length > 0, 'reply must be non-empty');
  assert.equal(out.body.engine, 'text', 'voice unconfigured → reply delivered as text, never a fake voice');
  assert.equal(out.body.audio, null);
  // The decoupling proof: the handler never even opened the calls table.
  assert.equal(fake.tables.has('calls'), false, 'voice session must not depend on the calls table');
  globalThis.fetch = realFetch;
});

test('direct voice session returns Lola canonical voice audio in band when configured', async () => {
  process.env.ELEVENLABS_API_KEY = 'test-eleven-key';
  process.env.ELEVENLABS_VOICE_ID = 'lola-canonical-1';
  stubFetch({ telnyx: true, elevenlabs: true });
  const [res, out] = makeRes();
  await sessionHandler({
    method: 'POST',
    headers: { authorization: 'Bearer token-t1', 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'hi' })
  }, res);
  assert.equal(out.code, 200);
  assert.equal(out.body.ok, true);
  assert.equal(out.body.engine, 'elevenlabs');
  assert.equal(out.body.mime, 'audio/mpeg');
  assert.ok(typeof out.body.audio === 'string' && out.body.audio.length > 0, 'audio must be base64 MP3');
  const decoded = Buffer.from(out.body.audio, 'base64');
  assert.ok(decoded.length > 0, 'decoded audio must be non-empty');
  globalThis.fetch = realFetch;
  delete process.env.ELEVENLABS_API_KEY;
  delete process.env.ELEVENLABS_VOICE_ID;
});

test('/api/lola thin handler still serves the same brain after refactor', async () => {
  stubFetch({ telnyx: true, elevenlabs: false });
  const [res, out] = makeRes();
  await lolaHandler({
    method: 'POST',
    headers: { authorization: 'Bearer token-t1', 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
  }, res);
  assert.equal(out.code, 200);
  const text = Array.isArray(out.body.content) ? out.body.content[0].text : '';
  assert.ok(text && text.length > 0, 'dashboard brain must still answer');
  globalThis.fetch = realFetch;
});

console.log('\nvoice-session: direct, telephony-independent voice path ✅');
