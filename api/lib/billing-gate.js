/**
 * api/lib/billing-gate.js — trial-to-paid enforcement (the hard paywall).
 * ════════════════════════════════════════════════════════════════════
 * One gate, every booking path. Both booking stacks import this:
 *   • booking-brain runBookingAction (MCP voice, operator-tools, web tools)
 *   • lola-tools SKILLS (the legacy Telnyx AI-assistant skill layer)
 *
 * RULE (shares lib/service-gate.js for everything but the trial):
 *   A tenant is BLOCKED from creating new bookings when:
 *     • billing_status === 'suspended'            (admin action)
 *     • subscription_status === 'canceled'        (subscription ended, paid period over)
 *     • subscription_status === 'past_due' for MORE than 7 days (Stripe retries
 *       for days — one failed card never pauses a salon on the spot)
 *     • subscription_status === 'unpaid' / 'incomplete_expired'
 *     • trial_ends_at is set AND in the past AND no active subscription
 *   A tenant is ALLOWED when:
 *     • billing_status === 'active'  (admin "Activate" = comped / paid offline)
 *     • subscription_status === 'active', 'trialing' or 'canceling' (paid through period end)
 *     • trial_ends_at is null (legacy tenant — never given a window)
 *     • trial_ends_at is still in the future
 *     • no billing fields at all (demo tenant)
 *
 * Deliberately SAFE BY DEFAULT: a tenant with no trial_ends_at is never
 * blocked, so existing production tenants (created before the column) and
 * the demo salon keep working. Only an explicit, past expiry date (or an
 * explicit canceled/suspended/past_due status) triggers the paywall.
 *
 * The response carries two messages:
 *   • callerSpeak — what a CLIENT hears (graceful, never reveals billing)
 *   • ownerSpeak  — what the OWNER/operator hears (drives conversion)
 */

import { rawServiceStatus as serviceStatus } from './service-gate.js';

export const BLOCKED_BOOKING_ACTIONS = new Set([
  'book_appointment',
  'check_availability',
  'reschedule_appointment'
]);

// cancel_appointment is deliberately NOT gated: cancelling frees a slot and
// never creates new revenue, so blocking it would only strand clients.

function callerLine(){
  return "I'm sorry — the salon isn't taking new bookings online right now. Please reach out to the salon directly and they'll take care of you.";
}

export function billingGate(tenant){
  if(!tenant || !tenant.id) return { blocked: false };

  const sub = String(tenant.subscription_status || '').toLowerCase();
  const billing = String(tenant.billing_status || '').toLowerCase();

  if(billing === 'suspended'){
    return {
      blocked: true, reason: 'suspended', hard: true,
      callerSpeak: callerLine(),
      ownerSpeak: "Your LolaDesk account has been suspended, so I've paused new bookings. Contact support to reactivate."
    };
  }
  // Admin "Activate" (comped / paid offline) lifts the paywall, whatever Stripe says.
  if(billing === 'active' || billing === 'comped') return { blocked: false };

  // Everything Stripe-driven follows the shared service gate (7-day past_due grace,
  // canceled only after the paid period, unpaid).
  if(sub && sub !== 'trial' && sub !== 'incomplete'){
    const s = serviceStatus(tenant);
    if(s.ok) return { blocked: false, grace: !!s.grace };
    const pastDue = s.reason === 'unpaid';
    return {
      blocked: true, reason: pastDue ? 'past_due' : 'canceled', hard: true,
      callerSpeak: callerLine(),
      ownerSpeak: pastDue
        ? "Your payment didn't go through, so I've paused new bookings. Update your billing to keep Lola taking appointments."
        : "Your LolaDesk subscription has ended. I've paused new bookings — resubscribe to keep Lola taking appointments."
    };
  }

  // LolaDesk trial: only block on an explicit, past trial_ends_at.
  if(tenant.trial_ends_at){
    const end = new Date(tenant.trial_ends_at).getTime();
    if(!Number.isNaN(end) && end < Date.now()){
      return {
        blocked: true, reason: 'trial_expired', hard: false,
        callerSpeak: callerLine(),
        ownerSpeak: "Your LolaDesk trial has ended, so I've paused new bookings. Pick a plan and I'll be right back to taking appointments."
      };
    }
  }
  return { blocked: false };
}

/**
 * One-call helper for booking paths: returns a ready-to-return blocked
 * response (null when the tenant may book). ALWAYS ON — independent of
 * BILLING_ENFORCE — so every booking path (voice tools, widget, MCP,
 * telnyx-book-tool, widget/book) refuses canceled / unpaid / expired salons. `channel` picks the message:
 * 'operator' → ownerSpeak (conversion), anything else → callerSpeak.
 */
export function bookingGateResponse(tenant, channel = 'voice'){
  const gate = billingGate(tenant);
  if(!gate.blocked) return null;
  const isOwner = channel === 'operator';
  const speak = isOwner ? gate.ownerSpeak : gate.callerSpeak;
  return {
    ok: false,
    blocked: true,
    reason: gate.reason,
    hard: gate.hard,
    needs: 'upgrade',
    upgrade: true,
    speak,
    text: speak
  };
}

export default { billingGate, bookingGateResponse, BLOCKED_BOOKING_ACTIONS };
