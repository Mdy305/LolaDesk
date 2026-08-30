/**
 * tests/trial-paywall.test.mjs — the trial-to-paid paywall banner.
 *
 * Run:
 *   node tests/trial-paywall.test.mjs
 *   node --test tests/
 *
 * Loads the REAL trial-paywall.js (a classic browser script) inside a
 * vm sandbox so its pure buildBanner() is exercised without a DOM, then
 * asserts every banner state: days-left, hard paywall after expiry,
 * past_due → update-card portal, canceled → reactivate, and the cases
 * that must stay silent (active, no Stripe, the subscription page).
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(API_ROOT, 'trial-paywall.js'), 'utf8');

function load(){
  const sandbox = { window: {} };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.window.LolaTrialPaywall.buildBanner;
}

const buildBanner = load();

function trialState(over = {}){
  return { ok:true, status:'trialing', plan:'starter', trial_days_left:7, stripe_configured:true, ...over };
}

test('exposes a testable buildBanner on window.LolaTrialPaywall', () => {
  assert.equal(typeof buildBanner, 'function');
});

test('trialing with days left shows the days-left banner with an upgrade checkout CTA', () => {
  const b = buildBanner(trialState({ trial_days_left: 7 }));
  assert.equal(b.visible, true);
  assert.equal(b.tone, 'default');
  assert.equal(b.dismissible, true);
  assert.match(b.title, /7 days left/);
  assert.equal(b.cta, 'Upgrade now');
  assert.equal(b.action, 'checkout');
  assert.equal(b.plan, 'starter');
});

test('single day reads "1 day left" (grammar)', () => {
  const b = buildBanner(trialState({ trial_days_left: 1 }));
  assert.match(b.title, /1 day left/);
});

test('three or fewer days left escalates to the warn tone', () => {
  assert.equal(buildBanner(trialState({ trial_days_left: 3 })).tone, 'warn');
  assert.equal(buildBanner(trialState({ trial_days_left: 0 })).tone, 'paywall');
});

test('deep-links checkout to the tenant\'s current plan (pro stays pro)', () => {
  const b = buildBanner(trialState({ plan:'pro' }));
  assert.equal(b.plan, 'pro');
});

test('expired trial shows the hard paywall, not dismissible, still upgrades', () => {
  const b = buildBanner(trialState({ trial_days_left: 0 }));
  assert.equal(b.visible, true);
  assert.equal(b.tone, 'paywall');
  assert.equal(b.dismissible, false);
  assert.match(b.title, /trial has ended/i);
  assert.match(b.copy, /paused new bookings/i);
  assert.equal(b.action, 'checkout');
});

test('past_due sends the owner to the billing portal to update the card', () => {
  const b = buildBanner(trialState({ status:'past_due' }));
  assert.equal(b.visible, true);
  assert.equal(b.tone, 'danger');
  assert.equal(b.cta, 'Update card');
  assert.equal(b.action, 'portal');
});

test('canceled offers reactivation through checkout', () => {
  const b = buildBanner(trialState({ status:'canceled' }));
  assert.equal(b.visible, true);
  assert.equal(b.cta, 'Reactivate');
  assert.equal(b.action, 'checkout');
});

test('active and canceling subscriptions stay silent', () => {
  assert.equal(buildBanner(trialState({ status:'active' })).visible, false);
  assert.equal(buildBanner(trialState({ status:'canceling' })).visible, false);
});

test('no Stripe configured → stay quiet (no broken upgrade path)', () => {
  assert.equal(buildBanner(trialState({ stripe_configured:false })).visible, false);
});

test('api error state never renders a banner', () => {
  assert.equal(buildBanner({ ok:false, error:'boom' }).visible, false);
  assert.equal(buildBanner(null).visible, false);
});

test('never renders on the subscription page (it has its own billing UI)', () => {
  assert.equal(buildBanner(trialState(), '/subscription.html').visible, false);
  assert.equal(buildBanner(trialState({ status:'past_due' }), 'subscription').visible, false);
});
