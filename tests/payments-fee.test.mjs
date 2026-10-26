/**
 * tests/payments-fee.test.mjs — LolaDesk's fee on deposits and no-show fees.
 *
 * Run:
 *   node --test tests/payments-fee.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.STRIPE_SECRET_KEY = 'sk_test_x';
const sent = [];
globalThis.fetch = async (url, init = {}) => {
  sent.push({ url: String(url), body: String(init.body || '') });
  return { ok: true, status: 200, json: async () => ({ id: 'plink_1', url: 'https://buy.stripe.com/x' }) };
};

const { paymentsFee, feeFor, feeLabel } = await import('../api/lib/payments-fee.js');
const { createPaymentLink } = await import('../api/lib/stripe.js');

test('off by default: no fee, no label', () => {
  const p = paymentsFee({});
  assert.equal(p.on, false);
  assert.equal(feeFor(10000, p), 0);
  assert.equal(feeLabel(p), '');
});

test('3.4% + 30¢: covers Stripe and leaves LolaDesk a margin', () => {
  const p = paymentsFee({ PAYMENTS_FEE_PERCENT: '3.4', PAYMENTS_FEE_CENTS: '30' });
  assert.equal(feeFor(5000, p), 200);   // $50 deposit → $2.00
  assert.equal(feeFor(10000, p), 370);  // $100 → $3.70
  assert.equal(feeLabel(p), '3.4% + 30¢ per payment');
});

test('never more than half a tiny payment; nonsense settings are ignored', () => {
  const p = paymentsFee({ PAYMENTS_FEE_PERCENT: '3.4', PAYMENTS_FEE_CENTS: '30' });
  assert.equal(feeFor(50, p), 25);
  assert.equal(paymentsFee({ PAYMENTS_FEE_PERCENT: 'abc', PAYMENTS_FEE_CENTS: '-5' }).on, false);
  assert.equal(paymentsFee({ PAYMENTS_FEE_PERCENT: '90' }).percent, 15);
});

test('deposit link carries the fee only when it is set, and only to a connected salon', async () => {
  delete process.env.PAYMENTS_FEE_PERCENT; delete process.env.PAYMENTS_FEE_CENTS;
  sent.length = 0;
  await createPaymentLink({ amountCents: 5000, description: 'Deposit', destination: 'acct_salon' });
  assert.doesNotMatch(sent[0].body, /application_fee_amount/);

  process.env.PAYMENTS_FEE_PERCENT = '3.4'; process.env.PAYMENTS_FEE_CENTS = '30';
  sent.length = 0;
  await createPaymentLink({ amountCents: 5000, description: 'Deposit', destination: 'acct_salon' });
  assert.match(sent[0].body, /application_fee_amount=200/);
  assert.match(sent[0].body, /transfer_data%5Bdestination%5D=acct_salon/);

  sent.length = 0;
  await createPaymentLink({ amountCents: 5000, description: 'Deposit', destination: null });
  assert.doesNotMatch(sent[0].body, /application_fee_amount/);
  delete process.env.PAYMENTS_FEE_PERCENT; delete process.env.PAYMENTS_FEE_CENTS;
});
