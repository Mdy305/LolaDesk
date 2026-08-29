/**
 * tests/signup-timeout.test.mjs — the signup step time-bound.
 *
 * Run:
 *   node tests/signup-timeout.test.mjs
 *
 * Proves the bounded path: a fast Supabase call resolves normally, while a
 * hanging one (Supabase Auth unresponsive, as seen in production) rejects
 * with the recognizable AUTH_TIMEOUT signal after the budget — so the signup
 * handler returns a fast 503 (see handler's catch) instead of stalling to
 * FUNCTION_INVOCATION_TIMEOUT.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  withBudget, AUTH_TIMEOUT_CODE, SIGNUP_STEP_BUDGET_MS
} from '../api/auth/signup.js';

test('withBudget resolves a fast call with its value', async () => {
  const out = await withBudget(Promise.resolve(42), 'create-user');
  assert.equal(out, 42);
});

test('withBudget rejects with AUTH_TIMEOUT when the upstream hangs', async () => {
  const t0 = Date.now();
  await assert.rejects(
    () => withBudget(new Promise(() => {}), 'sign-in'), // never settles
    (e) => e?.code === AUTH_TIMEOUT_CODE && /timed out/.test(e.message)
  );
  // It fired at ~budget, not after the invocation limit.
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= SIGNUP_STEP_BUDGET_MS - 200, `fired early: ${elapsed}ms`);
  assert.ok(elapsed < SIGNUP_STEP_BUDGET_MS + 5000, `too slow: ${elapsed}ms`);
});

test('an already-settled rejection propagates its original error (not a timeout)', async () => {
  await assert.rejects(
    () => withBudget(Promise.reject(new Error('already registered')), 'create-user'),
    /already registered/
  );
});