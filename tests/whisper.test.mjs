/**
 * tests/whisper.test.mjs — "Whisper to Lola" live-steering contract
 * Covers the two pure functions behind /api/whisper:
 *   • resolveTargetCall — only the tenant's own call_sessions rows are whisperable;
 *     an explicit id is verified; omitted id resolves the most recent conversation.
 *   • injectWhisper — posts a single SYSTEM message to Telnyx's per-call
 *     ai_assistant_add_messages command, never echo a key, and surfaces an
 *     ended-call / unconfigured rejection honestly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeSupabase } from './fake-supabase.js';
import { resolveTargetCall, injectWhisper } from '../api/whisper.js';

// ── target resolution ────────────────────────────────────────────────────────
test('resolves an explicit call_control_id that belongs to the tenant', async () => {
  const fake = new FakeSupabase();
  fake.seed('call_sessions', [
    { call_control_id: 'cc-live', tenant_id: 't1', from_number: '+1', to_number: '+2', created_at: '2026-01-01T00:00:00Z' }
  ]);
  const r = await resolveTargetCall(fake, 't1', 'cc-live');
  assert.deepEqual(r, { callControlId: 'cc-live' });
});

test('refuses a call_control_id that is not this tenant\u2019s', async () => {
  const fake = new FakeSupabase();
  fake.seed('call_sessions', [
    { call_control_id: 'cc-live', tenant_id: 't1', from_number: '+1', to_number: '+2', created_at: '2026-01-01T00:00:00Z' }
  ]);
  const r = await resolveTargetCall(fake, 't2', 'cc-live');
  assert.equal(r.status, 404);
  assert.match(r.error, /not yours/i);
});

test('omitted id resolves the tenant\u2019s most recent conversation', async () => {
  const fake = new FakeSupabase();
  fake.seed('call_sessions', [
    { call_control_id: 'cc-old', tenant_id: 't1', from_number: '+1', to_number: '+2', created_at: '2026-01-01T00:00:00Z' },
    { call_control_id: 'cc-new', tenant_id: 't1', from_number: '+3', to_number: '+4', created_at: '2026-01-02T00:00:00Z' }
  ]);
  const r = await resolveTargetCall(fake, 't1', '');
  assert.deepEqual(r, { callControlId: 'cc-new' });
});

test('no conversation -> honest 404, never a fabricated target', async () => {
  const fake = new FakeSupabase();
  const r = await resolveTargetCall(fake, 't1', '');
  assert.equal(r.status, 404);
  assert.match(r.error, /no active call/i);
});

// ── injection ────────────────────────────────────────────────────────────────
test('posts a system message to the call\u2019s Telnyx assistant command', async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url, auth: opts.headers?.Authorization, body: JSON.parse(opts.body || '{}') });
    return { ok: true, status: 200, json: async () => ({ data: { result: 'ok' } }) };
  };
  try {
    const r = await injectWhisper({ callControlId: 'cc-live', message: 'This is a VIP, comp the blowout', telnyxKey: 'sk-test' });
    assert.ok(r.ok);
    assert.equal(r.result, 'ok');
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.includes('/calls/cc-live/actions/ai_assistant_add_messages'), 'targets the right call leg');
    assert.equal(calls[0].body.messages.length, 1);
    assert.equal(calls[0].body.messages[0].role, 'system');
    assert.equal(calls[0].body.messages[0].content, 'This is a VIP, comp the blowout');
  } finally { globalThis.fetch = realFetch; }
});

test('surfaces an ended-call rejection honestly instead of silently succeeding', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    ({ ok: false, status: 400, json: async () => ({ errors: [{ detail: 'Call not in progress or already ended.' }] }) });
  try {
    const r = await injectWhisper({ callControlId: 'cc-dead', message: 'hello', telnyxKey: 'sk-test' });
    assert.equal(r.ok, undefined);
    assert.equal(r.status, 400);
    assert.match(r.error, /ended/i);
  } finally { globalThis.fetch = realFetch; }
});

test('never calls out when Telnyx is not configured', async () => {
  const r = await injectWhisper({ callControlId: 'cc-live', message: 'hello', telnyxKey: '' });
  assert.equal(r.status, 503);
  assert.match(r.error, /not configured/i);
});