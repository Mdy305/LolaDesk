/**
 * api/lib/payments-fee.js — LolaDesk's fee on money a salon collects through LolaDesk.
 * ════════════════════════════════════════════════════════════════════
 * Deposits, no-show fees and saved-card charges are destination charges:
 * Stripe takes its processing fee (≈2.9% + 30¢) from LOLADESK's balance, and
 * the full amount goes to the salon. With no fee set, every deposit costs
 * LolaDesk money. The application fee below covers Stripe and leaves a margin.
 *
 *   PAYMENTS_FEE_PERCENT   e.g. 3.4   (% of each payment)
 *   PAYMENTS_FEE_CENTS     e.g. 30    (flat per payment)
 *
 * Both unset (the default) → no fee: exactly how it works today. The salon
 * sees the rate on the Payments page before they turn payments on.
 */
export function paymentsFee(env = process.env) {
  const n = (v) => { const x = Number(String(v ?? '').trim()); return Number.isFinite(x) && x > 0 ? x : 0; };
  const percent = Math.min(n(env.PAYMENTS_FEE_PERCENT), 15);
  const cents = Math.round(Math.min(n(env.PAYMENTS_FEE_CENTS), 500));
  return { on: percent > 0 || cents > 0, percent, cents };
}

/** LolaDesk's fee on one payment, in cents. Never more than half the payment. */
export function feeFor(amountCents, policy = paymentsFee()) {
  const amt = Math.max(0, Math.round(Number(amountCents) || 0));
  if (!policy.on || !amt) return 0;
  const fee = Math.round(amt * policy.percent / 100) + policy.cents;
  return Math.min(fee, Math.floor(amt / 2));
}

/** "3.4% + 30¢ per payment" — the line salons see. '' when off. */
export function feeLabel(policy = paymentsFee()) {
  if (!policy.on) return '';
  const parts = [];
  if (policy.percent) parts.push(`${+policy.percent.toFixed(2)}%`);
  if (policy.cents) parts.push(`${policy.cents}¢`);
  return parts.join(' + ') + ' per payment';
}
