/**
 * /api/billing/webhook — legacy URL, same robust handler as /api/stripe-webhook.
 *
 * If your Stripe dashboard points here instead of /api/stripe-webhook, this
 * re-export means it still gets the full pipeline: signature verification,
 * idempotency, Telnyx auto-provisioning on checkout.session.completed, and
 * subscription lifecycle handling.
 */
export { config, default } from '../stripe-webhook.js';
