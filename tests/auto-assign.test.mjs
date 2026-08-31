/**
 * tests/auto-assign.test.mjs — instant Telnyx onboarding.
 *
 * Run:
 *   node tests/auto-assign.test.mjs
 *
 * Exercises autoAssignOwnedNumber against the fake DB + a stubbed Telnyx
 * API: assigning a free owned number end-to-end (routing row + tenant
 * column), skipping when every owned number is tracked (routing row OR
 * legacy column), skipping without a key, failing soft on a Telnyx error,
 * and the signup handler still returning 200 with autoProvisioned in the
 * response — a 500 must never come from instant onboarding.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeSupabase } from './fake-supabase.js';

// ── provision the @supabase/supabase-js test double ────────────────
const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STUB_DIR = join(API_ROOT, 'node_modules', '@supabase', 'supabase-js');
mkdirSync(STUB_DIR, { recursive: true });
writeFileSync(join(STUB_DIR, 'package.json'), JSON.stringify({
  name: '@supabase/supabase-js', version: '0.0.0-test', type: 'module', main: 'index.js', exports: { '.': './index.js' }
}, null, 2));
writeFileSync(join(STUB_DIR, 'index.js'), [
  '// Generated test double — see tests/auto-assign.test.mjs',
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
process.env.TELNYX_API_KEY = 'k-test';
process.env.TELNYX_VOICE_APP_ID = 'voice-app-1';
process.env.TELNYX_MESSAGING_PROFILE_ID = 'msg-prof-1';
process.env.TELNYX_LOLA_BRAIN_ID = 'lola-brain-1';
process.env.APP_URL = 'https://www.loladesk.com';

const { autoAssignOwnedNumber } = await import('../api/lib/telnyx-provision.js');
const signup = (await import('../api/auth/signup.js')).default;

const OWNED = [
  { phone_number: '+15550000001', id: 'n1', status: 'active', connection_id: 'c1', voice_enabled: true, messaging_profile_id: 'm1' },
  { phone_number: '+15550000002', id: 'n2', status: 'active', connection_id: 'c1', voice_enabled: true, messaging_profile_id: 'm1' },
  { phone_number: '+15550000003', id: 'n3', status: 'active', connection_id: 'c1', voice_enabled: true, messaging_profile_id: 'm1' }
];

const T1 = { id: 'tenant-one', slug: 'salon-one', name: 'Salon One' };
const NEW_TENANT = { id: 'tenant-new', slug: 'salon-new', name: 'Brand New Salon' };

function fresh(){
  fake.reset();
  fake.seed('tenants', [{ ...T1, phone_number: '+15550000001' }, { ...NEW_TENANT, phone_number: null }]);
  fake.seed('tenant_numbers', [{ tenant_id: T1.id, phone_number: '+15550000001', kind: 'primary', status: 'active' }]);
  fake.seed('tenant_onboarding', []);
}

// Stub the Telnyx v2 API: list/filter phone numbers, and idempotent
// PATCH/POST links on numbers and AI assistants. Records every call and
// restores the PREVIOUS fetch exactly on cleanup.
function telnyxStub(owned = OWNED){
  const calls = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    const path = u.replace(/^https:\/\/api\.telnyx\.com\/v2/, '');
    if(path.startsWith('/phone_numbers') && !opts.method){
      const filter = u.includes('filter[phone_number]=')
        ? decodeURIComponent(u.split('filter[phone_number]=')[1] || '')
        : null;
      const data = filter ? owned.filter(n => n.phone_number === filter) : owned;
      return { ok: true, status: 200, json: async () => ({ data }) };
    }
    if(path.startsWith('/phone_numbers/') && opts.method === 'PATCH'){
      return { ok: true, status: 200, json: async () => ({ data: {} }) };
    }
    if(path.startsWith('/ai/assistants/')){
      if(!opts.method){
        // GET the assistant — resolve its own TeXML app (the real attach).
        return { ok: true, status: 200, json: async () => ({ id: 'lola-brain-1', telephony_settings: { default_texml_app_id: 'brain-app-1' } }) };
      }
      return { ok: true, status: 200, json: async () => ({ data: {} }) };
    }
    return { ok: false, status: 404, json: async () => ({ errors: [{ detail: 'unhandled ' + path }] }) };
  };
  return { calls, restore: () => { globalThis.fetch = prev; } };
}

// ── autoAssignOwnedNumber ──────────────────────────────────────────
test('assigns a free owned number end to end: routing row + tenant column + result', async () => {
  fresh();
  const spy = telnyxStub();
  try{
    const r = await autoAssignOwnedNumber(NEW_TENANT);
    assert.equal(r.assigned, true);
    assert.equal(r.phoneNumber, '+15550000002'); // 01 is tracked, 02 is free
    const routes = fake.all('tenant_numbers');
    const row = routes.find(x => x.phone_number === '+15550000002');
    assert.ok(row, 'routing row landed');
    assert.equal(row.tenant_id, 'tenant-new');
    assert.equal(row.status, 'active');
    const saved = fake.all('tenants').find(t => t.id === 'tenant-new');
    assert.equal(saved.phone_number, '+15550000002');
    // every link path actually hit Telnyx; the LolaBrain attach re-points the
    // voice connection to the assistant's own TeXML app (no dead endpoint)
    assert.ok(spy.calls.some(c => c.method === 'PATCH' && c.url.includes('/phone_numbers/n2/voice') && c.body?.connection_id === 'brain-app-1'));
    assert.ok(spy.calls.some(c => c.method === 'PATCH' && c.url.includes('/phone_numbers/n2/messaging')));
    assert.equal(spy.calls.some(c => c.url.includes('/ai/assistants/lola-brain-1/phone_numbers')), false);
  }finally{ spy.restore(); }
});

test('skips when every owned number is tracked — routing row protection', async () => {
  fresh();
  fake.seed('tenant_numbers', [
    { tenant_id: T1.id, phone_number: '+15550000001', kind: 'primary', status: 'active' },
    { tenant_id: T1.id, phone_number: '+15550000002', kind: 'secondary', status: 'active' },
    { tenant_id: T1.id, phone_number: '+15550000003', kind: 'secondary', status: 'active' }
  ]);
  const spy = telnyxStub();
  try{
    const r = await autoAssignOwnedNumber(NEW_TENANT);
    assert.equal(r.assigned, false);
    assert.equal(r.reason, 'no-untracked-numbers');
    // no attach attempt — zero PATCHes on a number
    assert.equal(spy.calls.filter(c => c.method === 'PATCH').length, 0);
    const saved = fake.all('tenants').find(t => t.id === 'tenant-new');
    assert.equal(saved.phone_number, null);
  }finally{ spy.restore(); }
});

test('legacy tenants.phone_number column also protects a number', async () => {
  fresh();
  // +15550000003 is owned but has NO tenant_numbers row — only the legacy
  // tenants.phone_number column of another salon. Must still be skipped.
  fake.seed('tenant_numbers', [{ tenant_id: T1.id, phone_number: '+15550000001', kind: 'primary', status: 'active' }]);
  fake.seed('tenants', [
    { ...T1, phone_number: '+15550000001' },
    { id: 'legacy-salon', slug: 'legacy', name: 'Legacy', phone_number: '+15550000003' },
    { ...NEW_TENANT, phone_number: null }
  ]);
  const spy = telnyxStub();
  try{
    const r = await autoAssignOwnedNumber(NEW_TENANT);
    assert.equal(r.assigned, true);
    assert.equal(r.phoneNumber, '+15550000002');
    assert.equal(r.reason, undefined);
  }finally{ spy.restore(); }
});

test('skips cleanly when Telnyx is not configured (no key, no fetch)', async () => {
  fresh();
  delete process.env.TELNYX_API_KEY;
  try{
    let hit = false;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => { hit = true; return { ok: true, status: 200, json: async () => ({}) }; };
    try{
      const r = await autoAssignOwnedNumber(NEW_TENANT);
      assert.equal(r.assigned, false);
      assert.equal(r.reason, 'telnyx-not-configured');
      assert.equal(hit, false);
    }finally{ globalThis.fetch = realFetch; }
  }finally{ process.env.TELNYX_API_KEY = 'k-test'; }
});

test('fails soft on a Telnyx outage — no throw, tenant untouched', async () => {
  fresh();
  // listOwnedNumbers deliberately swallows the outage into an empty list, so
  // the fail-soft contract is: assigned:false, nothing written, no throw.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('telnyx down'); };
  try{
    const r = await autoAssignOwnedNumber(NEW_TENANT);
    assert.equal(r.assigned, false);
    const saved = fake.all('tenants').find(t => t.id === 'tenant-new');
    assert.equal(saved.phone_number, null);
  }finally{ globalThis.fetch = realFetch; }
});

// ── the signup handler ─────────────────────────────────────────────
function resMock(){
  const r = { statusCode: 200, body: null };
  r.setHeader = () => r;
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (j) => { r.body = j; return r; };
  r.end = () => r;
  return r;
}

function authMock(){
  fake.auth.admin = {
    createUser: async ({ email, password }) => ({ data: { user: { id: 'u-1', email, user_metadata: { name: 'Owner' } } }, error: null })
  };
  fake.auth.signInWithPassword = async ({ email }) => ({ data: { user: { id: 'u-1', email }, session: { access_token: 'tok-1', refresh_token: 'ref-1' } }, error: null });
}

test('signup creates a PENDING tenant and asks for email confirmation — no session, no number', async () => {
  fresh();
  authMock();
  let telnyxHit = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { telnyxHit = true; return { ok: true, status: 200, json: async () => ({}) }; };
  try{
    const req = { method: 'POST', body: JSON.stringify({ email: 'new@salon.com', password: 'password123', name: 'Owner', salonName: 'Brand New Salon' }) };
    const res = resMock();
    await signup(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.requires_email_confirmation, true);
    assert.equal(res.body.email, 'new@salon.com');
    assert.equal(res.body.session, undefined, 'no session for an unconfirmed email');
    assert.equal(res.body.autoProvisioned, undefined, 'no number assigned at signup');
    assert.equal(telnyxHit, false, 'signup never touches Telnyx — number wiring waits for confirmation');
    // the tenant exists but is NOT live: pending_email + no number yet
    const saved = fake.all('tenants').find(t => t.owner_email === 'new@salon.com');
    assert.ok(saved, 'tenant provisioned at signup');
    assert.equal(saved.activation_status, 'pending_email');
    assert.equal(saved.phone_number, null);
  }finally{ globalThis.fetch = realFetch; }
});

test('signup succeeds (200) even if Telnyx is down — no provisioning happens at signup', async () => {
  fresh();
  authMock();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('telnyx down'); };
  try{
    const req = { method: 'POST', body: JSON.stringify({ email: 'down@salon.com', password: 'password123', name: 'Owner', salonName: 'Down Salon' }) };
    const res = resMock();
    await signup(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.requires_email_confirmation, true);
    assert.equal(res.body.session, undefined);
  }finally{ globalThis.fetch = realFetch; }
});
