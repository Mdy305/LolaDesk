import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getUserFromToken } from '../api/lib/auth.js';

const KEYS = ['ALLOW_DEMO_TOKEN', 'VERCEL_ENV', 'NODE_ENV'];
function withEnv(kv, fn){
  const saved = {};
  for(const k of KEYS){ saved[k] = process.env[k]; }
  for(const k of KEYS){ if(kv[k] === undefined) delete process.env[k]; else process.env[k] = kv[k]; }
  try{ return fn(); }
  finally { for(const k of KEYS){ if(saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

test('demo_token authenticates the demo owner only in a NON-production deployment', async () => {
  const u = await withEnv(
    { ALLOW_DEMO_TOKEN: '1', VERCEL_ENV: 'preview', NODE_ENV: 'development' },
    () => getUserFromToken('demo_token')
  );
  assert.ok(u);
  assert.equal(u.email, 'meddy@mmasalon.com');
});

test('demo_token is REJECTED in production even when ALLOW_DEMO_TOKEN is misconfigured on', async () => {
  // Reproduces the current prod misconfiguration (ALLOW_DEMO_TOKEN=1) to prove
  // the code now locks the backdoor regardless of the env var.
  for(const prod of [{ VERCEL_ENV: 'production' }, { NODE_ENV: 'production' }]){
    const u = await withEnv(
      { ALLOW_DEMO_TOKEN: '1', ...prod },
      () => getUserFromToken('demo_token')
    );
    assert.equal(u, null, 'production must never honor demo_token');
  }
});

test('demo_token is rejected when the toggle is not explicitly enabled', async () => {
  const u = await withEnv(
    { ALLOW_DEMO_TOKEN: '0', VERCEL_ENV: 'preview' },
    () => getUserFromToken('demo_token')
  );
  assert.equal(u, null);
});