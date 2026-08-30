/**
 * tests/voice-session-ws.test.mjs — the STREAMING WebSocket voice session
 *
 * Run:
 *   node tests/voice-session-ws.test.mjs
 *   node --test tests/
 *
 * Connects a REAL `ws` client to the imported /api/voice/session-ws server
 * and proves the streaming contract: auth gate, reply text streamed in
 * phrase deltas, canonical voice audio streamed per phrase, and the
 * text-only (engine 'text') degradation — all through the same shared
 * brain, with zero telephony state involved.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { FakeSupabase } from './fake-supabase.js';

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STUB_DIR = join(API_ROOT, 'node_modules', '@supabase', 'supabase-js');
mkdirSync(STUB_DIR, { recursive: true });
writeFileSync(join(STUB_DIR, 'package.json'), JSON.stringify({
  name: '@supabase/supabase-js', version: '0.0.0-test', type: 'module',
  main: 'index.js', exports: { '.': './index.js' }
}, null, 2));
writeFileSync(join(STUB_DIR, 'index.js'), [
  '// Generated test double — see tests/voice-session-ws.test.mjs',
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
fake.seed('tenants', [
  { id: 't1', name: 'Salon One', owner_email: 'owner@t1.com', hours: 'Tue–Sat 9am–7pm' }
]);
fake.seed('tenant_users', []);
// Deliberately NO calls table — the stream must never touch telephony state.

const LOLA_REPLY = 'Right this way — what can I do for you today? I am happy to help with booking, prices, or anything else.';
const MP3_BYTES = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);

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

const { default: server, splitPhrases } = await import('../api/voice/session-ws.js');

function collector(client) {
  const all = [];
  const waiters = [];
  client.on('message', (data) => {
    let m;
    try { m = JSON.parse(String(data)); } catch (e) { return; }
    all.push(m);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(m)) {
        const w = waiters.splice(i, 1)[0];
        clearTimeout(w.t);
        w.resolve(m);
      }
    }
  });
  return {
    all,
    wait(pred, timeoutMs = 8000) {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => {
          const i = waiters.findIndex(w => w === entry);
          if (i >= 0) waiters.splice(i, 1);
          reject(new Error('timeout waiting — last messages: ' + JSON.stringify(all.slice(-6))));
        }, timeoutMs);
        const entry = { pred, resolve, t };
        const hit = all.find(pred);
        if (hit) { clearTimeout(t); resolve(hit); return; }
        waiters.push(entry);
      });
    }
  };
}

function open(port) {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}/api/voice/session-ws`);
    client.once('open', () => resolve(client));
    client.once('error', reject);
  });
}

const clients = [];

let port;
test('boot the streaming server', (t, done) => {
  server.listen(0, () => {
    port = server.address().port;
    done();
  });
});

test('rejects unauthenticated transcripts and bad tokens', async () => {
  const client = await open(port);
  clients.push(client);
  const c = collector(client);

  // Transcript before auth → explicit error, connection stays open.
  client.send(JSON.stringify({ type: 'transcript', text: 'hi' }));
  const err = await c.wait(m => m.type === 'error');
  assert.match(String(err.message), /Authenticate first/);

  // Bad token → ready { ok:false } then the server closes with 4001.
  client.send(JSON.stringify({ type: 'auth', token: 'not-a-real-token' }));
  const ready = await c.wait(m => m.type === 'ready');
  assert.equal(ready.ok, false);
  const code = await new Promise((resolve) => {
    client.once('close', (c2) => resolve(c2));
    setTimeout(() => resolve('no-close'), 4000);
  });
  assert.equal(code, 4001);
  client.terminate();
});

test('streams reply text + canonical voice audio per phrase, then done', async () => {
  process.env.ELEVENLABS_API_KEY = 'test-eleven-key';
  process.env.ELEVENLABS_VOICE_ID = 'lola-canonical-1';
  stubFetch({ telnyx: true, elevenlabs: true });

  const client = await open(port);
  clients.push(client);
  const c = collector(client);
  client.send(JSON.stringify({ type: 'auth', token: 'token-t1' }));
  await c.wait(m => m.type === 'ready' && m.ok);
  client.send(JSON.stringify({ type: 'transcript', text: 'hi', system: 'You are Lola.' }));

  const done = await c.wait(m => m.type === 'done');
  assert.equal(done.engine, 'elevenlabs');
  assert.ok(done.reply && done.reply.length > 0, 'done carries the full reply');

  const states = c.all.filter(m => m.type === 'state');
  assert.ok(states.some(s => s.state === 'thinking'), 'thinking state first');
  assert.ok(states.some(s => s.state === 'speaking'), 'speaking state before audio');

  const texts = c.all.filter(m => m.type === 'text');
  assert.ok(texts.length >= 1, 'reply streamed as phrase deltas');
  const joined = texts.map(m => m.delta).join(' ');
  assert.ok(joined.length > 0);

  const audios = c.all.filter(m => m.type === 'audio');
  assert.ok(audios.length >= 1, 'at least one audio phrase streamed');
  assert.ok(audios[audios.length - 1].final === true, 'last audio chunk marked final');
  for (const a of audios) {
    assert.ok(a.chunk && a.chunk.length > 0, 'audio chunk is base64');
    assert.ok(Buffer.from(a.chunk, 'base64').length > 0, 'audio decodes to bytes');
    assert.equal(a.mime, 'audio/mpeg');
  }
  client.close();
  delete process.env.ELEVENLABS_API_KEY;
  delete process.env.ELEVENLABS_VOICE_ID;
  globalThis.fetch = realFetch;
});

test('degrades to text-only when the voice provider is unconfigured', async () => {
  stubFetch({ telnyx: true, elevenlabs: false }); // no ELEVENLABS env
  const client = await open(port);
  clients.push(client);
  const c = collector(client);
  client.send(JSON.stringify({ type: 'auth', token: 'token-t1' }));
  await c.wait(m => m.type === 'ready' && m.ok);
  client.send(JSON.stringify({ type: 'transcript', text: 'hi' }));
  const done = await c.wait(m => m.type === 'done');
  assert.equal(done.engine, 'text');
  assert.ok(done.reply && done.reply.length > 0, 'reply still delivered without voice');
  assert.equal(c.all.filter(m => m.type === 'audio').length, 0, 'never a fake voice');
  client.close();
  globalThis.fetch = realFetch;
});

test('splitPhrases produces breath-group phrases with a cap', () => {
  const phrases = splitPhrases('Hello there. I can book you in for a blowout this Friday at two. Would that work?', 2, 40);
  assert.ok(phrases.length <= 2, 'capped at maxPhrases');
  const joined = phrases.join(' ');
  assert.ok(joined.includes('blowout') && joined.includes('Friday'));
});

test('boot cleanup', (t, done) => {
  for (const client of clients) { try { client.terminate(); } catch (e) {} }
  server.close(() => done());
});
