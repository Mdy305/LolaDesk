/**
 * tests/lola-tools.test.mjs — LolaBrain's webhook tool layer.
 *
 * Run:
 *   node tests/lola-tools.test.mjs
 *
 * Exercises the REAL /api/lola-tools handler + /api/agent-variables handler
 * against the fake DB: ?tool= dispatch, the take-message alias onto the
 * escalate skill, tenant resolution (and the hard gate on unroutable
 * numbers), and the dynamic-variables webhook carrying `to` + `from` so
 * Telnyx's preset_body_fields can forward caller context to the tools.
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
  name: '@supabase/supabase-js', version: '0.0.0-test', type: 'module', main: 'index.js', exports: { '.': './index.js' }
}, null, 2));
writeFileSync(join(STUB_DIR, 'index.js'), [
  '// Generated test double — see tests/lola-tools.test.mjs',
  'export function createClient() {',
  '  const fake = globalThis.__LOLA_FAKE_SUPABASE__;',
  "  if (!fake) throw new Error('No fake Supabase registered');",
  '  return fake;',
  '}',
  ''
].join('\n'));

const fake = new FakeSupabase();
globalThis.__LOLA_FAKE_SUPABASE__ = fake;
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'fake-service-key';
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

const { default: lolaTools } = await import('../api/lola-tools.js');
const { default: agentVariables } = await import('../api/agent-variables.js');

const TENANT = {
  id: 'tenant-live',
  slug: 'lola-live',
  name: 'Lola Live Salon',
  location: 'Miami',
  hours: '9am-6pm',
  phone_number: '+15551234567',
  services: [
    { name: 'Balayage', price: 295, duration: '2h30' },
    { name: 'Cut', price: 60, duration: '45min' }
  ]
};

function fresh(){
  fake.reset();
  fake.seed('tenants', [TENANT]);
  fake.seed('tenant_numbers', [{ tenant_id: TENANT.id, phone_number: '+15551234567', status: 'active', kind: 'primary' }]);
  fake.seed('clients', []);
  fake.seed('bookings', []);
  fake.seed('services', []);
  fake.seed('staff', []);
  fake.seed('conversations', []);
  fake.seed('messages', []);
  fake.seed('usage_events', []);
  fake.seed('availability_holds', []);
  fake.seed('booking_status_history', []);
}

function resMock(){
  const r = { statusCode: 200, body: null };
  r.setHeader = () => r;
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (j) => { r.body = j; return r; };
  r.end = () => r;
  return r;
}

async function call(handler, { query = '', body = {}, method = 'POST' }){
  const url = 'http://x/api/lola-tools' + (query ? '?' + query : '');
  const req = { method, url, query: Object.fromEntries(new URL(url).searchParams), body: JSON.stringify(body), headers: {} };
  const res = resMock();
  await handler(req, res);
  return res;
}

// ── dispatch + skills ─────────────────────────────────────────────
test('?tool=get_pricing resolves the tenant by slug and returns a real price', async () => {
  fresh();
  const res = await call(lolaTools, { query: 'tool=get_pricing', body: { tenant: 'lola-live', service: 'Balayage' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.found, true);
  assert.equal(res.body.name, 'Balayage');
  assert.equal(res.body.price, 295);
  assert.match(res.body.speak, /295/);
});

test('?tool=book_appointment without a time asks for the time and writes nothing', async () => {
  fresh();
  const res = await call(lolaTools, { query: 'tool=book_appointment', body: { tenant: 'lola-live', service: 'Balayage', client_name: 'Maya' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.booked, false);
  assert.equal(res.body.needs_time, true);
  assert.equal(fake.all('bookings').length, 0);
});

test('take-message maps onto the escalate skill with Telnyx field names', async () => {
  fresh();
  const res = await call(lolaTools, {
    query: 'tool=take-message',
    body: { tenant: 'lola-live', caller_name: 'Maya', callback_number: '+15559876543', recipient_name: 'Meddy', message_summary: 'Wants a balayage consult call back' }
  });
  assert.equal(res.statusCode, 200);
  assert.match(res.body.speak, /note for the team/i);
  const esc = fake.all('usage_events').find(e => e.kind === 'escalation');
  assert.ok(esc, 'escalation logged');
  assert.equal(esc.metadata.client_name, 'Maya');
  assert.equal(esc.metadata.client_phone, '+15559876543');
  assert.match(esc.metadata.message, /balayage consult/i);
});

test('take_message (underscore alias) dispatches too', async () => {
  fresh();
  const res = await call(lolaTools, { query: 'tool=take_message', body: { tenant: 'lola-live', message_summary: 'Call me back' } });
  assert.equal(res.statusCode, 200);
  assert.match(res.body.speak, /note for the team/i);
});

test('tool name can ride in the body (function) — Telnyx preset_body_fields style', async () => {
  fresh();
  const res = await call(lolaTools, { query: '', body: { function: 'get_pricing', tenant: 'lola-live', service: 'Cut' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.found, true);
  assert.equal(res.body.price, 60);
});

test('no tool name returns the generic help with the skill list', async () => {
  fresh();
  const res = await call(lolaTools, { body: { tenant: 'lola-live' } });
  assert.equal(res.statusCode, 200);
  assert.match(res.body.speak, /help with booking/i);
  assert.ok(Array.isArray(res.body.available_tools));
  assert.ok(res.body.available_tools.includes('book_appointment'));
});

test('unroutable dialed number hard-gates to a graceful fallback — never another tenant', async () => {
  fresh();
  const res = await call(lolaTools, { query: 'tool=get_pricing', body: { to: '+19999999999', service: 'Balayage' } });
  assert.equal(res.statusCode, 200);
  // no tenant → skill never runs against demo/other data
  assert.notEqual(res.body.found, true);
  assert.notEqual(res.body.name, 'Balayage');
});

// ── detect_upsell_opportunity (Yield Engine call-time arm) ────────
test('detect_upsell_opportunity pairs a high-margin add-on for a VIP caller', async () => {
  fresh();
  fake.seed('clients', [{ id: 'c1', tenant_id: TENANT.id, phone: '+15559876543', first_name: 'Maya', lifetime_value: 2500, is_vip: true }]);
  const res = await call(lolaTools, {
    query: 'tool=detect_upsell_opportunity',
    body: { tenant: 'lola-live', service: 'Balayage', client_phone: '+15559876543' }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.base_service, 'Balayage');
  assert.equal(res.body.tier, 'vip');
  assert.equal(res.body.client_known, true);
  // VIP tier unlocks the vip-gated add-on (Bond-Building Treatment).
  assert.ok(res.body.recommended.length >= 2, 'VIP gets the premium pairing too');
  assert.ok(res.body.recommended.some(r => r.name === 'Bond-Building Treatment'));
  assert.ok(res.body.recommended.some(r => r.name === 'Restorative Gloss'));
  assert.match(res.body.speak, /Restorative Gloss/); // speak leads with the top pairing
  assert.match(res.body.speak, /Since you're coming in for Balayage/);
  const usage = fake.all('usage_events').find(e => e.kind === 'upsell_detected');
  assert.ok(usage, 'upsell detection is logged for the Command screen');
  assert.equal(usage.metadata.tier, 'vip');
});

test('detect_upsell_opportunity gates the premium add-on away for a regular client', async () => {
  fresh();
  fake.seed('clients', [{ id: 'c2', tenant_id: TENANT.id, phone: '+15559876543', first_name: 'Maya', lifetime_value: 300, is_vip: false }]);
  const res = await call(lolaTools, {
    query: 'tool=detect_upsell_opportunity',
    body: { tenant: 'lola-live', service: 'Balayage', client_phone: '+15559876543' }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.tier, 'regular');
  assert.ok(res.body.recommended.some(r => r.name === 'Restorative Gloss'));
  assert.ok(!res.body.recommended.some(r => r.name === 'Bond-Building Treatment'), 'vip add-on stays gated for regular spend');
});

test('detect_upsell_opportunity works with explicit clientLTV (blueprint signature)', async () => {
  fresh();
  const res = await call(lolaTools, {
    query: 'tool=detect_upsell_opportunity',
    body: { tenant: 'lola-live', service: 'Cut', client_ltv: 1500 }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.tier, 'vip');
  assert.ok(res.body.recommended.some(r => r.name === 'Scalp Ritual'));
});

test('detect_upsell_opportunity still pairs without client data (tier new)', async () => {
  fresh();
  const res = await call(lolaTools, {
    query: 'tool=detect_upsell_opportunity',
    body: { tenant: 'lola-live', service: 'Balayage' }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.tier, 'new');
  assert.equal(res.body.client_known, false);
  // No client identity → only the non-gated add-on is offered.
  assert.equal(res.body.recommended.length, 1);
  assert.equal(res.body.recommended[0].name, 'Restorative Gloss');
});

test('detect_upsell_opportunity no-ops gracefully on an unknown service', async () => {
  fresh();
  const res = await call(lolaTools, {
    query: 'tool=detect_upsell_opportunity',
    body: { tenant: 'lola-live', service: 'Quantum Hair Sculpting' }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.base_service, null);
  assert.equal(res.body.reason, 'service_not_found');
  assert.deepEqual(res.body.recommended, []);
  assert.match(res.body.speak, /pair the perfect add-on/i);
  assert.equal(fake.all('usage_events').length, 0, 'no usage logged for a no-op');
});

// ── agent-variables webhook ───────────────────────────────────────
test('agent-variables resolves the tenant by dialed number and returns to + from', async () => {
  fresh();
  const req = { method: 'POST', url: 'http://x/api/agent-variables', body: JSON.stringify({ to: '+15551234567', from: '+15559876543' }), headers: {} };
  const res = resMock();
  await agentVariables(req, res);
  assert.equal(res.statusCode, 200);
  const dv = res.body.dynamic_variables;
  assert.equal(dv.tenant_id, TENANT.id);
  assert.equal(dv.to, '+15551234567');
  assert.equal(dv.from, '+15559876543');
  assert.equal(dv.company_name, 'Lola Live Salon');
  assert.match(dv.services, /Balayage/);
});

test('agent-variables on an unroutable number returns neutral placeholders, never demo data', async () => {
  fresh();
  const req = { method: 'POST', url: 'http://x/api/agent-variables', body: JSON.stringify({ to: '+19999999999', from: '+15559876543' }), headers: {} };
  const res = resMock();
  await agentVariables(req, res);
  assert.equal(res.statusCode, 200);
  const dv = res.body.dynamic_variables;
  assert.equal(dv.tenant_id, '');
  assert.equal(dv.to, '+19999999999');
  assert.equal(dv.from, '+15559876543');
  assert.equal(dv.company_name, 'our salon');
  assert.equal(dv.services, '');
});
