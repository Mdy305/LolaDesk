/**
 * tests/messaging-gates.test.mjs — the review-request autopilot gate.
 *
 * Run:
 *   node tests/messaging-gates.test.mjs
 *
 * Exercises the REAL review-request agent (api/lib/autopilot.js) against the
 * in-memory fake DB, with an injected `now` for deterministic windows:
 *   • a tenant with review links + a just-ended appointment gets the review
 *     SMS by default,
 *   • the same tenant never gets it when tenants.review_requests is false.
 * (The missed-call text-back gate in telnyx-voice.js is a single guarded
 * conditional; its persist path is covered by tests/settings.test.mjs.)
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
  '// Generated test double — see tests/messaging-gates.test.mjs',
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
process.env.CRON_SECRET = 'test-cron-secret';
process.env.TELNYX_API_KEY = 'test-telnyx-key';
process.env.TELNYX_VOICE_APP_ID = '2982432232334951429';
process.env.TELNYX_LOLA_BRAIN_ID = 'ASSIST-BRAIN';

const { runAutopilot } = await import('../api/lib/autopilot.js');

const NOW = new Date('2026-08-22T10:00:00Z').getTime();

// A tenant that ONLY can act on review-request: autopilot on, review links
// set, a just-ended confirmed booking. No missed calls / cancellations /
// stale syncs, so no other agent texts anyone.
function seed(reviewRequests) {
  fake.reset();
  const tenant = {
    id: 't1', slug: 'salon-a', name: 'Salon A', phone_number: '+13055550100',
    autopilot_enabled: true, recovery_sms_sent_at: null,
    yelp_review_url: 'https://www.yelp.com/biz/salon-a',
    google_review_url: 'https://g.page/r/salona/review',
    review_requests: reviewRequests
  };
  fake.seed('tenants', [tenant]);
  fake.seed('clients', [{ id: 'c1', tenant_id: 't1', phone: '+13055550110', first_name: 'Sarah', last_name: 'Kim' }]);
  // Completed appointment that ended 2h ago (inside the review window).
  fake.seed('bookings', [{
    id: 'bk1', tenant_id: 't1', client_id: 'c1', service_id: 'svc1',
    start_time: new Date(NOW - 3 * 3600 * 1000).toISOString(),
    end_time: new Date(NOW - 2 * 3600 * 1000).toISOString(),
    status: 'confirmed', created_at: new Date(NOW - 3 * 3600 * 1000).toISOString()
  }]);
  fake.seed('booking_sync_log', []);
  fake.seed('calls', []);
  fake.seed('client_memories', []);
  fake.seed('tenant_numbers', []);
  fake.seed('availability_holds', []);
  // Other agent tables that get touched.
  fake.seed('sms_10dlc_registrations', []);
}

function json(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload), json: async () => payload };
}

function stubTelnyx() {
  const realFetch = globalThis.fetch;
  const sentSms = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (!u.includes('api.telnyx.com')) throw new Error('unexpected non-Telnyx call: ' + u);
    const path = u.replace('https://api.telnyx.com/v2', '').split('?')[0];
    if (path === '/phone_numbers') return json({ data: [] });
    if (path === '/connections') return json({ data: [] });
    if (path === '/ai/assistants') return json({ data: [] });
    if (path === '/messages') { sentSms.push(JSON.parse(opts.body)); return json({ data: { id: 'msg-1' } }, 200); }
    if (path === '/calls' && opts.method === 'POST') return json({ data: { call_control_id: 'v3:cb1' } }, 200);
    throw new Error('unmocked Telnyx path: ' + path);
  };
  return { realFetch, sentSms };
}

test('review-request sends by default when the owner set review links', async () => {
  seed(undefined);
  const s = stubTelnyx();
  try {
    const result = await runAutopilot(fake, { now: NOW, agents: ['review-request'] });
    const run = result.runs[0];
    assert.equal(run.status, 'success', run.summary);
    const reviewSms = s.sentSms.filter(m => /a review means the world/.test(m.text));
    assert.equal(reviewSms.length, 1, 'expected one review-request SMS by default');
    assert.equal(reviewSms[0].to, '+13055550110');
    assert.ok(reviewSms[0].text.includes('https://www.yelp.com/biz/salon-a'));
    assert.ok(reviewSms[0].text.includes('https://g.page/r/salona/review'));
  } finally { globalThis.fetch = s.realFetch; }
});

test('review-request is skipped when tenants.review_requests is false', async () => {
  seed(false);
  const s = stubTelnyx();
  try {
    const result = await runAutopilot(fake, { now: NOW, agents: ['review-request'] });
    const run = result.runs[0];
    assert.equal(run.status, 'skipped', run.summary);
    const reviewSms = s.sentSms.filter(m => /a review means the world/.test(m.text));
    assert.equal(reviewSms.length, 0, 'review-request must be gated off');
  } finally { globalThis.fetch = s.realFetch; }
});