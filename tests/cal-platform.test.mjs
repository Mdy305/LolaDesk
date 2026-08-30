/**
 * tests/cal-platform.test.mjs — the Cal.com (White-Label) mesh node.
 *
 * Run:
 *   node tests/cal-platform.test.mjs
 *   node --test tests/
 *
 * Proves the pieces booking-sync/aggregator depend on: normalized
 * appointment shape from Cal.com v2 {status,data} responses, the create
 * booking request body (eventTypeId + attendee + cal-api-version header),
 * slots flattening, event-type mapping, white-label managed-user
 * provisioning headers, token refresh, and the graceful unconfigured
 * degrade (never a silent undefined or a crash with a bad config).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const realFetch = globalThis.fetch;
function mockFetch(handler){
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const res = handler(u, opts);
    if (res instanceof Error) throw res;
    return { ok: true, status: 200, json: async () => res };
  };
}
function restoreFetch(){ globalThis.fetch = realFetch; }

const cal = await import('../api/lib/connectors/cal-platform.js');

const NORMALIZED_KEYS = ['id', 'starts_at', 'ends_at', 'duration_min', 'client', 'stylist', 'status'];

test('META and adapter contract shape', () => {
  for (const k of ['name', 'description', 'status', 'docs']) assert.ok(cal.META[k], `META.${k} missing`);
  for (const fn of ['getAuthUrl', 'exchangeCode', 'refreshToken', 'listAppointments', 'createAppointment', 'listClients']) {
    assert.equal(typeof cal[fn], 'function', `${fn} is not a function`);
  }
});

test('listAppointments normalizes Cal.com v2 bookings to the mesh shape', async () => {
  delete process.env.CAL_COM_API_KEY;
  process.env.CAL_COM_ACCESS_TOKEN = 'managed-token';
  mockFetch((u) => {
    assert.match(u, /\/v2\/bookings\?/);
    assert.match(u, /afterStart=2026-09-01/);
    assert.match(u, /beforeEnd=2026-09-02/);
    return {
      status: 'success',
      data: [{
        id: 42, uid: 'bk-abc123',
        start: '2026-09-01T10:00:00Z', end: '2026-09-01T10:45:00Z', duration: 45,
        status: 'accepted',
        attendees: [{ name: 'Jane Doe', email: 'jane@example.com', phone: '+13055550100' }],
        hosts: [{ name: 'Alice' }],
        eventType: { id: 7, slug: 'balayage' }
      }]
    };
  });
  try {
    const apps = await cal.listAppointments({ access_token: 'x' }, { from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z' });
    assert.equal(apps.length, 1);
    const a = apps[0];
    for (const k of NORMALIZED_KEYS) assert.ok(k in a, `missing key ${k}`);
    assert.equal(a.id, 'bk-abc123');
    assert.equal(a.starts_at, '2026-09-01T10:00:00Z');
    assert.equal(a.ends_at, '2026-09-01T10:45:00Z');
    assert.equal(a.duration_min, 45);
    assert.equal(a.client.name, 'Jane Doe');
    assert.equal(a.client.email, 'jane@example.com');
    assert.equal(a.service, 'balayage');
    assert.equal(a.stylist, 'Alice');
    assert.equal(a.status, 'accepted');
  } finally { restoreFetch(); delete process.env.CAL_COM_ACCESS_TOKEN; }
});

test('createAppointment sends the v2 booking body with cal-api-version and normalizes the response', async () => {
  process.env.CAL_COM_API_KEY = 'cal_test_key';
  mockFetch((u, opts) => {
    assert.equal(u, 'https://api.cal.com/v2/bookings');
    assert.equal(opts.method, 'POST');
    assert.equal(opts.headers['cal-api-version'], '2024-08-13');
    assert.equal(opts.headers.Authorization, 'Bearer cal_test_key');
    const body = JSON.parse(opts.body);
    assert.equal(body.eventTypeId, 7);
    assert.equal(body.start, '2026-09-01T10:00:00Z');
    assert.equal(body.attendee.name, 'Jane Doe');
    assert.equal(body.attendee.email, 'jane@example.com');
    assert.equal(body.location.type, 'phone');
    return { status: 'success', data: { id: 9, uid: 'bk-new', start: '2026-09-01T10:00:00Z', end: '2026-09-01T10:45:00Z', duration: 45, status: 'accepted', attendees: [{ name: 'Jane Doe', email: 'jane@example.com' }], eventType: { slug: 'balayage' } } };
  });
  try {
    const out = await cal.createAppointment({}, {
      event_type_id: 7, starts_at: '2026-09-01T10:00:00Z',
      client: { name: 'Jane Doe', email: 'jane@example.com' }
    });
    assert.equal(out.id, 'bk-new');
    assert.equal(out.duration_min, 45);
    assert.equal(out.client.name, 'Jane Doe');
  } finally { restoreFetch(); delete process.env.CAL_COM_API_KEY; }
});

test('createAppointment synthesizes an attendee email from phone when none is known', async () => {
  process.env.CAL_COM_API_KEY = 'cal_test_key';
  mockFetch((u, opts) => {
    const body = JSON.parse(opts.body);
    assert.equal(body.attendee.email, '13055550100@guest.loladesk.com');
    assert.equal(body.attendee.phone, '+13055550100');
    return { status: 'success', data: { uid: 'bk-ph', start: '2026-09-01T10:00:00Z', end: '2026-09-01T10:30:00Z', duration: 30, status: 'accepted', attendees: [{ name: 'Jane' }] } };
  });
  try {
    const out = await cal.createAppointment({}, {
      event_type_id: 7, starts_at: '2026-09-01T10:00:00Z',
      client: { name: 'Jane', phone: '+13055550100' }
    });
    assert.equal(out.id, 'bk-ph');
  } finally { restoreFetch(); delete process.env.CAL_COM_API_KEY; }
});

test('createAppointment requires event_type_id (fails loudly, no silent write)', async () => {
  process.env.CAL_COM_API_KEY = 'cal_test_key';
  mockFetch(() => { throw new Error('must not hit network'); });
  try {
    await assert.rejects(
      () => cal.createAppointment({}, { starts_at: '2026-09-01T10:00:00Z', client: { name: 'Jane' } }),
      /event_type_id/
    );
  } finally { restoreFetch(); delete process.env.CAL_COM_API_KEY; }
});

test('getAvailability flattens Cal.com slot buckets into a sorted time list', async () => {
  process.env.CAL_COM_API_KEY = 'cal_test_key';
  mockFetch((u) => {
    assert.match(u, /\/v2\/slots\/available\?/);
    assert.match(u, /eventTypeId=7/);
    return { status: 'success', data: { slots: {
      '2026-09-01': [{ time: '2026-09-01T14:00:00Z' }, { time: '2026-09-01T15:00:00Z' }],
      '2026-09-02': [{ time: '2026-09-02T09:00:00Z' }]
    } } };
  });
  try {
    const slots = await cal.getAvailability({}, { eventTypeId: 7, from: '2026-09-01T00:00:00Z', to: '2026-09-03T00:00:00Z' });
    assert.equal(slots.length, 3);
    assert.equal(slots[0].time, '2026-09-01T14:00:00Z');
    assert.equal(slots[2].time, '2026-09-02T09:00:00Z');
    assert.ok(new Date(slots[0].time) <= new Date(slots[2].time), 'slots sorted');
  } finally { restoreFetch(); delete process.env.CAL_COM_API_KEY; }
});

test('listEventTypes maps Cal.com event types to the mesh service shape', async () => {
  process.env.CAL_COM_API_KEY = 'cal_test_key';
  mockFetch(() => ({
    status: 'success',
    data: [{ id: 7, slug: 'balayage', title: 'Balayage', lengthInMinutes: 90 }]
  }));
  try {
    const types = await cal.listEventTypes({});
    assert.equal(types.length, 1);
    assert.equal(types[0].id, 7);
    assert.equal(types[0].length_in_minutes, 90);
  } finally { restoreFetch(); delete process.env.CAL_COM_API_KEY; }
});

test('provisionManagedUser sends platform client-credential headers (white-label)', async () => {
  process.env.CAL_COM_CLIENT_ID = 'client-1';
  process.env.CAL_COM_CLIENT_SECRET = 'secret-1';
  mockFetch((u, opts) => {
    assert.equal(u, 'https://api.cal.com/v2/oauth/client-1/authorize');
    assert.equal(opts.headers['x-cal-client-id'], 'client-1');
    assert.equal(opts.headers['x-cal-secret-key'], 'secret-1');
    assert.equal(JSON.parse(opts.body).email, 'salon@example.com');
    return { status: 'success', data: { accessToken: 'at-1', refreshToken: 'rt-1', managedUserId: 'mu-9' } };
  });
  try {
    const out = await cal.provisionManagedUser({ email: 'salon@example.com', name: 'Salon One' });
    assert.equal(out.access_token, 'at-1');
    assert.equal(out.refresh_token, 'rt-1');
    assert.equal(out.managed_user_id, 'mu-9');
  } finally { restoreFetch(); delete process.env.CAL_COM_CLIENT_ID; delete process.env.CAL_COM_CLIENT_SECRET; }
});

test('provisionManagedUser throws descriptively when platform credentials are absent', async () => {
  delete process.env.CAL_COM_CLIENT_ID;
  delete process.env.CAL_COM_CLIENT_SECRET;
  await assert.rejects(() => cal.provisionManagedUser({ email: 'x@example.com' }), /CAL_COM_CLIENT_ID/);
});

test('refreshToken posts to the platform refresh endpoint and returns new tokens', async () => {
  process.env.CAL_COM_CLIENT_ID = 'client-1';
  process.env.CAL_COM_CLIENT_SECRET = 'secret-1';
  mockFetch((u, opts) => {
    assert.equal(u, 'https://api.cal.com/v2/oauth/client-1/refresh');
    const body = JSON.parse(opts.body);
    assert.equal(body.refreshToken, 'rt-old');
    assert.equal(body.managedUserId, 'mu-9');
    return { status: 'success', data: { accessToken: 'at-2', refreshToken: 'rt-2' } };
  });
  try {
    const out = await cal.refreshToken('rt-old', { managed_user_id: 'mu-9' });
    assert.equal(out.ok, true);
    assert.equal(out.access_token, 'at-2');
    assert.equal(out.refresh_token, 'rt-2');
  } finally { restoreFetch(); delete process.env.CAL_COM_CLIENT_ID; delete process.env.CAL_COM_CLIENT_SECRET; }
});

test('unconfigured node degrades gracefully (no crash, no silent undefined)', async () => {
  delete process.env.CAL_COM_API_KEY;
  delete process.env.CAL_COM_ACCESS_TOKEN;
  delete process.env.CAL_COM_CLIENT_ID;
  delete process.env.CAL_COM_CLIENT_SECRET;
  // getAuthUrl throws a descriptive config error (Booksy convention)
  assert.throws(() => cal.getAuthUrl(), /not configured/);
  // exchangeCode returns a graceful {ok:false, error} — contract-compliant
  const exch = await cal.exchangeCode('bogus');
  assert.equal(exch.ok, false);
  assert.ok(exch.error);
  // refreshToken without client creds returns graceful failure
  const ref = await cal.refreshToken('rt');
  assert.equal(ref.ok, false);
  // listAppointments fails loudly with a config message, not a network error
  await assert.rejects(() => cal.listAppointments({}), /not configured/);
});

console.log('\ncal-platform: Cal.com mesh node conforms to the adapter contract ✅');
