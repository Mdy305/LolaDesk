/**
 * tests/sync-alerts.test.mjs — the booking-sync alerting cron.
 *
 * Run:
 *   node tests/sync-alerts.test.mjs
 *
 * Exercises the REAL /api/cron/sync-alerts handler against the in-memory fake
 * DB: error/stale detection (>1h), cooldown dedup via sync_alert_log, and
 * recovery clearing. Email/Slack senders are injected so nothing hits the
 * network.
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
  '// Generated test double — see tests/sync-alerts.test.mjs',
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

const { default: handler, detectSyncAlerts, notifyOperator, __setSenders } = await import('../api/cron/sync-alerts.js');

const T1 = '11111111-1111-1111-1111-111111111111';
const T2 = '22222222-2222-2222-2222-222222222222';
const T3 = '33333333-3333-3333-3333-333333333333';

function seed(now){
  fake.reset();
  const iso = ms => new Date(now - ms).toISOString();
  fake.seed('tenants', [
    { id: T1, slug: 'salon-a', name: 'Salon A', owner_email: 'a@example.com' },
    { id: T2, slug: 'salon-b', name: 'Salon B', owner_email: 'b@example.com' },
    { id: T3, slug: 'salon-c', name: 'Salon C', owner_email: 'c@example.com' }
  ]);
  fake.seed('booking_sync_log', [
    // T1: erroring for 2h — latest run failed, last good run 2h ago -> ALERT
    { tenant_id: T1, provider: 'vagaro', error_message: '401 unauthorized', created_at: iso(5 * 60000) },
    { tenant_id: T1, provider: 'vagaro', error_message: null, created_at: iso(2 * 3600000) },
    // T2: healthy — latest run 5m ago, no error -> no alert
    { tenant_id: T2, provider: 'square', error_message: null, created_at: iso(5 * 60000) },
    // T3: stale — last sync 3h ago, no error -> ALERT (stale)
    { tenant_id: T3, provider: 'fresha', error_message: null, created_at: iso(3 * 3600000) }
  ]);
  fake.seed('sync_alert_log', []);
}

function call(req){
  const res = {};
  res.statusCode = 200;
  res._json = null;
  res.setHeader = () => {};
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => { res._json = obj; return res; };
  return handler(req, res).then(() => ({ status: res.statusCode, json: res._json }));
}

test('detection flags tenants erroring or stale for over an hour', async () => {
  const now = Date.now();
  seed(now);
  const { ok, alerts } = await detectSyncAlerts(fake, { now });
  assert.equal(ok, true);

  const byId = Object.fromEntries(alerts.map(a => [a.tenant_id, a]));
  assert.equal(byId[T1].type, 'error');          // erroring > 1h
  assert.equal(byId[T3].type, 'stale');          // stale (last sync 3h ago)
  assert.equal(byId[T2], undefined);             // healthy — no alert
});

test('a fresh error (under an hour) is NOT alerted yet', async () => {
  const now = Date.now();
  seed(now);
  // Overwrite T1's error run to be 10 minutes old with NO prior good run in the hour.
  fake.seed('booking_sync_log', [
    { tenant_id: T1, provider: 'vagaro', error_message: '401', created_at: new Date(now - 10 * 60000).toISOString() },
    { tenant_id: T2, provider: 'square', error_message: null, created_at: new Date(now - 5 * 60000).toISOString() },
    { tenant_id: T3, provider: 'fresha', error_message: null, created_at: new Date(now - 3 * 3600000).toISOString() }
  ]);
  const { alerts } = await detectSyncAlerts(fake, { now });
  const ids = new Set(alerts.map(a => a.tenant_id));
  assert.ok(!ids.has(T1), 'fresh error under 1h must not alert');
  assert.ok(ids.has(T3), 'stale tenant still alerts');
});

test('handler notifies once and dedups within the cooldown', async () => {
  const now = Date.now();
  seed(now);
  process.env.CRON_SECRET = 'cron-secret';
  process.env.ALERT_EMAIL = 'ops@loladesk.com';
  process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/test';

  const sent = [];
  __setSenders({
    email: async (to, subject, body) => { sent.push({ to, subject, body }); return { ok: true }; },
    slack: async (text) => { sent.push({ slack: text }); return { ok: true }; }
  });

  try{
    // First run: both T1 (error) and T3 (stale) alert, each on email + Slack.
    let r = await call({ method: 'GET', headers: { authorization: 'Bearer cron-secret' } });
    assert.equal(r.status, 200);
    assert.equal(r.json.detected, 2);
    assert.equal(r.json.notified, 2);
    assert.equal(sent.length, 4);   // 2 alerts × 2 channels
    assert.equal(fake.all('sync_alert_log').length, 2);

    // Second run immediately after: cooldown suppresses both.
    sent.length = 0;
    r = await call({ method: 'GET', headers: { authorization: 'Bearer cron-secret' } });
    assert.equal(r.json.detected, 2);
    assert.equal(r.json.notified, 0);
    assert.equal(sent.length, 0);
  }finally{
    __setSenders(null);
    delete process.env.SLACK_WEBHOOK_URL;
  }
});

test('recovery clears alert rows so a future flip alerts fresh', async () => {
  const now = Date.now();
  seed(now);
  process.env.CRON_SECRET = 'cron-secret';
  process.env.ALERT_EMAIL = 'ops@loladesk.com';
  process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/test';
  __setSenders({ email: async () => ({ ok: true }), slack: async () => ({ ok: true }) });

  try{
    // Alert once (T1 + T3).
    await call({ method: 'GET', headers: { authorization: 'Bearer cron-secret' } });
    assert.equal(fake.all('sync_alert_log').length, 2);

    // Now T1 and T3 recover (healthy runs 5m ago).
    const iso = ms => new Date(now - ms).toISOString();
    fake.seed('booking_sync_log', [
      { tenant_id: T1, provider: 'vagaro', error_message: null, created_at: iso(5 * 60000) },
      { tenant_id: T2, provider: 'square', error_message: null, created_at: iso(5 * 60000) },
      { tenant_id: T3, provider: 'fresha', error_message: null, created_at: iso(5 * 60000) }
    ]);

    await call({ method: 'GET', headers: { authorization: 'Bearer cron-secret' } });
    assert.equal(fake.all('sync_alert_log').length, 0, 'recovered tenants must have alert rows cleared');
  }finally{
    __setSenders(null);
    delete process.env.SLACK_WEBHOOK_URL;
  }
});

test('handler is CRON_SECRET guarded', async () => {
  seed(Date.now());
  delete process.env.CRON_SECRET;
  let r = await call({ method: 'GET', headers: {} });
  assert.equal(r.status, 503);   // no CRON_SECRET -> disabled

  process.env.CRON_SECRET = 'cron-secret';
  r = await call({ method: 'GET', headers: { authorization: 'Bearer wrong' } });
  assert.equal(r.status, 401);   // bad secret -> unauthorized
});

test('notifyOperator reports missing channels', async () => {
  const before = process.env.ALERT_EMAIL;
  delete process.env.ALERT_EMAIL;
  delete process.env.ADMIN_EMAILS;
  delete process.env.SLACK_WEBHOOK_URL;
  const n = await notifyOperator('test alert', { senders: {} });
  assert.equal(n.sent, false);
  assert.ok(n.errors.some(e => /no notification channel/i.test(e)));
  if(before !== undefined) process.env.ALERT_EMAIL = before;
});
