/**
 * tests/telnyx-provision.test.mjs — TeXML app resolution in telnyx-provision.
 *
 * Run:
 *   node tests/telnyx-provision.test.mjs
 *
 * Exercises getOrCreateTexmlApp() against a stubbed Telnyx API: reuse by
 * friendly_name, fresh create, and the name-collision adoption path (stale
 * 'LolaDesk' app with a different webhook → adopt + repoint instead of 500).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STUB_DIR = join(API_ROOT, 'node_modules', '@supabase', 'supabase-js');
mkdirSync(STUB_DIR, { recursive: true });
writeFileSync(join(STUB_DIR, 'package.json'), JSON.stringify({
  name: '@supabase/supabase-js', version: '0.0.0-test', type: 'module',
  main: 'index.js', exports: { '.': './index.js' }
}, null, 2));
writeFileSync(join(STUB_DIR, 'index.js'), [
  '// Generated test double — see tests/telnyx-provision.test.mjs',
  'export function createClient() {',
  "  const fake = globalThis.__LOLA_FAKE_SUPABASE__;",
  "  if (!fake) throw new Error('No fake Supabase registered');",
  '  return fake;',
  '}',
  ''
].join('\n'));

process.env.APP_URL = 'https://www.loladesk.com';
process.env.TELNYX_API_KEY = 'test-telnyx-key';
process.env.TELNYX_ORDER_SETTLE_MS = '0';

const { getOrCreateTexmlApp } = await import('../api/lib/telnyx-provision.js');

const WEBHOOK = 'https://www.loladesk.com/api/telnyx-voice';
const calls = [];

function stubTelnyx({ apps = [], appsAfterCreate = null, createError = null }) {
  let postCount = 0;
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET' });
    const u = String(url);
    if (u.includes('/texml_applications') && (!opts.method || opts.method === 'GET')) {
      // After a failed create the code re-lists; surface the stale app then.
      const data = postCount > 0 && appsAfterCreate ? appsAfterCreate : apps;
      return { ok: true, json: async () => ({ data }) };
    }
    if (u.endsWith('/texml_applications') && opts.method === 'POST') {
      postCount++;
      if (createError) return { ok: false, json: async () => ({ errors: [{ detail: createError }] }) };
      return { ok: true, json: async () => ({ data: { id: 'new-app', friendly_name: 'LolaDesk', webhook_url: WEBHOOK } }) };
    }
    if (u.includes('/texml_applications/') && opts.method === 'PATCH') {
      return { ok: true, json: async () => ({ data: { id: 'stale-app', friendly_name: 'LolaDesk', webhook_url: WEBHOOK } }) };
    }
    return { ok: true, json: async () => ({ data: {} }) };
  };
}

test('reuses an existing app matched by friendly_name (not by nonexistent .name)', async () => {
  calls.length = 0;
  stubTelnyx({ apps: [{ id: 'existing-app', friendly_name: 'LolaDesk', webhook_url: WEBHOOK }] });
  const app = await getOrCreateTexmlApp();
  assert.equal(app.id, 'existing-app');
  const posted = calls.filter(c => c.method === 'POST');
  assert.equal(posted.length, 0, 'must not create when an app already exists');
});

test('reuses a stale app (different webhook) matched by friendly_name without patching', async () => {
  calls.length = 0;
  stubTelnyx({ apps: [{ id: 'stale-app', friendly_name: 'LolaDesk', webhook_url: 'https://example.com/old' }] });
  const app = await getOrCreateTexmlApp();
  assert.equal(app.id, 'stale-app');
  assert.equal(calls.filter(c => c.method === 'POST').length, 0, 'reuse, no create');
  assert.equal(calls.filter(c => c.method === 'PATCH').length, 0, 'reuse, no patch needed');
});

test('creates a fresh app when none exists', async () => {
  calls.length = 0;
  stubTelnyx({ apps: [] });
  const app = await getOrCreateTexmlApp();
  assert.equal(app.id, 'new-app');
  const posted = calls.filter(c => c.method === 'POST');
  assert.equal(posted.length, 1, 'must create exactly once');
});

test('adopts + repoints a stale app on name-collision when the list hid it', async () => {
  calls.length = 0;
  stubTelnyx({ apps: [],
                appsAfterCreate: [{ id: 'stale-app', friendly_name: 'LolaDesk', webhook_url: 'https://example.com/old' }],
                createError: 'The name you have chosen is already in use. Please choose another name.' });
  const app = await getOrCreateTexmlApp();
  assert.equal(app.id, 'stale-app', 'must adopt the existing app on collision');
  const patched = calls.filter(c => c.method === 'PATCH');
  assert.equal(patched.length, 1, 'must repoint the adopted app webhook');
  assert.ok(calls.some(c => c.method === 'POST' && c.url.endsWith('/texml_applications')));
});

test('rethrows when a create fails for a non-collision reason', async () => {
  calls.length = 0;
  stubTelnyx({ apps: [], createError: 'Rate limit exceeded' });
  await assert.rejects(() => getOrCreateTexmlApp(), /Rate limit exceeded/);
});
