/**
 * tests/yield-engine.test.mjs — the proactive-outreach (yield engine) agent.
 *
 * Run:
 *   node tests/yield-engine.test.mjs
 *
 * Exercises the REAL proactive-outreach agent (api/lib/autopilot.js) against
 * the in-memory fake DB with Telnyx stubbed via global fetch, with an
 * injected `now` for deterministic windows:
 *   • a tenant with open schedule gaps + a client due for service (last
 *     visit > 6 weeks ago, no upcoming booking, phone on file) gets one
 *     offer SMS for the earliest gap,
 *   • clients who visited recently, opted out, or already have an upcoming
 *     booking are never texted,
 *   • the same client is never offered twice within the cooldown window,
 *   • the run is recorded in the agent_runs ledger.
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
  '// Generated test double — see tests/yield-engine.test.mjs',
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
process.env.TELNYX_VOICE_APP_ID = '2982432232334951429';
process.env.TELNYX_LOLA_BRAIN_ID = 'ASSIST-BRAIN';

const { runAutopilot } = await import('../api/lib/autopilot.js');

// 2026-08-22T10:00:00Z — a Saturday morning in America/New_York (06:00 EDT).
const NOW = new Date('2026-08-22T10:00:00Z').getTime();
const DAY = 86400000;

// s1 works every weekday 09:00–17:00 local. Seeding all 7 days makes the
// test independent of the weekday of NOW. t2 is DISABLED by default so the
// base tests see exactly one enabled tenant; enableT2 flips it on for the
// multi-tenant test, and paused:true is used for the gate test.
function seed({ paused = false, enableT2 = false } = {}) {
  fake.reset();
  fake.seed('tenants', [
    { id: 't1', slug: 'salon-a', name: 'Salon A', phone_number: '+13055550100', autopilot_enabled: true, recovery_sms_sent_at: null },
    { id: 't2', slug: 'salon-b', name: 'Salon B', phone_number: '+13055550101', autopilot_enabled: enableT2 && !paused, recovery_sms_sent_at: null }
  ]);
  fake.seed('staff', [
    { id: 's1', tenant_id: 't1', name: 'Meddy', is_active: true },
    { id: 's2', tenant_id: 't2', name: 'Rita', is_active: true }
  ]);
  const schedules = [];
  for (let dow = 0; dow < 7; dow++) {
    schedules.push({ id: `sch1-${dow}`, tenant_id: 't1', staff_id: 's1', day_of_week: dow, start_time: '09:00:00', end_time: '17:00:00' });
    if (enableT2) schedules.push({ id: `sch2-${dow}`, tenant_id: 't2', staff_id: 's2', day_of_week: dow, start_time: '09:00:00', end_time: '17:00:00' });
  }
  fake.seed('staff_schedules', schedules);
  fake.seed('clients', [
    // c1 — due (visited 60d ago), phone on file, no upcoming booking → target.
    { id: 'c1', tenant_id: 't1', phone: '+13055550110', first_name: 'Sarah', last_name: 'Kim', opted_out: false },
    // c2 — visited 10d ago → not due yet.
    { id: 'c2', tenant_id: 't1', phone: '+13055550111', first_name: 'Marco', last_name: 'Rez', opted_out: false },
    // c3 — due but opted out → never texted.
    { id: 'c3', tenant_id: 't1', phone: '+13055550112', first_name: 'Dana', last_name: 'Cole', opted_out: true },
    // c4 — due but already has an upcoming booking → never texted.
    { id: 'c4', tenant_id: 't1', phone: '+13055550113', first_name: 'Eli', last_name: 'Fox', opted_out: false },
    // c5 — due client at the PAUSED tenant → never texted.
    { id: 'c5', tenant_id: 't2', phone: '+13055550120', first_name: 'Nina', last_name: 'Rae', opted_out: false }
  ]);
  fake.seed('bookings', [
    // Past confirmed visits for the due math (only end_time matters).
    { id: 'bk1', tenant_id: 't1', client_id: 'c1', staff_id: 's1', start_time: new Date(NOW - 60 * DAY).toISOString(), end_time: new Date(NOW - 60 * DAY + 3600 * 1000).toISOString(), status: 'confirmed' },
    { id: 'bk2', tenant_id: 't1', client_id: 'c2', staff_id: 's1', start_time: new Date(NOW - 10 * DAY).toISOString(), end_time: new Date(NOW - 10 * DAY + 3600 * 1000).toISOString(), status: 'confirmed' },
    { id: 'bk3', tenant_id: 't1', client_id: 'c3', staff_id: 's1', start_time: new Date(NOW - 70 * DAY).toISOString(), end_time: new Date(NOW - 70 * DAY + 3600 * 1000).toISOString(), status: 'confirmed' },
    { id: 'bk4', tenant_id: 't1', client_id: 'c4', staff_id: 's1', start_time: new Date(NOW - 50 * DAY).toISOString(), end_time: new Date(NOW - 50 * DAY + 3600 * 1000).toISOString(), status: 'confirmed' },
    { id: 'bk5', tenant_id: 't2', client_id: 'c5', staff_id: 's2', start_time: new Date(NOW - 65 * DAY).toISOString(), end_time: new Date(NOW - 65 * DAY + 3600 * 1000).toISOString(), status: 'confirmed' },
    // c4 already has an upcoming confirmed booking → excluded. Kept at
    // NOW + 2d so it is still "future" on the cooldown re-run (NOW + 1d).
    { id: 'bk6', tenant_id: 't1', client_id: 'c4', staff_id: 's1', start_time: new Date(NOW + 2 * DAY).toISOString(), end_time: new Date(NOW + 2 * DAY + 3600 * 1000).toISOString(), status: 'confirmed' }
  ]);
  fake.seed('client_memories', []);
  fake.seed('tenant_numbers', []);
  fake.seed('availability_holds', []);
  fake.seed('agent_runs', []);
  fake.seed('usage_events', []);
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

test('yield engine texts exactly the due, contactable client with the earliest open gap', async () => {
  seed();
  const s = stubTelnyx();
  try {
    const result = await runAutopilot(fake, { now: NOW, agents: ['proactive-outreach'] });
    const run = result.runs[0];
    assert.equal(run.status, 'success', run.summary);

    // One SMS, only to Sarah (due, contactable, no upcoming booking).
    assert.equal(s.sentSms.length, 1, 'expected exactly one yield offer SMS');
    assert.equal(s.sentSms[0].to, '+13055550110');
    assert.ok(s.sentSms[0].text.includes('Salon A'));
    assert.ok(s.sentSms[0].text.includes('Sarah'));
    assert.ok(/opening/.test(s.sentSms[0].text));
    assert.ok(/with Meddy/.test(s.sentSms[0].text), 'offer names the staff member for the gap');

    // Cooldown memory key recorded for c1.
    const mem = fake.all('client_memories').filter(m => String(m.key || '').startsWith('yield:'));
    assert.equal(mem.length, 1);
    assert.equal(mem[0].key, 'yield:c1');

    // Ledger row written with the send detail.
    const ledger = fake.all('agent_runs').find(r => r.agent === 'proactive-outreach');
    assert.ok(ledger, 'ledger row for proactive-outreach');
    assert.equal(ledger.status, 'success');
    assert.ok(ledger.details.actions[0].slot, 'action records the offered slot');
  } finally { globalThis.fetch = s.realFetch; }
});

test('yield engine respects cooldown: same client is not offered twice within a week', async () => {
  seed();
  const s = stubTelnyx();
  try {
    await runAutopilot(fake, { now: NOW, agents: ['proactive-outreach'] });
    assert.equal(s.sentSms.length, 1);
    // Re-run 1 day later (same week window): c1 already offered → no new SMS.
    await runAutopilot(fake, { now: NOW + DAY, agents: ['proactive-outreach'] });
    assert.equal(s.sentSms.length, 1, 'cooldown must suppress a second offer to the same client');
  } finally { globalThis.fetch = s.realFetch; }
});

test('yield engine re-offers the same client after the cooldown window passes', async () => {
  seed();
  const s = stubTelnyx();
  try {
    await runAutopilot(fake, { now: NOW, agents: ['proactive-outreach'] });
    assert.equal(s.sentSms.length, 1);
    // 8 days later (cooldown is 7 days): the client may be offered again.
    await runAutopilot(fake, { now: NOW + 8 * DAY, agents: ['proactive-outreach'] });
    assert.equal(s.sentSms.length, 2, 'cooldown elapsed, so the same client can be re-offered');
  } finally { globalThis.fetch = s.realFetch; }
});

test('yield engine works per tenant: both enabled tenants get offers', async () => {
  seed({ enableT2: true });
  const s = stubTelnyx();
  try {
    const result = await runAutopilot(fake, { now: NOW, agents: ['proactive-outreach'] });
    const run = result.runs[0];
    assert.equal(run.status, 'success', run.summary);
    assert.equal(s.sentSms.length, 2, 'one offer per enabled tenant with a due client');
    assert.deepEqual(s.sentSms.map(m => m.to).sort(), ['+13055550110', '+13055550120']);
  } finally { globalThis.fetch = s.realFetch; }
});

test('yield engine skips a paused tenant entirely', async () => {
  seed({ enableT2: true, paused: true });
  const s = stubTelnyx();
  try {
    const result = await runAutopilot(fake, { now: NOW, agents: ['proactive-outreach'] });
    const run = result.runs[0];
    assert.equal(run.status, 'success', run.summary);
    assert.equal(s.sentSms.length, 1, 'only the enabled tenant is offered');
    assert.equal(s.sentSms[0].to, '+13055550110');
  } finally { globalThis.fetch = s.realFetch; }
});

test('yield engine no-ops cleanly when there are no open gaps', async () => {
  seed();
  // Delete every schedule so no gap can be computed.
  fake.seed('staff_schedules', []);
  const s = stubTelnyx();
  try {
    const result = await runAutopilot(fake, { now: NOW, agents: ['proactive-outreach'] });
    const run = result.runs[0];
    assert.equal(run.status, 'partial', run.summary); // per-tenant skip recorded, nothing sent
    assert.equal(s.sentSms.length, 0);
    assert.ok(run.summary.includes('No proactive offers sent'));
  } finally { globalThis.fetch = s.realFetch; }
});
