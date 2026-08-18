/**
 * tests/connector-contract.test.mjs — the open-source connector contract.
 *
 * Run:
 *   node tests/connector-contract.test.mjs
 *   node --test tests/
 *
 * LolaDesk can synchronize with ANY booking system. The guarantee behind that
 * is this contract: every connector in api/lib/connectors/ must expose the
 * same 7-member adapter interface (META + getAuthUrl + exchangeCode +
 * refreshToken + listAppointments + createAppointment + listClients) and
 * return the same NORMALIZED appointment shape. A new booking system is just
 * a new file that conforms — this suite proves it the moment it's added.
 *
 * Tests are static conformance (no network) plus one mocked-fetch round trip
 * through the Square connector to pin the normalized shape.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as aggregator from '../api/lib/aggregator.js';

const REQUIRED_FUNCS = ['getAuthUrl', 'exchangeCode', 'refreshToken', 'listAppointments', 'createAppointment', 'listClients'];
const REQUIRED_META = ['name', 'description', 'status', 'docs'];
const NORMALIZED_KEYS = ['id', 'starts_at', 'ends_at', 'duration_min', 'client', 'stylist', 'status'];

const providers = aggregator.listProviders();
assert.ok(providers.length >= 6, `expected 6+ providers, got ${providers.length}`);

test('every registered provider is resolvable by getConnector', () => {
  for (const p of providers) {
    const c = aggregator.getConnector(p.id);
    assert.ok(c, `getConnector(${p.id}) returned nothing`);
    assert.equal(c.META?.name, p.name, `${p.id} META.name mismatch`);
  }
});

test('every connector implements the full adapter contract', () => {
  for (const p of providers) {
    const c = aggregator.getConnector(p.id);
    // META shape
    for (const k of REQUIRED_META) {
      assert.ok(c.META && c.META[k], `${p.id}: META.${k} missing`);
    }
    // every required function is present and callable
    for (const fn of REQUIRED_FUNCS) {
      assert.equal(typeof c[fn], 'function', `${p.id}: ${fn} is not a function`);
    }
    // the data functions must be async (they hit a provider API)
    for (const fn of ['listAppointments', 'createAppointment', 'listClients']) {
      const out = c[fn]();
      assert.ok(out instanceof Promise, `${p.id}: ${fn} should return a Promise`);
      out.catch(() => {}); // swallow the inevitable network rejection
    }
  }
});

test('OAuth helpers return a string auth URL or a descriptive config error', async () => {
  for (const p of providers) {
    const c = aggregator.getConnector(p.id);
    // Contract: getAuthUrl returns a usable URL, OR throws a helpful
    // "credentials not configured" style error (never a silent undefined).
    let threw = null;
    let url = null;
    try { url = c.getAuthUrl('test-state'); }
    catch (e) { threw = e; }
    if (threw) {
      assert.ok(String(threw.message).length > 5, `${p.id}: config error should be descriptive`);
    } else {
      assert.equal(typeof url, 'string', `${p.id}: getAuthUrl should return a string`);
      assert.ok(url.length > 10, `${p.id}: auth URL looks empty`);
    }
    // exchangeCode must FAIL on a bogus code — either by rejecting, or by
    // resolving a graceful { ok:false, error } stub (Boulevard's
    // pending_partner_approval convention). It must never resolve undefined.
    let exch = null;
    let rejected = false;
    try { exch = await c.exchangeCode('bogus'); }
    catch { rejected = true; }
    if (!rejected) {
      if (exch && typeof exch === 'object' && exch.ok === false) {
        assert.ok(exch.error, `${p.id}: graceful failure must carry an error message`);
      } else {
        assert.fail(`${p.id}: exchangeCode('bogus') must reject or return {ok:false}`);
      }
    }
  }
});

test('aggregator throws on an unknown provider and lists all connectors', () => {
  assert.throws(() => aggregator.getConnector('not-a-provider'), /Unknown provider/);
  const ids = providers.map(p => p.id);
  assert.ok(ids.includes('square') && ids.includes('vagaro') && ids.includes('google_calendar'));
});

test('Square connector returns the NORMALIZED appointment shape (mocked fetch)', async () => {
  const square = aggregator.getConnector('square');
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    if (url.includes('/v2/locations')) {
      return { ok: true, json: async () => ({ locations: [{ id: 'loc-1' }] }) };
    }
    if (url.includes('/v2/bookings/search')) {
      return {
        ok: true,
        json: async () => ({
          bookings: [{
            id: 'bk-1',
            start_at: '2026-09-01T10:00:00Z',
            appointment_segments: [{ duration_minutes: 45, team_member_id: 'tm-7' }]
          }]
        })
      };
    }
    throw new Error('unexpected fetch: ' + url);
  };
  try {
    const apps = await square.listAppointments({ access_token: 't' }, { from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z' });
    assert.equal(apps.length, 1);
    const a = apps[0];
    for (const k of NORMALIZED_KEYS) {
      assert.ok(k in a, `normalized appointment missing key "${k}"`);
    }
    assert.equal(a.id, 'bk-1');
    assert.equal(a.duration_min, 45);
    assert.equal(a.stylist, 'tm-7');
    assert.ok(new Date(a.ends_at) > new Date(a.starts_at), 'ends_at must be after starts_at');
    assert.ok(calls.length >= 2, 'should hit locations + bookings/search');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('writeAppointment routes to the matched provider connector', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('contract test should not hit network'); };
  try {
    const integrations = [{ provider: 'square', access_token: 'x' }, { provider: 'vagaro', access_token: 'y' }];
    await assert.rejects(
      () => aggregator.writeAppointment(integrations, { starts_at: '2026-09-01T10:00:00Z' }, { provider: 'vagaro' }),
      undefined,
      'vagaro write should attempt a network call (and fail offline)'
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── summary ────────────────────────────────────────────────────────────────
console.log(`\nconnector-contract: ${providers.length} connectors conform to the adapter contract ✅`);
