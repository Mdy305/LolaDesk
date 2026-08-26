/**
 * tests/booking-reminders.test.mjs — the booking reminder engine.
 *
 * Run:
 *   node tests/booking-reminders.test.mjs
 *   node --test tests/
 *
 * Drives the REAL engine (findDueBookings → gate → claim → send → log)
 * against the in-memory fake Supabase with an injectable SMS sender. Proves
 * the ~24h window, the booking_settings.reminder_sms gate, exactly-once
 * semantics per appointment time (a second run or a pre-existing row never
 * re-texts), and that send failures are logged as 'failed'.
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
  '// Generated test double — see tests/booking-reminders.test.mjs',
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

const { runReminders } = await import('../api/lib/booking-reminders.js');

const T1 = '11111111-1111-1111-1111-111111111111';
const TENANT = { id: T1, name: 'Salon A', phone_number: '+13055550100' };
const CLIENT = { id: 'cl-1', tenant_id: T1, name: 'Maya Chen', phone: '+13055550123' };
const SERVICE = { id: 'svc-1', tenant_id: T1, name: 'Balayage' };

function isoHoursFromNow(h) {
  return new Date(Date.now() + h * 3600e3).toISOString();
}

function seed({ reminderSms = true, bookingStart = isoHoursFromNow(24), client = CLIENT, status = 'confirmed', whatsappConnected = false, integrations = [], conversations = [] } = {}) {
  fake.reset();
  fake.seed('tenants', [TENANT]);
  fake.seed('clients', [client]);
  fake.seed('services', [SERVICE]);
  fake.seed('booking_settings', [{ tenant_id: T1, reminder_sms: reminderSms }]);
  fake.seed('bookings', [{
    id: 'bk-1', tenant_id: T1, client_id: client.id, service_id: 'svc-1',
    start_time: bookingStart, end_time: new Date(new Date(bookingStart).getTime() + 3600e3).toISOString(),
    status, total_amount: 180, source: 'public_web'
  }]);
  fake.seed('booking_reminders', []);
  if (whatsappConnected) {
    fake.seed('integrations', [{ tenant_id: T1, provider: 'whatsapp', status: 'connected' }, ...integrations]);
  } else {
    fake.seed('integrations', integrations);
  }
  fake.seed('conversations', conversations);
}

function makeSpy() {
  const calls = [];
  return [calls, async (msg) => { calls.push(msg); }];
}

test('texts a client whose confirmed booking starts ~24h away, once, and logs sent', async () => {
  const bookingStart = isoHoursFromNow(24);
  seed({ bookingStart });
  const [calls, send] = makeSpy();
  const result = await runReminders(new Date(), { send });
  assert.equal(result.due, 1);
  assert.equal(result.sent, 1);
  assert.equal(result.failed, 0);
  assert.equal(calls.length, 1);
  const msg = calls[0];
  assert.equal(msg.from, '+13055550100', 'sends from the salon number');
  assert.equal(msg.to, '+13055550123', 'sends to the client');
  assert.equal(msg.tenantId, T1);
  assert.ok(msg.text.includes('Balayage'), 'text names the service');
  assert.ok(msg.text.includes('Reminder'), 'text is a reminder');
  const rows = fake.all('booking_reminders');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'sent');
  assert.equal(rows[0].booking_id, 'bk-1');
  assert.equal(rows[0].reminder_for, bookingStart, 'reminder_for is the appointment start time');
  assert.ok(rows[0].sent_at, 'sent_at recorded');
});

test('exactly-once: a second run never re-texts the same appointment time', async () => {
  seed();
  const [calls, send] = makeSpy();
  const first = await runReminders(new Date(), { send });
  const second = await runReminders(new Date(), { send });
  assert.equal(first.sent, 1);
  assert.equal(second.due, 1, 'still due (the booking is still in the window)');
  assert.equal(second.sent, 0, 'but nothing is sent again');
  assert.equal(second.skipped, 1);
  assert.equal(calls.length, 1, 'one SMS total across both runs');
  assert.equal(fake.all('booking_reminders').length, 1, 'one log row total');
});

test('a pre-existing sent row for the same appointment time is not re-texted', async () => {
  seed();
  fake.seed('booking_reminders', [{
    id: 'rem-1', tenant_id: T1, booking_id: 'bk-1', client_id: 'cl-1',
    reminder_for: isoHoursFromNow(24), status: 'sent', sent_at: new Date().toISOString(), channel: 'sms'
  }]);
  const [calls, send] = makeSpy();
  const result = await runReminders(new Date(), { send });
  assert.equal(result.sent, 0);
  assert.equal(result.skipped, 1);
  assert.equal(calls.length, 0);
});

test('salon gate: booking_settings.reminder_sms=false blocks the text', async () => {
  seed({ reminderSms: false });
  const [calls, send] = makeSpy();
  const result = await runReminders(new Date(), { send });
  assert.equal(result.due, 1);
  assert.equal(result.gate_off, 1);
  assert.equal(result.sent, 0);
  assert.equal(calls.length, 0);
  assert.equal(fake.all('booking_reminders').length, 0, 'no log row when gated off');
});

test('bookings outside the 23–25h window are not due', async () => {
  seed({ bookingStart: isoHoursFromNow(3) });
  const [calls, send] = makeSpy();
  const result = await runReminders(new Date(), { send });
  assert.equal(result.due, 0);
  assert.equal(result.sent, 0);
  assert.equal(calls.length, 0);
});

test('a client without a phone number is skipped, not texted', async () => {
  seed({ client: { id: 'cl-2', tenant_id: T1, name: 'No Phone', phone: null } });
  const [calls, send] = makeSpy();
  const result = await runReminders(new Date(), { send });
  assert.equal(result.sent, 0);
  assert.equal(result.skipped, 1);
  assert.equal(calls.length, 0);
});

test('a send failure is logged as failed and does not crash the run', async () => {
  seed();
  const boom = async () => { throw new Error('Telnyx 402: low credit'); };
  const result = await runReminders(new Date(), { send: boom });
  assert.equal(result.failed, 1);
  assert.equal(result.sent, 0);
  const rows = fake.all('booking_reminders');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'failed');
  assert.ok(rows[0].error.includes('402'), 'error message captured');
});

test('cancelled bookings are never reminded', async () => {
  seed({ status: 'cancelled' });
  const [calls, send] = makeSpy();
  const result = await runReminders(new Date(), { send });
  assert.equal(result.due, 0);
  assert.equal(calls.length, 0);
});

test('sends WhatsApp when the salon has WhatsApp connected and the client opted in', async () => {
  const waClient = { ...CLIENT, whatsapp_enabled: true };
  seed({ client: waClient, whatsappConnected: true });
  const [calls, send] = makeSpy();
  const result = await runReminders(new Date(), { send });
  assert.equal(result.due, 1);
  assert.equal(result.sent, 1);
  assert.equal(result.whatsapp, 1, 'counted as whatsapp');
  assert.equal(result.sms, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'WHATSAPP', 'sendSMS receives the WHATSAPP type');
  const rows = fake.all('booking_reminders');
  assert.equal(rows[0].channel, 'whatsapp', 'log records the whatsapp channel');
  assert.equal(rows[0].status, 'sent');
});

test('falls back to SMS when the client has NOT opted into WhatsApp even if the salon has it', async () => {
  const waClient = { ...CLIENT, whatsapp_enabled: false };
  seed({ client: waClient, whatsappConnected: true });
  const [calls, send] = makeSpy();
  const result = await runReminders(new Date(), { send });
  assert.equal(result.sent, 1);
  assert.equal(result.whatsapp, 0);
  assert.equal(result.sms, 1);
  assert.equal(calls[0].type, 'SMS');
  assert.equal(fake.all('booking_reminders')[0].channel, 'sms');
});

test('falls back to SMS when the client opted in but the salon has no WhatsApp connection', async () => {
  const waClient = { ...CLIENT, whatsapp_enabled: true };
  seed({ client: waClient, whatsappConnected: false });
  const [calls, send] = makeSpy();
  const result = await runReminders(new Date(), { send });
  assert.equal(result.sent, 1);
  assert.equal(result.whatsapp, 0);
  assert.equal(result.sms, 1);
  assert.equal(calls[0].type, 'SMS');
  assert.equal(fake.all('booking_reminders')[0].channel, 'sms');
});

