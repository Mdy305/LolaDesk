/**
 * tests/sms-health.test.mjs — the SMS layer health gate.
 *
 * Run:
 *   node tests/sms-health.test.mjs
 *   node --test tests/
 *
 * Exercises the REAL smsMessagingCheck from api/launch-readiness.js: a
 * disabled Telnyx messaging profile must surface as 'SMS degraded' (never
 * silently green), a missing key/profile must fail loudly, a Telnyx API
 * error must degrade without crashing, and the API key must never leak
 * into any detail string.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// telnyxRequest reads the key from process.env internally; the check's own
// `key` param is the pre-flight gate. Set the env for the call paths.
process.env.TELNYX_API_KEY = 'KEY01_TESTKEY_NOT_REAL';
const { smsMessagingCheck } = await import('../api/launch-readiness.js');

const KEY = 'KEY01_TESTKEY_NOT_REAL';
const PROFILE = '40019e2e-77be-42da-9d66-176b658cf04a';

function stubTelnyx(payload, { status = 200, throws = false } = {}) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), auth: String(opts.headers?.Authorization || '') });
    if (throws) throw new Error('network down');
    return { ok: status < 400, status, json: async () => payload, text: async () => JSON.stringify(payload) };
  };
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}

test('missing key fails loudly and never calls Telnyx', async () => {
  const spy = stubTelnyx({ data: { enabled: true } });
  try{
    const r = await smsMessagingCheck({ key: '', profileId: PROFILE });
    assert.equal(r.ready, false);
    assert.match(r.detail, /Missing TELNYX_API_KEY/i);
    assert.equal(spy.calls.length, 0);
  }finally{ spy.restore(); }
});

test('missing profile fails loudly and never calls Telnyx', async () => {
  const spy = stubTelnyx({ data: { enabled: true } });
  try{
    const r = await smsMessagingCheck({ key: KEY, profileId: '' });
    assert.equal(r.ready, false);
    assert.match(r.detail, /Missing TELNYX_MESSAGING_PROFILE/i);
    assert.equal(spy.calls.length, 0);
  }finally{ spy.restore(); }
});

test('enabled profile reports ready with the key in the auth header only', async () => {
  const spy = stubTelnyx({ data: { id: PROFILE, enabled: true } });
  try{
    const r = await smsMessagingCheck({ key: KEY, profileId: PROFILE });
    assert.equal(r.ready, true);
    assert.match(r.detail, /enabled/i);
    assert.equal(spy.calls.length, 1);
    assert.equal(spy.calls[0].auth, 'Bearer ' + KEY);
  }finally{ spy.restore(); }
});

test('disabled profile surfaces the clear SMS-degraded state', async () => {
  const spy = stubTelnyx({ data: { id: PROFILE, enabled: false } });
  try{
    const r = await smsMessagingCheck({ key: KEY, profileId: PROFILE });
    assert.equal(r.ready, false);
    assert.match(r.detail, /SMS degraded/i);
    assert.match(r.detail, /messaging profile disabled/i);
    assert.match(r.detail, /confirmations/i); // spells out what is affected
  }finally{ spy.restore(); }
});

test('Telnyx API error degrades instead of crashing', async () => {
  const spy = stubTelnyx({}, { status: 401, throws: false });
  try{
    const r = await smsMessagingCheck({ key: KEY, profileId: PROFILE });
    assert.equal(r.ready, false);
    assert.match(r.detail, /SMS status unknown/i);
  }finally{ spy.restore(); }
});

test('network failure degrades instead of crashing', async () => {
  const spy = stubTelnyx({}, { throws: true });
  try{
    const r = await smsMessagingCheck({ key: KEY, profileId: PROFILE });
    assert.equal(r.ready, false);
    assert.match(r.detail, /SMS status unknown/i);
  }finally{ spy.restore(); }
});

test('the API key never leaks into any detail string', async () => {
  for (const scenario of [
    { payload: { data: { enabled: false } }, status: 200 },
    { payload: { errors: [{ detail: 'boom' }] }, status: 401 },
  ]){
    const spy = stubTelnyx(scenario.payload, { status: scenario.status });
    try{
      const r = await smsMessagingCheck({ key: KEY, profileId: PROFILE });
      assert.equal(r.detail.includes(KEY), false, 'key leaked into detail');
      assert.equal(JSON.stringify(r).includes(KEY), false, 'key leaked into result');
    }finally{ spy.restore(); }
  }
});
