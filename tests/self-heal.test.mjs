/**
 * tests/self-heal.test.mjs — the runtime self-heal bundles + the applier's
 * loud missing-secrets fence.
 *
 * Run:
 *   node tests/self-heal.test.mjs
 *   node --test tests/
 *
 * Background (proven live on production, 2026-09-16): the CI apply job ran
 * with placeholder Supabase secrets and exited 0 on "credentials absent", so
 * NO migration ever reached the production DB — migrations_ledger itself was
 * never created, and 20260831_mfa_totp.sql + 20260901_customer_care.sql never
 * landed. Owner 2FA enrollment failed with a PostgREST schema-cache error
 * behind a green health board. Proves here that:
 *
 *   • ensureMigrations() self-heals missing mfa_registrations and
 *     platform_settings through exec_sql (idempotent, matches the
 *     migrations' DDL exactly);
 *   • a second run is a no-op (tables present ⇒ nothing re-applied);
 *   • exec_sql being unavailable degrades without throwing;
 *   • the direct applier now FAILS (exit 1) when its secrets are absent
 *     instead of green-skipping;
 *   • the two consumers (mfa + customer-care endpoints) fire the self-heal.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeSupabase } from './fake-supabase.js';

// Stub @supabase/supabase-js so api/lib/db.js uses the fake (same pattern as
// tests/google-gmb.test.mjs).
const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STUB_DIR = join(API_ROOT, 'node_modules', '@supabase', 'supabase-js');
mkdirSync(STUB_DIR, { recursive: true });
writeFileSync(join(STUB_DIR, 'package.json'), JSON.stringify({
  name: '@supabase/supabase-js', version: '0.0.0-test', type: 'module',
  main: 'index.js', exports: { '.': './index.js' }
}, null, 2));
writeFileSync(join(STUB_DIR, 'index.js'), [
  '// Generated test double — see tests/self-heal.test.mjs',
  'export function createClient() {',
  "  const fake = globalThis.__LOLA_FAKE_SUPABASE__;",
  "  if (!fake) throw new Error('No fake Supabase registered');",
  '  return fake;',
  '}', ''
].join('\n'));

const fake = new FakeSupabase();
globalThis.__LOLA_FAKE_SUPABASE__ = fake;

process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'fake-service-key';

// exec_sql stand-in: records every DDL it is asked to run.
const execCalls = [];
fake._rpcImpl = (fnName, args) => {
  if (fnName !== 'exec_sql') return { data: null, error: { message: 'unexpected rpc ' + fnName } };
  execCalls.push(String(args?.p_sql || ''));
  return { data: [], error: null };
};

const { ensureMigrations, resetMigrations } = await import('../api/lib/migrate.js');

const MISSING = (table) => `Could not find the table 'public.${table}' in the schema cache`;

test('ensureMigrations self-heals the ledger-swallowed mfa + platform tables', async () => {
  // The exact production condition: both tables missing, the rest present.
  fake.failRead('mfa_registrations', MISSING('mfa_registrations'));
  fake.failRead('platform_settings', MISSING('platform_settings'));
  execCalls.length = 0;
  resetMigrations();

  const status = await ensureMigrations();
  assert.equal(status, 'applied');
  assert.equal(execCalls.length, 2, 'exactly two DDL bundles executed');
  const [mfa, settings] = execCalls;
  // DDL matches the shipped migrations verbatim (idempotent IF NOT EXISTS form).
  assert.match(mfa, /create table if not exists public\.mfa_registrations/);
  assert.match(mfa, /user_identifier text primary key/);
  assert.match(mfa, /verified\s+boolean not null default false/);
  assert.match(settings, /create table if not exists public\.platform_settings/);
  assert.match(settings, /value\s+jsonb not null default/);
});

test('ensureMigrations is a no-op once every table is present', async () => {
  fake.clearFailures();
  execCalls.length = 0;
  resetMigrations();

  const status = await ensureMigrations();
  assert.equal(status, 'up-to-date');
  assert.deepEqual(execCalls, [], 'no DDL when the schema is present');
});

test('ensureMigrations degrades without throwing when exec_sql is unavailable', async () => {
  fake.failRead('mfa_registrations', MISSING('mfa_registrations'));
  fake._rpcImpl = () => ({ data: null, error: { message: 'function public.exec_sql does not exist' } });
  resetMigrations();

  await assert.doesNotReject(() => ensureMigrations());
  // Restore the recording impl for later tests.
  fake._rpcImpl = (fnName, args) => {
    if (fnName !== 'exec_sql') return { data: null, error: { message: 'unexpected rpc ' + fnName } };
    execCalls.push(String(args?.p_sql || ''));
    return { data: [], error: null };
  };
});

test('the direct applier fails loudly when its secrets are absent', () => {
  const r = spawnSync(process.execPath, ['scripts/apply-migrations.mjs'], {
    cwd: API_ROOT,
    env: { ...process.env, SUPABASE_URL: '', SUPABASE_SERVICE_KEY: '', SUPABASE_SERVICE_ROLE_KEY: '' },
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(r.status, 1, 'exit 1 — never a green no-op');
  assert.match(String(r.stderr) + String(r.stdout), /FAILED.*SUPABASE_URL\/SUPABASE_SERVICE_KEY not set/);
});

test('the mfa and customer-care endpoints fire the self-heal', () => {
  const mfa = readFileSync(join(API_ROOT, 'api', 'auth', 'mfa.js'), 'utf8');
  const care = readFileSync(join(API_ROOT, 'api', 'customer-care.js'), 'utf8');
  assert.match(mfa, /import \{ ensureMigrations \} from '\.\.\/lib\/migrate\.js';/);
  assert.match(mfa, /await ensureMigrations\(\);/, 'mfa self-heals before first use');
  assert.match(care, /import \{ ensureMigrations \} from '\.\/lib\/migrate\.js';/);
  assert.match(care, /await ensureMigrations\(\);/, 'customer-care self-heals before first use');
});
