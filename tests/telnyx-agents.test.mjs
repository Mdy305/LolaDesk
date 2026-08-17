/**
 * tests/telnyx-agents.test.mjs — the /api/telnyx-agents operator tool.
 *
 * Run:
 *   node tests/telnyx-agents.test.mjs
 *
 * Exercises the REAL handler against the in-memory fake DB with the
 * Telnyx AI Assistant API stubbed via global fetch: admin gating, list
 * normalization, and provisioning the singular Lola agent.
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
  '// Generated test double — see tests/telnyx-agents.test.mjs',
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
process.env.TELNYX_API_KEY = 'test-telnyx-key';
process.env.ADMIN_EMAILS = 'boss@loladesk.com';

const { default: handler } = await import('../api/telnyx-agents.js');

function seed(){
  fake.reset();
  fake.auth.users.set('tok-admin', { id: 'u1', email: 'boss@loladesk.com' });
  fake.auth.users.set('tok-user', { id: 'u2', email: 'salon@example.com' });
}

function stubTelnyx(){
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ path: u.replace('https://api.telnyx.com/v2', '').split('?')[0], method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    if (!u.includes('api.telnyx.com')) throw new Error('unexpected non-Telnyx call: ' + u);
    const path = u.replace('https://api.telnyx.com/v2', '').split('?')[0];
    if (path === '/ai/assistants' && (opts.method || 'GET') === 'GET') {
      return json({ data: [
        { id: 'asst-1', name: 'Lola — MMA Salon', model: 'meta-llama/Llama-3.3-70B-Instruct', voice_settings: { voice: 'Polly.Joanna-Neural' }, created_at: '2026-08-17T00:00:00Z' }
      ], meta: { total: 1 } });
    }
    if (path === '/ai/assistants' && (opts.method || 'GET') === 'POST') {
      const body = opts.body ? JSON.parse(opts.body) : {};
      return json({ data: { id: 'asst-new', name: body.name } });
    }
    throw new Error('unmocked Telnyx path: ' + path);
  };
  return { realFetch, calls };
}
function json(payload){
  return {
    ok: true, status: 200,
    text: async () => JSON.stringify(payload),
    json: async () => payload
  };
}

function call(req){
  const res = {};
  res.statusCode = 200;
  res._json = null;
  res.setHeader = () => {};
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => { res._json = obj; return res; };
  res.end = () => {};
  return handler(req, res).then(() => ({ status: res.statusCode, json: res._json }));
}

test('rejects anonymous and non-admin users', async () => {
  seed();
  const t = stubTelnyx();
  try{
    const anon = await call({ method: 'GET', headers: {} });
    assert.equal(anon.status, 401);
    const user = await call({ method: 'GET', headers: { authorization: 'Bearer tok-user' } });
    assert.equal(user.status, 403);
  }finally{ globalThis.fetch = t.realFetch; }
});

test('lists assistants as a clean array with meta', async () => {
  seed();
  const t = stubTelnyx();
  try{
    const { status, json } = await call({ method: 'GET', headers: { authorization: 'Bearer tok-admin' } });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(Array.isArray(json.assistants), true);
    assert.equal(json.assistants.length, 1);
    assert.equal(json.assistants[0].name, 'Lola — MMA Salon');
    assert.equal(json.assistants[0].voice_settings.voice, 'Polly.Joanna-Neural');
    assert.equal(json.meta.total, 1);
  }finally{ globalThis.fetch = t.realFetch; }
});

test('provisions the singular Lola agent', async () => {
  seed();
  const t = stubTelnyx();
  try{
    const { status, json } = await call({ method: 'POST', headers: { authorization: 'Bearer tok-admin' }, body: {} });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.created, 1);
    assert.equal(json.results.length, 1);
    assert.ok(json.results[0].status < 400);
    const created = t.calls.find(c => c.path === '/ai/assistants' && c.method === 'POST');
    assert.ok(created, 'expected a POST to /ai/assistants');
    assert.ok(created.body.instructions.includes('Lola'), 'instructions should carry the Lola persona');
  }finally{ globalThis.fetch = t.realFetch; }
});

test('errors when TELNYX_API_KEY is missing', async () => {
  seed();
  const t = stubTelnyx();
  const saved = process.env.TELNYX_API_KEY;
  delete process.env.TELNYX_API_KEY;
  try{
    const { status, json } = await call({ method: 'GET', headers: { authorization: 'Bearer tok-admin' } });
    assert.equal(status, 500);
    assert.match(json.error, /TELNYX_API_KEY/);
  }finally{
    globalThis.fetch = t.realFetch;
    process.env.TELNYX_API_KEY = saved;
  }
});
