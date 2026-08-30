/**
 * tests/autopilot.test.mjs — /api/cron/autopilot + the four autonomous agents.
 *
 * Run:
 *   node tests/autopilot.test.mjs
 *
 * Exercises the REAL handler against the in-memory fake DB with Telnyx
 * stubbed via global fetch: CRON_SECRET gating, a full run of all seven
 * agents (routing-heal reconciles a rejected-legacy row, missed-call-recovery
 * texts a caller who rang without booking, rebooking invites a cancelled
 * client back, sync-self-heal re-runs an erroring sync, proactive-outreach
 * no-ops on the schedule-less seed), and the agent_runs ledger.
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
  '// Generated test double — see tests/autopilot.test.mjs',
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
process.env.CRON_SECRET = 'test-cron-secret';
process.env.TELNYX_API_KEY = 'test-telnyx-key';
process.env.TELNYX_VOICE_APP_ID = '2982432232334951429';
process.env.TELNYX_LOLA_BRAIN_ID = 'ASSIST-BRAIN';

const { default: handler } = await import('../api/cron/autopilot.js');

const NOW = new Date('2026-08-22T10:00:00Z').getTime();

function seed() {
  fake.reset();
  fake.seed('tenants', [
    { id: 't1', slug: 'salon-a', name: 'Salon A', phone_number: '+13055550100', autopilot_enabled: true, recovery_sms_sent_at: null, yelp_review_url: 'https://www.yelp.com/biz/salon-a', google_review_url: 'https://g.page/r/salona/review' },
    // t2 has autopilot paused — per-tenant agents must leave it alone.
    { id: 't2', slug: 'salon-b', name: 'Salon B', phone_number: '+13055550101', autopilot_enabled: false, recovery_sms_sent_at: null, yelp_review_url: null, google_review_url: null }
  ]);
  fake.seed('tenant_numbers', [
    // tn1 is stale — recorded the rejected legacy id, Telnyx says LolaBrain.
    { id: 'tn1', tenant_id: 't1', phone_number: '+13055550100', kind: 'primary', status: 'active', connection_id: '2991758319724529273', tenants: { name: 'Salon A', slug: 'salon-a' } }
  ]);
  fake.seed('clients', [
    { id: 'c1', tenant_id: 't1', phone: '+13055550110', first_name: 'Sarah', last_name: 'Kim' },
    { id: 'c2', tenant_id: 't1', phone: '+13055550111', first_name: 'Marco', last_name: 'Rez' }
  ]);
  fake.seed('calls', [
    // Missed inbound call ~3h ago — no duration, no status, no booking after it.
    { id: 'call1', tenant_id: 't1', client_id: 'c1', from_number: '+13055550110', to_number: '+13055550100', direction: 'inbound', status: null, duration_seconds: null, created_at: new Date(NOW - 3 * 3600 * 1000).toISOString() },
    // Answered call — must NOT be recovered.
    { id: 'call2', tenant_id: 't1', client_id: 'c2', from_number: '+13055550111', to_number: '+13055550100', direction: 'inbound', status: 'completed', duration_seconds: 180, created_at: new Date(NOW - 2 * 3600 * 1000).toISOString() },
    // Missed call for the paused tenant — must NOT be recovered.
    { id: 'call3', tenant_id: 't2', client_id: null, from_number: '+13055550120', to_number: '+13055550101', direction: 'inbound', status: null, duration_seconds: null, created_at: new Date(NOW - 1 * 3600 * 1000).toISOString() }
  ]);
  fake.seed('bookings', [
    // Cancelled 2 days ago for c2 (answered call — not a recovery target, but rebooking applies).
    { id: 'bk1', tenant_id: 't1', client_id: 'c2', start_time: new Date(NOW - 2 * 86400000).toISOString(), status: 'cancelled', service: 'Balayage', created_at: new Date(NOW - 2 * 86400000).toISOString() },
    // Confirmed future booking for c1 — they already have one, rebooking must not double-text.
    { id: 'bk2', tenant_id: 't1', client_id: 'c1', start_time: new Date(NOW + 3 * 86400000).toISOString(), status: 'confirmed', created_at: new Date(NOW - 86400000).toISOString() },
    // Completed appointment for c2 that ended 2h ago — review-request must text them.
    { id: 'bk3', tenant_id: 't1', client_id: 'c2', start_time: new Date(NOW - 3 * 3600 * 1000).toISOString(), end_time: new Date(NOW - 2 * 3600 * 1000).toISOString(), status: 'confirmed', service: 'Balayage', created_at: new Date(NOW - 3 * 3600 * 1000).toISOString() }
  ]);
  fake.seed('booking_sync_log', [
    // t1's latest sync errored — sync-self-heal must re-run it.
    { id: 'log1', tenant_id: 't1', provider: 'square', kind: 'availability', error_message: '{"provider":"square","error":"401 expired token"}', created_at: new Date(NOW - 2 * 3600 * 1000).toISOString() }
  ]);
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
    if (path === '/phone_numbers') return json({ data: [
      { id: 'PN1', phone_number: '+13055550100', status: 'active', connection_id: 'ASSIST-BRAIN' }
    ] });
    if (path === '/connections') return json({ data: [
      { id: '2982432232334951429', connection_name: 'LolaDesk' }
    ] });
    if (path === '/ai/assistants') return json({ data: [
      { id: 'ASSIST-BRAIN', name: 'LolaBrain' }
    ] });
    if (path === '/messages') {
      sentSms.push(JSON.parse(opts.body));
      return json({ data: { id: 'msg-1' } }, 200);
    }
    if (path === '/calls' && opts.method === 'POST') {
      return json({ data: { call_control_id: 'v3:ap-cb1', id: 'v3:ap-cb1' } }, 200);
    }
    throw new Error('unmocked Telnyx path: ' + path);
  };
  return { realFetch, sentSms };
}

function call(req) {
  const res = {};
  res.statusCode = 200;
  res._json = null;
  res.setHeader = () => {};
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => { res._json = obj; return res; };
  res.end = () => {};
  return handler(req, res).then(() => ({ status: res.statusCode, json: res._json }));
}

test('disabled without CRON_SECRET, rejects wrong secret', async () => {
  seed();
  const t = stubTelnyx();
  try {
    delete process.env.CRON_SECRET;
    const disabled = await call({ method: 'GET', headers: { authorization: 'Bearer anything' } });
    assert.equal(disabled.status, 503);
    process.env.CRON_SECRET = 'test-cron-secret';
    const wrong = await call({ method: 'GET', headers: { authorization: 'Bearer nope' } });
    assert.equal(wrong.status, 401);
  } finally { globalThis.fetch = t.realFetch; }
});

test('full run: all seven agents act, ledger rows written, opt-outs respected', async () => {
  seed();
  const t = stubTelnyx();
  try {
    // Force the lib's internal clock: the cron uses Date.now(), so run the
    // shared runAutopilot directly with an injected `now` for deterministic
    // windows, but still go through the cron handler once for the gating path.
    const { runAutopilot } = await import('../api/lib/autopilot.js');
    const result = await runAutopilot(fake, { now: NOW });
    assert.equal(result.ok, true);
    const byAgent = Object.fromEntries(result.runs.map(r => [r.agent, r]));

    // 1 · routing-heal reconciled the rejected-legacy row to LolaBrain.
    assert.equal(byAgent['routing-heal'].status, 'success');
    assert.equal(fake.all('tenant_numbers')[0].connection_id, 'ASSIST-BRAIN');

    // 2 · missed-call-recovery texted the missed caller (c1) but NOT the
    // answered call (c2) and NOT the paused tenant's caller.
    assert.equal(byAgent['missed-call-recovery'].status, 'success');
    const sms = t.sentSms.filter(m => !m.text.includes('didn\'t go through') && !m.text.includes('Yelp:'));
    assert.equal(sms.length, 1);
    assert.equal(sms[0].to, '+13055550110');
    assert.ok(sms[0].text.includes('missed your call'));
    // Cooldown stamp set on t1.
    assert.ok(fake.all('tenants').find(x => x.id === 't1').recovery_sms_sent_at);
    assert.equal(fake.all('tenants').find(x => x.id === 't2').recovery_sms_sent_at, null);

    // 3 · rebooking invited the cancelled client (c2) back; c1 already has a
    // future booking so no rebook text for them.
    assert.equal(byAgent.rebooking.status, 'success');
    const rebook = t.sentSms.filter(m => m.text.includes('didn\'t go through'));
    assert.equal(rebook.length, 1);
    assert.equal(rebook[0].to, '+13055550111');
    assert.ok(rebook[0].text.includes('Balayage'));

    // 4 · sync-self-heal re-ran t1's erroring sync.
    assert.equal(byAgent['sync-self-heal'].status, 'success');
    assert.ok(byAgent['sync-self-heal'].actions >= 1);
    // Ledger holds the detail (which tenant was healed).
    const healLedger = fake.all('agent_runs').find(r => r.agent === 'sync-self-heal');
    assert.ok(healLedger.details.actions[0].tenant_id === 't1');

    // 5 · review-request texted the client whose appointment just ended.
    assert.equal(byAgent['review-request'].status, 'success');
    const review = t.sentSms.filter(m => m.text.includes('Yelp:'));
    assert.equal(review.length, 1);
    assert.equal(review[0].to, '+13055550111');
    assert.ok(review[0].text.includes('https://www.yelp.com/biz/salon-a'));
    assert.ok(review[0].text.includes('https://g.page/r/salona/review'));

    // 6 · callback-recovery called back the missed caller (call1) from the
    // salon line, but never the answered call (call2) or the paused tenant.
    assert.equal(byAgent['callback-recovery'].status, 'success');
    assert.equal(byAgent['callback-recovery'].actions, 1);

    // 7 · proactive-outreach: t1 has no staff_schedules seeded, so the yield
    // engine records a per-tenant skip and sends nothing (partial, 0 SMS).
    assert.equal(byAgent['proactive-outreach'].status, 'partial');
    assert.equal(byAgent['proactive-outreach'].actions, 1);
    assert.equal(byAgent['proactive-outreach'].summary.includes('No proactive offers sent'), true);

    // Ledger: 7 rows, one per agent, none failed.
    const runs = fake.all('agent_runs');
    assert.equal(runs.length, 7);
    for (const a of ['routing-heal', 'missed-call-recovery', 'rebooking', 'sync-self-heal', 'review-request', 'callback-recovery', 'proactive-outreach']) {
      const row = runs.find(r => r.agent === a);
      assert.ok(row, `ledger row for ${a}`);
      assert.notEqual(row.status, 'failed');
    }
  } finally { globalThis.fetch = t.realFetch; }
});

test('runAutopilot tolerates a failing agent and still logs it as failed', async () => {
  seed();
  const t = stubTelnyx();
  try {
    // Break Telnyx so routing-heal fails; the other agents must still run.
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (!u.includes('api.telnyx.com')) throw new Error('unexpected');
      const path = u.replace('https://api.telnyx.com/v2', '').split('?')[0];
      if (path === '/messages') return json({ data: { id: 'm' } });
      return json({ errors: [{ detail: 'forbidden' }] }, 403);
    };
    const { runAutopilot } = await import('../api/lib/autopilot.js');
    const result = await runAutopilot(fake, { now: NOW, agents: ['routing-heal', 'sync-self-heal'] });
    assert.equal(result.ok, true);
    const byAgent = Object.fromEntries(result.runs.map(r => [r.agent, r]));
    assert.equal(byAgent['routing-heal'].status, 'failed');
    assert.equal(byAgent['sync-self-heal'].status, 'success');
    const runs = fake.all('agent_runs');
    assert.equal(runs.length, 2);
    assert.equal(runs.find(r => r.agent === 'routing-heal').status, 'failed');
  } finally { globalThis.fetch = t.realFetch; }
});
