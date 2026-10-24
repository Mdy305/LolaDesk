/**
 * tests/referrals.test.mjs — give a month, get a month; the failed-card
 * notice; the invite line on a good week.
 *
 * Run:
 *   node --test tests/referrals.test.mjs
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
writeFileSync(join(STUB_DIR, 'package.json'), JSON.stringify({ name: '@supabase/supabase-js', version: '0.0.0-test', type: 'module', main: 'index.js', exports: { '.': './index.js' } }, null, 2));
writeFileSync(join(STUB_DIR, 'index.js'), "export function createClient(){const f=globalThis.__LOLA_FAKE_SUPABASE__;if(!f)throw new Error('No fake Supabase registered');return f;}\n");

const fake = new FakeSupabase();
globalThis.__LOLA_FAKE_SUPABASE__ = fake;
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'fake-service-key';
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '{}' });

const { recordReferral, creditReferral, referralLink, referralStatus, cleanRef, monthCents } = await import('../api/lib/referrals.js');
const { dunningNotice } = await import('../api/lib/billing-enforce.js');
const { receiptText } = await import('../api/lib/lola-receipt.js');

// A Stripe double that remembers idempotency keys, like the real one.
function fakeStripe() {
  const seen = new Map();
  const calls = [];
  const api = async (path, method, body, headers = {}) => {
    const k = headers['Idempotency-Key'];
    if (k && seen.has(k)) return seen.get(k);
    const res = { id: 'cbtxn_' + (calls.length + 1), path, ...body };
    calls.push({ path, method, body, key: k });
    if (k) seen.set(k, res);
    return res;
  };
  return { api, calls };
}

const MMA = { id: 'ref1', slug: 'mma-salon', name: 'MMA Salon', owner_email: 'm@mma.com', plan: 'pro', subscription_status: 'active', stripe_customer_id: 'cus_ref' };
const NEW = { id: 'new1', slug: 'bo-studio', name: 'Bo Studio', owner_email: 'bo@studio.com', plan: 'starter', stripe_customer_id: 'cus_new' };

test('links and refs are clean', () => {
  assert.equal(referralLink(MMA), 'https://www.loladesk.com/r/mma-salon');
  assert.equal(cleanRef(' MMA-Salon '), 'mma-salon');
  assert.equal(cleanRef('../../etc'), '');
  assert.equal(monthCents({ plan: 'pro' }), 39900);
  assert.equal(monthCents({ plan: 'starter', billing_interval: 'annual' }), 7900);
});

test('signup records the referrer once; never for yourself, an unknown link, or a reused trial', async () => {
  fake.reset();
  fake.seed('tenants', [MMA, NEW]);
  assert.equal((await recordReferral(fake, NEW, 'nope')).reason, 'unknown_ref');
  assert.equal((await recordReferral(fake, NEW, 'mma-salon', { trial: false })).reason, 'trial_already_used');
  assert.equal((await recordReferral(fake, { ...MMA, id: 'x' }, 'mma-salon')).reason, 'self');
  assert.equal((await recordReferral(fake, NEW, 'mma-salon')).recorded, true);
  assert.equal((await recordReferral(fake, NEW, 'mma-salon')).reason, 'already_recorded');
  const st = await referralStatus(fake, MMA);
  assert.equal(st.joined, 1);
});

test('first payment credits both salons a month of their own plan, exactly once', async () => {
  fake.reset();
  fake.seed('tenants', [MMA, NEW]);
  await recordReferral(fake, NEW, 'mma-salon');
  const s = fakeStripe();
  const told = [];
  const notify = async (t, text) => { told.push([t.id, text]); return { texted: true }; };

  const r1 = await creditReferral(fake, { ...NEW, subscription_status: 'active' }, { stripeApi: s.api, notify });
  assert.equal(r1.referee, true);
  assert.equal(r1.referrer, true);
  assert.deepEqual(s.calls.map((c) => [c.path, c.body.amount]), [
    ['/customers/cus_new/balance_transactions', -9900],
    ['/customers/cus_ref/balance_transactions', -39900],
  ]);
  assert.equal(told.length, 1);
  assert.match(told[0][1], /Bo Studio just joined LolaDesk through you\. Your next month is on us\./);

  // Next month's invoice: nothing more.
  const r2 = await creditReferral(fake, { ...NEW, subscription_status: 'active' }, { stripeApi: s.api, notify });
  assert.equal(r2.referee, false);
  assert.equal(s.calls.length, 2);
  assert.equal((await referralStatus(fake, MMA)).months_earned, 1);
});

test('a referrer who isn\'t paying yet gets the month when they first pay', async () => {
  fake.reset();
  const trialRef = { ...MMA, subscription_status: 'trial', stripe_customer_id: null };
  fake.seed('tenants', [trialRef, NEW]);
  await recordReferral(fake, NEW, 'mma-salon');
  const s = fakeStripe();
  const r = await creditReferral(fake, NEW, { stripeApi: s.api });
  assert.equal(r.pending, true);
  assert.equal(s.calls.length, 1); // only the new salon
  assert.equal((await referralStatus(fake, trialRef)).pending, 1);

  // The referrer subscribes and pays.
  const later = await creditReferral(fake, { ...trialRef, subscription_status: 'active', stripe_customer_id: 'cus_ref' }, { stripeApi: s.api });
  assert.equal(later.own_pending, 1);
  assert.equal(s.calls.at(-1).body.amount, -39900);
  const st = await referralStatus(fake, trialRef);
  assert.deepEqual([st.pending, st.months_earned], [0, 1]);
});

test('failed card: the owner hears once per invoice, with the day bookings pause', async () => {
  fake.reset();
  const t = { id: 't1', name: 'S', past_due_since: '2026-10-20T15:00:00Z' };
  const sent = [];
  const notify = async (_t, text) => { sent.push(text); return { texted: true }; };
  const a = await dunningNotice(fake, t, 'in_1', { notify, now: new Date('2026-10-20T15:00:00Z') });
  assert.equal(a.sent, true);
  assert.match(sent[0], /card didn't go through/);
  assert.match(sent[0], /pause new bookings on Tuesday, Oct 27/);
  assert.match(sent[0], /\/subscription$/);
  assert.equal((await dunningNotice(fake, t, 'in_1', { notify })).reason, 'already_told');
  assert.equal((await dunningNotice(fake, t, 'in_2', { notify })).sent, true);
  assert.equal(sent.length, 2);
});

test('the Monday text asks for a referral only after a good week', () => {
  const invite = 'https://www.loladesk.com/r/mma-salon';
  assert.doesNotMatch(receiptText({ answered: 9, booked: 2, value: 300 }, { invite }), /month free/);
  assert.match(receiptText({ answered: 41, booked: 12, value: 2340 }, { invite }), /Send them https:\/\/www\.loladesk\.com\/r\/mma-salon and you both get a month free\.$/);
});
