/**
 * tests/admin-compliance.test.mjs — the /api/admin/compliance 10DLC onboarding.
 *
 * Run:
 *   node tests/admin-compliance.test.mjs
 *
 * Exercises the REAL handler with the Telnyx API stubbed: admin gating,
 * brand registration, external vetting, campaign registration, and the
 * GET list path.
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
  '// Generated test double — see tests/admin-compliance.test.mjs',
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

const { default: handler } = await import('../api/admin/compliance.js');

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
    const body = opts.body ? JSON.parse(opts.body) : null;
    const method = opts.method || 'GET';

    if (path === '/10dlc/brand' && method === 'GET') {
      return json({ data: [{ brandId: 'B1', displayName: 'Acme Salon', entityType: 'PRIVATE_PROFIT', identityStatus: 'VERIFIED' }] });
    }
    if (path === '/10dlc/brand' && method === 'POST') {
      return json({ data: { brandId: 'B2', entityType: body.entityType, identityStatus: 'SELF_DECLARED', displayName: body.displayName } });
    }
    if (path === '/10dlc/brand/B2/externalVetting' && method === 'POST') {
      return json({ data: { brandId: 'B2', evpId: body.evpId, vettingClass: body.vettingClass, vettingStatus: 'IN_PROGRESS' } });
    }
    if (path === '/10dlc/campaignBuilder' && method === 'GET') {
      return json({ data: [{ campaignId: 'C1', brandId: 'B1', usecase: 'CUSTOMER_CARE', status: 'ACTIVE' }] });
    }
    if (path === '/10dlc/campaignBuilder' && method === 'POST') {
      return json({ data: { campaignId: 'C2', brandId: body.brandId, usecase: body.usecase, status: 'SUBMITTED' } });
    }
    throw new Error('unmocked Telnyx path: ' + method + ' ' + path);
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

const BRAND = {
  action: 'brands.create', entity_type: 'PRIVATE_PROFIT', display_name: 'Acme Salon',
  company_name: 'Acme Salon LLC', ein: '12-3456789', phone: '+15551234567',
  street: '123 Main St', city: 'Miami', state: 'FL', postal_code: '33101',
  country: 'US', email: 'admin@salon.com', website: 'https://salon.com', vertical: 'PROFESSIONAL_SERVICES'
};

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

test('lists brands and campaigns', async () => {
  seed();
  const t = stubTelnyx();
  try{
    const { status, json } = await call({ method: 'GET', headers: { authorization: 'Bearer tok-admin' } });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.brands.length, 1);
    assert.equal(json.brands[0].status, 'VERIFIED');
    assert.equal(json.campaigns.length, 1);
    assert.equal(json.campaigns[0].status, 'ACTIVE');
  }finally{ globalThis.fetch = t.realFetch; }
});

test('registers a brand with the required TCR payload', async () => {
  seed();
  const t = stubTelnyx();
  try{
    const { status, json } = await call({ method: 'POST', headers: { authorization: 'Bearer tok-admin' }, body: BRAND });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.brand_id, 'B2');
    assert.equal(json.status, 'SELF_DECLARED');
    const posted = t.calls.find(c => c.path === '/10dlc/brand' && c.method === 'POST');
    assert.equal(posted.body.ein, '12-3456789');
    assert.equal(posted.body.entityType, 'PRIVATE_PROFIT');
  }finally{ globalThis.fetch = t.realFetch; }
});

test('brand registration validates required fields and entity type', async () => {
  seed();
  const t = stubTelnyx();
  try{
    const missing = await call({ method: 'POST', headers: { authorization: 'Bearer tok-admin' }, body: { action: 'brands.create', entity_type: 'PRIVATE_PROFIT' } });
    assert.equal(missing.status, 400);
    const badEntity = await call({ method: 'POST', headers: { authorization: 'Bearer tok-admin' }, body: { ...BRAND, entity_type: 'NOT_REAL' } });
    assert.equal(badEntity.status, 400);
  }finally{ globalThis.fetch = t.realFetch; }
});

test('submits a brand for external vetting', async () => {
  seed();
  const t = stubTelnyx();
  try{
    const { status, json } = await call({ method: 'POST', headers: { authorization: 'Bearer tok-admin' }, body: { action: 'brands.vet', brand_id: 'B2', evp_id: 'AEGIS', vetting_class: 'ENHANCED' } });
    assert.equal(status, 200);
    assert.equal(json.status, 'IN_PROGRESS');
    const posted = t.calls.find(c => c.path.includes('/externalVetting'));
    assert.equal(posted.body.vettingClass, 'ENHANCED');
  }finally{ globalThis.fetch = t.realFetch; }
});

test('registers a campaign with the required payload', async () => {
  seed();
  const t = stubTelnyx();
  try{
    const body = {
      action: 'campaigns.create', brand_id: 'B1', use_case: 'CUSTOMER_CARE',
      description: 'Appointment reminders and booking follow-ups.',
      sample1: 'Hi {{name}}, your appointment is confirmed. Reply STOP to unsubscribe.',
      sample2: 'Reminder: your appointment is tomorrow. Reply STOP to opt out.',
      message_flow: 'Clients opt in at booking.',
      help_message: 'For help call +15551234567. Reply STOP to cancel.'
    };
    const { status, json } = await call({ method: 'POST', headers: { authorization: 'Bearer tok-admin' }, body });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.campaign_id, 'C2');
    const posted = t.calls.find(c => c.path === '/10dlc/campaignBuilder' && c.method === 'POST');
    assert.equal(posted.body.brandId, 'B1');
    assert.equal(posted.body.usecase, 'CUSTOMER_CARE');
    assert.equal(posted.body.embeddedLink, true);
  }finally{ globalThis.fetch = t.realFetch; }
});

test('rejects unknown actions', async () => {
  seed();
  const t = stubTelnyx();
  try{
    const { status, json } = await call({ method: 'POST', headers: { authorization: 'Bearer tok-admin' }, body: { action: 'explode' } });
    assert.equal(status, 400);
    assert.ok(json.supported);
  }finally{ globalThis.fetch = t.realFetch; }
});
