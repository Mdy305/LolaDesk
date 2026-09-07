/**
 * tests/cancel-sms.test.mjs — the cancellation Telnyx wire.
 *
 * Run:
 *   node tests/cancel-sms.test.mjs
 *   node --test tests/
 *
 * Before this, cancellation was the one booking lifecycle moment with no
 * Telnyx wire: a confirmed booking cancelled by the salon (dashboard, series
 * pass) or the client never produced a text, so clients could show up to a
 * cancelled chair. Proves the contract against the in-memory fake Supabase:
 *   • confirmed → cancelled sends exactly ONE cancellation text
 *   • a draft/pending booking cancelled sends none (client never expected it)
 *   • an already-cancelled booking never re-texts
 *   • series passes suppress per-occurrence texts (sendCancellation:false —
 *     the series contract is ONE text per series event, sent at the call site)
 *   • the reschedule re-confirmation path still fires (regression guard)
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
  name: '@supabase/supabase-js',
  version: '0.0.0-test',
  type: 'module',
  main: 'index.js',
  exports: { '.': './index.js' }
}, null, 2));
writeFileSync(join(STUB_DIR, 'index.js'), [
  '// Generated test double — see tests/cancel-sms.test.mjs',
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

globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

const { updateCanonicalBooking } = await import('../api/lib/booking-repository.js');

const T1 = 't1';
const TENANT = { id: T1, slug: 'test-salon', name: 'Test Salon', phone_number: '+13055550100' };
const CLIENT = { id: 'cl-1', tenant_id: T1, name: 'Jane Doe', phone: '+15551234567' };
const SERVICE = { id: 'svc-1', tenant_id: T1, name: 'Balayage', price: 180, duration_minutes: 120, is_active: true };

const START = new Date(Date.now() + 3 * 86400000).toISOString();

function seed(bookingPatch = {}) {
  fake.reset();
  fake.seed('tenants', [TENANT]);
  fake.seed('clients', [CLIENT]);
  fake.seed('services', [SERVICE]);
  fake.seed('booking_status_history', []);
  fake.seed('bookings', [{
    id: 'bk-1', tenant_id: T1, client_id: 'cl-1', service_id: 'svc-1', staff_id: 'st-1',
    start_time: START,
    end_time: new Date(new Date(START).getTime() + 120 * 60000).toISOString(),
    status: 'confirmed', total_amount: 180, source: 'dashboard', confirmation_code: 'AB3X7Q',
    ...bookingPatch
  }]);
}

// Capture Telnyx message sends (the only real-network hop in the path).
function captureSms() {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).includes('/v2/messages')) {
      const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : (opts.body || {});
      calls.push(body);
      return { ok: true, status: 200, json: async () => ({ data: { id: 'msg-x' } }) };
    }
    return realFetch(url, opts);
  };
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}

test('confirmed → cancelled sends exactly one cancellation text naming the salon', async () => {
  seed();
  const sms = captureSms();
  try {
    const row = await updateCanonicalBooking(T1, 'bk-1', { status: 'cancelled' }, { source: 'dashboard', reason: 'client_request' });
    assert.equal(row.status, 'cancelled');
    assert.equal(sms.calls.length, 1, 'expected exactly one SMS, got ' + sms.calls.length);
    const text = sms.calls[0].text || '';
    assert.ok(/has been cancelled/.test(text), 'text should say the appointment was cancelled — got: ' + text);
    assert.ok(text.includes('Test Salon'), 'text should name the salon — got: ' + text);
    assert.equal(sms.calls[0].to, '+15551234567');
  } finally { sms.restore(); }
});

test('a draft/pending booking cancelled sends no text (client never expected it)', async () => {
  seed({ status: 'pending' });
  const sms = captureSms();
  try {
    await updateCanonicalBooking(T1, 'bk-1', { status: 'cancelled' }, { source: 'dashboard' });
    assert.equal(sms.calls.length, 0, 'no SMS for a never-confirmed booking');
  } finally { sms.restore(); }
});

test('an already-cancelled booking never re-texts', async () => {
  seed({ status: 'cancelled' });
  const sms = captureSms();
  try {
    await updateCanonicalBooking(T1, 'bk-1', { status: 'cancelled' }, { source: 'dashboard' });
    assert.equal(sms.calls.length, 0, 'no duplicate cancellation text');
  } finally { sms.restore(); }
});

test('series passes suppress per-occurrence texts via sendCancellation:false', async () => {
  seed({ series_id: 'ser-1', series_pos: 2, series_total: 4 });
  const sms = captureSms();
  try {
    await updateCanonicalBooking(T1, 'bk-1', { status: 'cancelled' },
      { source: 'dashboard', reason: 'client_request', sendCancellation: false });
    assert.equal(sms.calls.length, 0, 'series loop suppresses per-occurrence texts; the call site sends ONE');
  } finally { sms.restore(); }
});

test('a later-series occurrence cancelled on its own still texts (single cancel)', async () => {
  seed({ series_id: 'ser-1', series_pos: 3, series_total: 4 });
  const sms = captureSms();
  try {
    await updateCanonicalBooking(T1, 'bk-1', { status: 'cancelled' }, { source: 'dashboard' });
    assert.equal(sms.calls.length, 1, 'single-occurrence cancel tells the client regardless of series position');
  } finally { sms.restore(); }
});

test('reschedule re-confirmation still fires (regression guard)', async () => {
  seed();
  const newStart = new Date(new Date(START).getTime() + 48 * 3600000).toISOString();
  const sms = captureSms();
  try {
    await updateCanonicalBooking(T1, 'bk-1', { start_time: newStart, status: 'confirmed' }, { source: 'public_widget', reason: 'client_self_service_reschedule' });
    assert.equal(sms.calls.length, 1, 'reschedule texts once');
    assert.ok(/Rescheduled at/.test(sms.calls[0].text || ''), 'reschedule text keeps its pattern — got: ' + (sms.calls[0].text || ''));
  } finally { sms.restore(); }
});
