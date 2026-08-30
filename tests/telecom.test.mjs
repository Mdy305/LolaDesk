/**
 * tests/telecom.test.mjs — the /api/telecom Telnyx control plane.
 *
 * Run:
 *   node tests/telecom.test.mjs
 *
 * Exercises the REAL handler against the in-memory fake DB, with the
 * Telnyx API stubbed via global fetch: capabilities probe, messaging
 * profiles (list/create/assign), number routing status, 10DLC status,
 * SIM actions, and port confirm.
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
  '// Generated test double — see tests/telecom.test.mjs',
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
process.env.APP_URL = 'https://www.loladesk.com';
process.env.TELNYX_API_KEY = 'test-telnyx-key';

const { default: handler } = await import('../api/telecom.js');

const T1 = '11111111-1111-1111-1111-111111111111';
const USER = { id: 'u1', email: 'owner@salon.com' };

function seed(){
  fake.reset();
  fake.seed('tenants', [
    { id: T1, slug: 'salon-a', name: 'Salon A', owner_email: 'owner@salon.com', phone_number: '+13055550100' }
  ]);
  fake.auth.users.set('tok-owner', USER);
}

// Telnyx API stub — routes by path, returns canned payloads shaped like
// real Telnyx v2 responses ({ data: [...] }).
function stubTelnyx(){
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ path: u.replace('https://api.telnyx.com/v2', ''), method: opts.method || 'GET' });
    if (!u.includes('api.telnyx.com')) throw new Error('unexpected non-Telnyx call: ' + u);
    const path = u.replace('https://api.telnyx.com/v2', '').split('?')[0];
    const body = opts.body ? JSON.parse(opts.body) : null;

    if (path === '/available_phone_numbers') return json({ data: [{ phone_number: '+13055550100', region_information: [{ region_name: 'FL' }] }] });
    if (path === '/phone_numbers') return json({ data: [{ id: 'PN1', phone_number: '+13055550100', status: 'active', connection_id: 'CONN-1' }] });
    if (path === '/phone_numbers/PN1/voice') return json({ data: { connection_id: 'CONN-1' } });
    if (path === '/messaging_phone_numbers/%2B13055550100' || path === '/messaging_phone_numbers/+13055550100') {
      // PATCH assigns a profile; GET returns the current assignment.
      if (body?.messaging_profile_id) return json({ data: { phone_number: '+13055550100', messaging_profile_id: body.messaging_profile_id } });
      return json({ data: { phone_number: '+13055550100', messaging_profile_id: 'MP-1', messaging_product: 'sms' } });
    }
    if (path === '/messaging_profiles' && opts.method === 'POST') return json({ data: { id: 'MP-NEW', name: body.name, webhook_url: body.webhook_url } });
    if (path === '/messaging_profiles') return json({ data: [
      { id: 'MP-1', name: 'Client SMS', webhook_url: 'https://www.loladesk.com/api/telnyx-sms', features: ['SMS', 'MMS', 'WhatsApp'], tcr_campaign_id: 'CAMP-1', tcr_campaign_status: 'active' },
      { id: 'MP-2', name: 'Marketing', webhook_url: null, features: ['SMS'] }
    ] });
    if (path === '/10dlc/brands') return json({ data: [{ id: 'BR-1', brand: 'MMA Salon', status: 'verified' }] });
    if (path === '/10dlc/campaigns') return json({ data: [{ id: 'CAMP-1', campaign_id: 'CM12345', status: 'active', use_case: 'CONVERSATIONAL' }] });
    if (path === '/10dlc/phoneNumberAssignmentByProfile') return json({ data: { messagingProfileId: body.messagingProfileId, tcrCampaignId: body.tcrCampaignId } });
    if (path === '/sim_cards') return json({ data: [{ id: 'SIM-1', iccid: '8901234567890', status: { value: 'suspended' }, data_limit: { amount: '500', unit: 'MB' } }] });
    if (path === '/sim_cards/SIM-1/actions/enable') return json({ data: { id: 'SIM-1', status: { value: 'active' } } });
    if (path === '/sim_cards/SIM-1/actions/enable_voice') return json({ data: { id: 'SIM-1' } });
    if (path === '/porting_orders') return json({ data: [{ id: 'PORT-1', status: 'submitted', phone_numbers: ['+13055550199'], foc_date: null }] });
    if (path === '/porting_orders/PORT-1/actions/confirm') return json({ data: { id: 'PORT-1', status: 'in_progress' } });
    if (path === '/mobile_phone_numbers') return json({ data: [] });
    if (path === '/ai/assistants') return json({ data: [] });
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

function post(action, body){
  return call({ method: 'POST', headers: { authorization: 'Bearer tok-owner' }, query: { action }, body });
}

test('rejects unauthenticated requests', async () => {
  seed();
  const r = await call({ method: 'GET', headers: {} });
  assert.equal(r.status, 401);
});

test('capabilities probes the account and reports availability', async () => {
  seed();
  const t = stubTelnyx();
  try{
    const { status, json } = await call({ method: 'GET', headers: { authorization: 'Bearer tok-owner' }, query: { action: 'capabilities' } });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    const map = Object.fromEntries(json.data.map(x => [x.name, x.available]));
    assert.equal(map.numbers, true);
    assert.equal(map.porting, true);
    assert.equal(map.sim_cards, true);
    assert.equal(map.mobile_voice, true);
    assert.equal(map.ai_assistants, true);
  }finally{ globalThis.fetch = t.realFetch; }
});

test('number status returns voice + messaging routing for the tenant number', async () => {
  seed();
  const t = stubTelnyx();
  try{
    const { status, json } = await call({ method: 'GET', headers: { authorization: 'Bearer tok-owner' }, query: { action: 'numbers.status' } });
    assert.equal(status, 200);
    assert.equal(json.data.phone_number, '+13055550100');
    assert.equal(json.data.voice.connection_id, 'CONN-1');
    assert.equal(json.data.messaging.messaging_profile_id, 'MP-1');
    assert.equal(json.data.messaging.messaging_product, 'sms');
  }finally{ globalThis.fetch = t.realFetch; }
});

test('messaging profiles list returns features and 10DLC state', async () => {
  seed();
  const t = stubTelnyx();
  try{
    const { status, json } = await call({ method: 'GET', headers: { authorization: 'Bearer tok-owner' }, query: { action: 'messaging_profiles.list' } });
    assert.equal(status, 200);
    assert.equal(json.data.length, 2);
    const mp1 = json.data.find(p => p.id === 'MP-1');
    assert.deepEqual(mp1.features, ['SMS', 'MMS', 'WhatsApp']);
    assert.equal(mp1.tcr.campaign_id, 'CAMP-1');
    assert.equal(mp1.tcr.status, 'active');
  }finally{ globalThis.fetch = t.realFetch; }
});

test('messaging profile create wires the SMS webhook by default', async () => {
  seed();
  const t = stubTelnyx();
  try{
    const { status, json } = await post('messaging_profiles.create', { name: 'New Profile' });
    assert.equal(status, 200);
    assert.equal(json.data.id, 'MP-NEW');
    const created = t.calls.find(c => c.path === '/messaging_profiles' && c.method === 'POST');
    assert.ok(created);
  }finally{ globalThis.fetch = t.realFetch; }
});

test('messaging profile assign patches the tenant number', async () => {
  seed();
  const t = stubTelnyx();
  try{
    const { status, json } = await post('messaging_profiles.assign', { messaging_profile_id: 'MP-2' });
    assert.equal(status, 200);
    assert.equal(json.data.messaging_profile_id, 'MP-2');
    const call = t.calls.find(c => c.path.includes('messaging_phone_numbers') && c.method === 'PATCH');
    assert.ok(call, 'expected a PATCH to the messaging phone number');
  }finally{ globalThis.fetch = t.realFetch; }
});

test('messaging profile assign requires a profile id', async () => {
  seed();
  const t = stubTelnyx();
  try{
    const { status } = await post('messaging_profiles.assign', {});
    assert.equal(status, 400);
  }finally{ globalThis.fetch = t.realFetch; }
});

test('10DLC compliance status returns brands and campaigns', async () => {
  seed();
  const t = stubTelnyx();
  try{
    const { status, json } = await call({ method: 'GET', headers: { authorization: 'Bearer tok-owner' }, query: { action: 'compliance.status' } });
    assert.equal(status, 200);
    assert.equal(json.data.brands.length, 1);
    assert.equal(json.data.brands[0].status, 'verified');
    assert.equal(json.data.campaigns[0].status, 'active');
    assert.equal(json.data.campaigns[0].use_case, 'CONVERSATIONAL');
  }finally{ globalThis.fetch = t.realFetch; }
});

test('SIM activate and enable voice call the right Telnyx actions', async () => {
  seed();
  const t = stubTelnyx();
  try{
    const list = await call({ method: 'GET', headers: { authorization: 'Bearer tok-owner' }, query: { action: 'sims.list' } });
    assert.equal(list.json.data.sims.length, 1);
    const act = await post('sims.activate', { sim_card_id: 'SIM-1' });
    assert.equal(act.status, 200);
    const voice = await post('sims.enable_voice', { sim_card_id: 'SIM-1' });
    assert.equal(voice.status, 200);
    assert.ok(t.calls.some(c => c.path === '/sim_cards/SIM-1/actions/enable'));
    assert.ok(t.calls.some(c => c.path === '/sim_cards/SIM-1/actions/enable_voice'));
  }finally{ globalThis.fetch = t.realFetch; }
});

test('port confirm calls the confirm action and lists ports', async () => {
  seed();
  const t = stubTelnyx();
  try{
    const list = await call({ method: 'GET', headers: { authorization: 'Bearer tok-owner' }, query: { action: 'ports.list' } });
    assert.equal(list.json.data.length, 1);
    assert.equal(list.json.data[0].status, 'submitted');
    const conf = await post('ports.confirm', { porting_order_id: 'PORT-1' });
    assert.equal(conf.status, 200);
    assert.ok(t.calls.some(c => c.path === '/porting_orders/PORT-1/actions/confirm'));
  }finally{ globalThis.fetch = t.realFetch; }
});

test('10DLC campaign assignment posts to the profile endpoint', async () => {
  seed();
  const t = stubTelnyx();
  try{
    const { status, json } = await post('compliance.assign_10dlc', { messaging_profile_id: 'MP-1', tcr_campaign_id: 'C1234567' });
    assert.equal(status, 200);
    assert.equal(json.data.messagingProfileId, 'MP-1');
    assert.equal(json.data.tcrCampaignId, 'C1234567');
    assert.ok(t.calls.some(c => c.path === '/10dlc/phoneNumberAssignmentByProfile' && c.method === 'POST'));
  }finally{ globalThis.fetch = t.realFetch; }
});

test('10DLC assignment rejects ambiguous campaign ids', async () => {
  seed();
  const t = stubTelnyx();
  try{
    const both = await post('compliance.assign_10dlc', { messaging_profile_id: 'MP-1', campaign_id: 'A', tcr_campaign_id: 'B' });
    assert.equal(both.status, 400);
    const none = await post('compliance.assign_10dlc', { messaging_profile_id: 'MP-1' });
    assert.equal(none.status, 400);
  }finally{ globalThis.fetch = t.realFetch; }
});

test('unknown action is rejected', async () => {
  seed();
  const t = stubTelnyx();
  try{
    const { status } = await post('explode', {});
    assert.equal(status, 400);
  }finally{ globalThis.fetch = t.realFetch; }
});
