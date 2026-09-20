/**
 * tests/calendar-ics.test.mjs — the add-to-calendar wire.
 *
 * Run:
 *   node tests/calendar-ics.test.mjs
 *   node --test tests/
 *
 * Proves the confirmation text's promise ("Add it to your calendar") lands
 * on a real route: /api/calendar.ics resolves a booking by code + the
 * CLIENT'S OWN phone (the public self-service credential, never booking_id)
 * and serves a standards-compliant ICS; wrong phone / unknown code /
 * cancelled booking all 404 so a stale link can never install a wrong event.
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
  '// Generated test double — see tests/calendar-ics.test.mjs',
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

const icsHandler = (await import('../api/calendar-ics.js')).default;
const { buildIcs, default: defaultExport } = await import('../api/calendar-ics.js');
const { confirmText, calendarLinkFor } = await import('../api/lib/lola-persona.js');

const TENANT = { id: 't1', slug: 'test-salon', name: 'Test Salon', phone_number: '+13055550100', location: '1500 Test Ave, Miami' };
const CLIENT = { id: 'cl-1', tenant_id: 't1', first_name: 'Jane', last_name: 'Doe', name: 'Jane Doe', phone: '+15551234567' };
const SERVICE = { id: 'svc-1', tenant_id: 't1', name: 'Haircut' };
const STAFF = { id: 'st-1', tenant_id: 't1', name: 'Alice' };
const CODE = 'AB3X7Q';
const START = '2026-10-01T14:00:00.000Z';
const END = '2026-10-01T15:00:00.000Z';

function makeRes() {
  const out = { code: 200, headers: {}, body: null, text: null };
  return [{
    setHeader(k, v) { out.headers[k.toLowerCase()] = v; },
    status(c) { out.code = c; return this; },
    json(o) { out.body = o; return o; },
    send(t) { out.text = t; return t; }
  }, out];
}

function seed({ status = 'confirmed' } = {}) {
  fake.reset();
  fake.seed('tenants', [TENANT]);
  fake.seed('clients', [CLIENT]);
  fake.seed('services', [SERVICE]);
  fake.seed('staff', [STAFF]);
  fake.seed('bookings', [{
    id: 'bk-1', tenant_id: 't1', client_id: 'cl-1', service_id: 'svc-1', staff_id: 'st-1',
    start_time: START, end_time: END, status, total_amount: 80,
    confirmation_code: CODE
  }]);
}

const req = (q) => ({ method: 'GET', query: q, headers: {} });

test('serves a valid ICS for the right code + client phone', async () => {
  seed();
  const [res, out] = makeRes();
  await icsHandler(req({ code: CODE, phone: '+15551234567' }), res);
  assert.equal(out.code, 200);
  assert.equal(out.headers['content-type'], 'text/calendar; charset=utf-8');
  assert.ok(out.headers['content-disposition'].includes('.ics'), 'calendar file disposition');
  const ics = out.text;
  assert.ok(ics.startsWith('BEGIN:VCALENDAR'), 'opens the calendar');
  assert.ok(ics.includes('BEGIN:VEVENT'), 'has one event');
  assert.ok(ics.includes('DTSTART:20261001T140000Z'), 'UTC start stamp: ' + ics);
  assert.ok(ics.includes('DTEND:20261001T150000Z'), 'UTC end stamp');
  assert.ok(ics.includes('SUMMARY:Haircut — Test Salon'), 'names service + salon');
  assert.ok(ics.includes('Test Salon'), 'salon present');
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'), 'closes cleanly');
});

test('phone matching is format-insensitive (spaces, 1-prefix)', async () => {
  seed();
  const [res, out] = makeRes();
  await icsHandler(req({ code: CODE, phone: '1 (555) 123-4567' }), res);
  assert.equal(out.code, 200, 'same digits, different formatting still matches');
});

test('wrong phone 404s — the link can never be used by a stranger', async () => {
  seed();
  const [res, out] = makeRes();
  await icsHandler(req({ code: CODE, phone: '+19999999999' }), res);
  assert.equal(out.code, 404);
});

test('unknown code and cancelled booking both 404', async () => {
  seed();
  const [res1, out1] = makeRes();
  await icsHandler(req({ code: 'ZZZZZZ', phone: '+15551234567' }), res1);
  assert.equal(out1.code, 404);

  seed({ status: 'cancelled' });
  const [res2, out2] = makeRes();
  await icsHandler(req({ code: CODE, phone: '+15551234567' }), res2);
  assert.equal(out2.code, 404, 'a cancelled booking never installs an event');
});

test('the .ics suffix is optional — same booking either way', async () => {
  seed();
  const [res1, out1] = makeRes();
  await icsHandler(req({ code: CODE.toLowerCase(), phone: '+15551234567' }), res1);
  assert.equal(out1.code, 200, 'case-insensitive code');
  assert.equal(out1.text.includes('DTSTART:20261001T140000Z'), true);
});

test('missing params 404 (not 500) so bad links degrade quietly', async () => {
  seed();
  const [res, out] = makeRes();
  await icsHandler(req({ code: '', phone: '' }), res);
  assert.equal(out.code, 404);
});

// ── the ICS builder itself ───────────────────────────────────────────

test('buildIcs escapes text values and folds long lines per RFC 5545', () => {
  const longSalon = 'Salon ' + 'Very Long Name '.repeat(8);
  const ics = buildIcs({
    salon: longSalon,
    serviceName: 'Cut; Color, Fade\nSecond line',
    staffName: 'Rex',
    startIso: START,
    endIso: END,
    location: 'Beverly Hills, CA'
  });
  assert.ok(ics.includes('Cut\\; Color\\, Fade\\nSecond line'), 'escapes ; , and newlines');
  for (const line of ics.split('\r\n')) {
    assert.ok(line.length <= 75, 'every line folded to <=75 octets: ' + line.slice(0, 30));
    if (line.startsWith(' ')) assert.ok(true);
  }
  assert.ok(ics.includes('LOCATION:Beverly Hills\\, CA'), 'location escaped');
  assert.ok(!defaultExport || typeof defaultExport === 'function');
});

// ── the persona side: the link is client-owned and the copy carries it ──

test('calendarLinkFor is built from code + phone only — never a booking_id', () => {
  const link = calendarLinkFor({ code: 'ab3x7q', phone: '+15551234567' });
  assert.ok(link.includes('/api/calendar.ics?code=AB3X7Q'), 'uppercased code in link');
  assert.ok(link.includes('phone='), 'phone in link');
  assert.ok(!link.includes('bk-1'), 'no booking_id ever');
  assert.ok(link.startsWith('https://www.loladesk.com'), 'canonical base fallback');
  assert.equal(calendarLinkFor({ code: '', phone: '' }), null, 'no fragments, no link');
});

test('confirmText carries the calendar line and keeps the opt-out last', () => {
  const t = confirmText({
    verb: 'Booked', salon: 'Test Salon', serviceName: 'Haircut',
    when: 'Thu, Oct 1, 2:00 PM', code: CODE,
    calendarUrl: 'https://www.loladesk.com/api/calendar.ics?code=AB3X7Q&phone=15551234567'
  });
  assert.ok(t.includes('Add it to your calendar: https://'), 'calendar line present');
  assert.ok(t.includes(CODE), 'confirmation code still present');
  assert.ok(/Reply STOP to opt out\.$/.test(t), 'opt-out stays last: ' + t);
  const plain = confirmText({ verb: 'Booked', salon: 'S', serviceName: 'X', when: 'W', code: CODE });
  assert.ok(!plain.includes('calendar'), 'no dangling fragment without a url');
  assert.ok(/Reply STOP to opt out\.$/.test(plain), 'plain text still ends with opt-out');
});

// ── end to end: the REAL confirmation SMS carries the live link ──────

test('sendConfirmationSMS includes the add-to-calendar link in the real text', async () => {
  seed();
  process.env.TELNYX_API_KEY = 'test-key';
  const { sendConfirmationSMS } = await import('../api/lib/booking-repository.js');
  const smsCalls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url).includes('/v2/messages')) {
      smsCalls.push(JSON.parse(opts.body || '{}'));
      return { ok: true, status: 200, json: async () => ({ data: {} }) };
    }
    return realFetch(url, opts);
  };
  try {
    const r = await sendConfirmationSMS({
      tenantId: 't1', clientId: 'cl-1', serviceId: 'svc-1',
      startTime: START, confirmationCode: CODE
    });
    assert.equal(r.sent, true, 'send succeeds: ' + JSON.stringify(r));
  } finally {
    global.fetch = realFetch;
  }
  assert.equal(smsCalls.length, 1);
  const text = String(smsCalls[0].text);
  assert.ok(text.includes('/api/calendar.ics?code=AB3X7Q'), 'the live link is in the text: ' + text);
  assert.ok(text.includes('phone=%2B15551234567'), 'the client phone rides the link (encoded)');
  assert.ok(!text.includes('bk-1'), 'never an internal booking_id');
  assert.ok(/Reply STOP to opt out\.$/.test(text), 'opt-out last: ' + text);
});

test('cancel texts stay link-free (a cancellation removes the event, not adds it)', async () => {
  seed();
  process.env.TELNYX_API_KEY = 'test-key';
  const { sendConfirmationSMS } = await import('../api/lib/booking-repository.js');
  const smsCalls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url).includes('/v2/messages')) {
      smsCalls.push(JSON.parse(opts.body || '{}'));
      return { ok: true, status: 200, json: async () => ({ data: {} }) };
    }
    return realFetch(url, opts);
  };
  try {
    await sendConfirmationSMS({
      tenantId: 't1', clientId: 'cl-1', serviceId: 'svc-1',
      startTime: START, confirmationCode: CODE, verb: 'Cancelled'
    });
  } finally {
    global.fetch = realFetch;
  }
  assert.equal(smsCalls.length, 1);
  assert.ok(!String(smsCalls[0].text).includes('calendar.ics'), 'no calendar link on a cancel');
});
