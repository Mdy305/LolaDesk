/**
 * tests/widget-chat.test.mjs — the embeddable chat widget's booking handoff.
 *
 * Run: node tests/widget-chat.test.mjs
 *
 * The widget must ALWAYS land a visitor on a working booking flow: the
 * salon's own booking_url when set, otherwise LolaDesk's hosted booking page
 * for that salon (book?t=slug). A tenant with a null booking_url previously
 * broke the chat→booking loop — the widget would only offer to "leave a
 * number" instead of linking the working page.
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
  '// Generated test double — see tests/widget-chat.test.mjs',
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
process.env.APP_URL = 'https://www.loladesk.com';
process.env.WIDGET_EMBED_SECRET = 'test-secret';

// widgetKeyFor derives a key from slug + secret — replicate the same call.
const { widgetKeyFor } = await import('../api/widget-chat.js');
const { default: handler } = await import('../api/widget-chat.js');

function call(req){
  const res = {};
  res.statusCode = 200; res._json = null;
  res.setHeader = () => {};
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => { res._json = obj; return res; };
  res.end = () => {};
  return handler(req, res).then(() => ({ status: res.statusCode, json: res._json }));
}

test('GET config hands off to the salon booking_url when set', async () => {
  fake.reset();
  fake.seed('tenants', [{ id: 't1', slug: 'salon-a', name: 'Salon A', booking_url: 'https://salona.example/book' }]);
  const key = widgetKeyFor('salon-a');
  const res = await call({ method: 'GET', url: `/api/widget-chat?slug=salon-a&key=${key}`, headers: {}, body: {} });
  assert.equal(res.status, 200);
  assert.equal(res.json.booking_url, 'https://salona.example/book');
});

test('GET config falls back to LolaDesk hosted booking page when booking_url is null', async () => {
  fake.reset();
  fake.seed('tenants', [{ id: 't2', slug: 'salon-b', name: 'Salon B', booking_url: null }]);
  const key = widgetKeyFor('salon-b');
  const res = await call({ method: 'GET', url: `/api/widget-chat?slug=salon-b&key=${key}`, headers: {}, body: {} });
  assert.equal(res.status, 200);
  assert.equal(res.json.booking_url, 'https://www.loladesk.com/book?t=salon-b');
});

test('chat reply links the hosted booking page for a tenant without booking_url', async () => {
  fake.reset();
  fake.seed('tenants', [{ id: 't3', slug: 'salon-c', name: 'Salon C', booking_url: null, services: [] }]);
  const key = widgetKeyFor('salon-c');
  // Stub the LLM to force the deterministic fallback (no network).
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });
  try{
    const res = await call({
      method: 'POST',
      url: '/api/widget-chat',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'salon-c', key, visitor_id: 'v1', message: 'I want to book an appointment' })
    });
    assert.equal(res.status, 200);
    assert.ok(res.json.reply.includes('https://www.loladesk.com/book?t=salon-c'), res.json.reply);
  } finally { globalThis.fetch = realFetch; }
});

test('invalid widget key is rejected', async () => {
  fake.reset();
  fake.seed('tenants', [{ id: 't4', slug: 'salon-d', name: 'Salon D', booking_url: null }]);
  const res = await call({ method: 'GET', url: '/api/widget-chat?slug=salon-d&key=WRONG', headers: {}, body: {} });
  assert.equal(res.status, 401);
});
