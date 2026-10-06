// The money side, end to end: one price list (the site's), checkout + in-place plan switches,
// one service gate for everything that costs money, numbers released, one trial per salon,
// costs in dollars, MRR + margin, fees that follow the booking, deposits that can't be paid twice.
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'tk';
process.env.STRIPE_SECRET_KEY = 'sk_test_x'; process.env.STRIPE_WEBHOOK_SECRET = 'whsec_acct'; process.env.STRIPE_CONNECT_WEBHOOK_SECRET = 'whsec_conn';
process.env.ADMIN_EMAILS = 'admin@loladesk.com'; process.env.APP_URL = 'https://www.loladesk.com'; process.env.CRON_SECRET = 'cron';
process.env.TELNYX_MESSAGING_PROFILE_ID = 'mp-1';
for (const k of ['BILLING_ENFORCE', 'REQUIRE_EMAIL_CONFIRMATION', 'BOOKING_FEES_LIVE', 'STRIPE_PRICE_STARTER', 'STRIPE_PRICE_PRO', 'STRIPE_PRICE_MEDSPA', 'STRIPE_PRICE_PRO_MONTHLY', 'STRIPE_PRICE_MEDSPA_ANNUAL', 'SENDGRID_API_KEY']) delete process.env[k];
process.env.BILLING_ENFORCE = '1'; process.env.RELEASE_NUMBERS_LIVE = '1'; // the money autopilot ON for these checks (off → see the switch checks)
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';

const stripeCalls = [], texts = [], telnyx = [];
const stripeState = { subs: {}, pis: {} };
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
const form = (b) => { const o = {}; for (const [k, v] of new URLSearchParams(String(b || ''))) o[k] = v; return o; };
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), m = (init.method || 'GET').toUpperCase();
  if (/api\.stripe\.com/.test(u)) {
    const body = form(init.body); stripeCalls.push({ u, m, body, headers: init.headers || {} });
    const path = u.replace(/^https:\/\/api\.stripe\.com\/v1/, '');
    if (path === '/checkout/sessions') return J({ id: 'cs_1', url: 'https://checkout.stripe.com/c/cs_1' });
    if (path === '/customers') return J({ id: 'cus_new' });
    let mm;
    if ((mm = path.match(/^\/subscriptions\/([^/?]+)$/))) {
      const s = stripeState.subs[decodeURIComponent(mm[1])] || { id: mm[1], status: 'active', items: { data: [{ id: 'si_1', price: { id: 'price_x', product: 'prod_lola', unit_amount: 9900, recurring: { interval: 'month' } } }] } };
      if (m === 'POST') { s.updated = body; return J({ ...s, status: s.status }); }
      return J(s);
    }
    if ((mm = path.match(/^\/payment_intents\/([^/?]+)$/))) return J(stripeState.pis[mm[1]] || { id: mm[1] });
    if (path === '/refunds') return J({ id: 're_' + stripeCalls.length, payment_intent: body.payment_intent });
    if (/^\/payment_links/.test(path)) return J({ id: 'plink_new', url: 'https://buy.stripe.com/x', active: body.active !== 'false' });
    if (path === '/invoiceitems') return J({ id: 'ii_' + stripeCalls.length });
    if (path === '/invoices') return J({ id: 'in_1' });
    if (/^\/invoices\/in_1\/finalize/.test(path)) return J({ id: 'in_1', status: 'open' });
    return J({});
  }
  if (/telnyx\.com/.test(u)) {
    let body = null; try { body = JSON.parse(init.body || 'null'); } catch (_) {}
    telnyx.push({ u, m, body });
    if (/\/v2\/messages/.test(u)) { texts.push(body); return J({ data: { id: 'msg' } }); }
    if (/available_phone_numbers/.test(u)) return J({ data: [{ phone_number: '+13055557777' }] });
    return J({ data: [] });
  }
  return J({ data: [] });
};

const { T } = await import('./fake-supabase.mjs');
const P = new URL('../../api/', import.meta.url).href;
const Stripe = (await import('stripe')).default;
const sx = new Stripe('sk_test_x');
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const DAY = 864e5, now = Date.now(), iso = (ms) => new Date(ms).toISOString();
const run = async (mod, { method = 'POST', headers = {}, body = {}, query = {} } = {}) => { const h = (await import(P + mod)).default; return new Promise((resolve) => { const res = { statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(o) { resolve({ status: this.statusCode, ...o }); }, end() { resolve({ status: this.statusCode }); } }; h({ method, url: '/api/' + mod, headers, query, body }, res); }); };

// ══ 1. One price list — the site's ══
const plans = await import(P + 'lib/plans.js');
ok(plans.PLANS.starter.monthlyCents === 9900 && plans.PLANS.pro.monthlyCents === 39900 && plans.PLANS.medspa.monthlyCents === 59900, 'monthly: $99 / $399 / $599');
ok(plans.chargeCents('starter', 'annual') === 94800 && plans.chargeCents('pro', 'annual') === 382800 && plans.chargeCents('medspa', 'annual') === 574800, 'annual billed yearly = 12 × $79 / $319 / $479');
const html = readFileSync(new URL('../../pricing.html', import.meta.url), 'utf8');
ok([['99', '79'], ['399', '319'], ['599', '479']].every(([m, y]) => html.includes(`data-m="${m}" data-y="${y}"`)), 'pricing.html shows exactly the plans.js prices');
ok(plans.normalizePlan('scale') === 'medspa' && plans.normalizePlan('Solo') === 'starter' && plans.normalizePlan('med-spa') === 'medspa' && plans.normalizePlan('nope') === null, 'legacy names map (scale → medspa, solo → starter)');
let li = plans.lineItemFor('medspa', 'annual');
ok(li.price_data.unit_amount === 574800 && li.price_data.recurring.interval === 'year', 'no env price → inline price_data at the advertised annual amount');
process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_pro_m';
ok(plans.lineItemFor('pro', 'monthly').price === 'price_pro_m', 'env price id wins when set');
ok(plans.planFromPrice('price_pro_m')?.plan === 'pro', 'webhook maps an env price id → plan');
delete process.env.STRIPE_PRICE_PRO_MONTHLY;
ok(plans.planFromPrice({ id: 'price_rand', unit_amount: 382800, recurring: { interval: 'year' } })?.plan === 'pro' && plans.planFromPrice({ unit_amount: 382800, recurring: { interval: 'year' } }).interval === 'annual', 'inline prices map by amount + interval');
ok(plans.planFromPrice({ unit_amount: 39700, recurring: { interval: 'month' } })?.plan === 'medspa', 'old $397 "Scale" subscriptions map to Med-Spa');
ok(plans.mrrCents('pro', 'annual') === 31900 && plans.numberLimit('medspa') === 2 && plans.numberLimit('starter') === 1, 'MRR counts annual at its monthly price; Med-Spa includes 2 lines');

// ══ 2. One service gate ══
const { serviceAllowed, serviceStatus } = await import(P + 'lib/service-gate.js');
const g = (t) => serviceStatus({ id: 'x', ...t });
ok(g({ subscription_status: 'active' }).ok && g({ subscription_status: 'trialing' }).ok, 'active / Stripe trial → on');
ok(g({ subscription_status: 'trial', trial_ends_at: iso(now + DAY) }).ok && g({ subscription_status: 'trial', trial_ends_at: iso(now - 2 * DAY) }).ok, 'trial, and 3-day grace after it → on');
ok(g({ subscription_status: 'trial', trial_ends_at: iso(now - 4 * DAY) }).reason === 'trial_expired', 'trial over + grace → off (trial_expired)');
ok(g({ subscription_status: 'past_due', past_due_since: iso(now - 3 * DAY) }).ok && g({ subscription_status: 'past_due', past_due_since: iso(now - 8 * DAY) }).reason === 'unpaid', 'past_due: 7-day grace while Stripe retries, then off (unpaid)');
ok(g({ subscription_status: 'canceled', current_period_end: iso(now + 5 * DAY) }).ok && g({ subscription_status: 'canceled', current_period_end: iso(now - DAY) }).reason === 'canceled', 'canceled: on until the paid period ends');
ok(g({ subscription_status: 'canceling', current_period_end: iso(now + DAY) }).ok && g({ subscription_status: 'unpaid' }).reason === 'unpaid', 'canceling on; unpaid off');
ok(g({ billing_status: 'active', subscription_status: 'canceled' }).ok && g({ billing_status: 'suspended', subscription_status: 'active' }).reason === 'suspended', 'admin Activate = paid; Suspend = off');
ok((await serviceAllowed(null)).ok && (await serviceAllowed({})).ok && (await serviceAllowed('missing-id')).ok, 'missing data → on (never throws)');
ok(typeof g({ subscription_status: 'canceled' }).say === 'string' && !/bill|pay|trial|subscri/i.test(g({ subscription_status: 'canceled' }).say), 'client-facing sentence never mentions billing');

const { billingGate, bookingGateResponse } = await import(P + 'lib/billing-gate.js');
ok(!billingGate({ id: 'x', subscription_status: 'past_due', past_due_since: iso(now - DAY) }).blocked, 'one failed payment never blocks bookings while Stripe retries');
ok(billingGate({ id: 'x', subscription_status: 'past_due', past_due_since: iso(now - 9 * DAY) }).blocked, '…but 7 days later it does');
ok(!billingGate({ id: 'x', billing_status: 'active', subscription_status: 'trial', trial_ends_at: iso(now - 30 * DAY) }).blocked, 'admin-activated salon books past its trial (paywall lifted)');
const { gateNewBooking } = await import(P + 'lib/billing-enforce.js'); delete process.env.BILLING_ENFORCE;
ok(gateNewBooking({ id: 'x', subscription_status: 'canceled', current_period_end: iso(now - DAY) }) && gateNewBooking({ id: 'x', subscription_status: 'trial', trial_ends_at: iso(now - 10 * DAY) }), 'switch OFF: canceled / long-expired salons still can’t book');
ok(!gateNewBooking({ id: 'x', subscription_status: 'trial', trial_ends_at: iso(now - DAY) }), 'switch OFF: a trial inside its 3-day grace still books');
{ const sg = await import(P + 'lib/service-gate.js'); ok(sg.serviceStatus({ id: 'x', subscription_status: 'trial', trial_ends_at: iso(now - 30 * DAY) }).ok === true && sg.serviceStatus({ id: 'x', billing_status: 'suspended' }).ok === false, 'switch OFF: an expired trial never silences calls and texts by surprise (only an admin suspension does)'); }
process.env.BILLING_ENFORCE = '1';
ok(bookingGateResponse({ id: 'x', subscription_status: 'canceled' }, 'voice')?.blocked === true, 'bookingGateResponse is always on (no BILLING_ENFORCE needed)');

// ══ 3. Checkout at the site's prices; switching never opens a second subscription ══
const A = 'aaaaaaaa-0000-4000-8000-000000000001', B = 'bbbbbbbb-0000-4000-8000-000000000002';
globalThis.__authUsers = { 'tok-a': { id: 'u-a', email: 'a@salon.com' }, 'tok-b': { id: 'u-b', email: 'b@salon.com' }, 'tok-admin': { id: 'u-adm', email: 'admin@loladesk.com' } };
const resetBilling = () => {
  T.tenants = [
    { id: A, slug: 'a', name: 'Salon A', owner_email: 'a@salon.com', plan: 'starter', subscription_status: 'trial', trial_ends_at: iso(now + 10 * DAY), created_at: iso(now - 4 * DAY) },
    { id: B, slug: 'b', name: 'Salon B', owner_email: 'b@salon.com', plan: 'starter', subscription_status: 'active', stripe_customer_id: 'cus_b', stripe_subscription_id: 'sub_b', created_at: iso(now - 90 * DAY) },
  ];
  T.tenant_users = [{ tenant_id: A, user_id: 'u-a', role: 'owner', status: 'active' }, { tenant_id: B, user_id: 'u-b', role: 'owner', status: 'active' }];
  T.usage_events = []; T.booking_fees = []; T.bookings = []; T.calls = [];
};
resetBilling();
let r = await run('billing.js', { headers: { authorization: 'Bearer tok-a' }, body: { action: 'checkout', plan: 'medspa', interval: 'annual' } });
let cs = stripeCalls.find((x) => /checkout\/sessions/.test(x.u));
ok(r.ok && r.url && cs && cs.body['line_items[0][price_data][unit_amount]'] === '574800' && cs.body['line_items[0][price_data][recurring][interval]'] === 'year', 'Med-Spa annual checkout charges $5,748/yr (not "Unknown plan", not $397)');
ok(cs.body['metadata[plan]'] === 'medspa' && cs.body['subscription_data[metadata][interval]'] === 'annual', 'plan + interval ride the subscription metadata');
ok(cs.body['subscription_data[trial_end]'], 'a salon subscribing mid-trial keeps its remaining free days');
stripeCalls.length = 0;
r = await run('billing.js', { headers: { authorization: 'Bearer tok-a' }, body: { action: 'checkout', plan: 'starter' } });
cs = stripeCalls.find((x) => /checkout\/sessions/.test(x.u));
ok(cs.body['line_items[0][price_data][unit_amount]'] === '9900' && cs.body['line_items[0][price_data][recurring][interval]'] === 'month', 'Starter monthly = $99');
r = await run('billing.js', { headers: { authorization: 'Bearer tok-a' }, body: { action: 'checkout', plan: 'platinum' } });
ok(r.status === 400 && /Unknown plan/.test(r.error), 'unknown plan refused');
stripeCalls.length = 0;
r = await run('billing.js', { headers: { authorization: 'Bearer tok-b' }, body: { action: 'checkout', plan: 'starter' } });
ok(r.ok && r.already_subscribed && r.url === '/subscription' && !stripeCalls.length, 'the trial banner’s “Upgrade” on a paying salon changes nothing — it opens the Billing page');
r = await run('billing.js', { headers: { authorization: 'Bearer tok-b' }, body: { action: 'switch', plan: 'pro' } });
const upd = stripeCalls.find((x) => x.m === 'POST' && /\/subscriptions\/sub_b$/.test(x.u));
ok(r.ok && r.switched && !stripeCalls.some((x) => /checkout\/sessions/.test(x.u)), '"Switch plan" on a paying salon updates its subscription — no second checkout');
ok(upd && upd.body['items[0][id]'] === 'si_1' && upd.body['items[0][price_data][unit_amount]'] === '39900' && upd.body.proration_behavior === 'create_prorations', 'same subscription item, Pro price, prorated');
ok(T.tenants[1].plan === 'pro', 'salon now on Pro');
T.usage_events = [
  { tenant_id: B, kind: 'voice_call', units: 1, created_at: iso(now) }, { tenant_id: B, kind: 'voice_call', units: 1, created_at: iso(now) },
  { tenant_id: B, kind: 'sms_sent', units: 3, created_at: iso(now) }, { tenant_id: B, kind: 'call_minute', units: 7, created_at: iso(now) },
];
T.bookings = [{ id: 'bk1', tenant_id: B, status: 'confirmed', created_at: iso(now) }, { id: 'bk2', tenant_id: B, status: 'cancelled', created_at: iso(now) }];
r = await run('billing.js', { method: 'GET', headers: { authorization: 'Bearer tok-b' }, query: { action: 'status' } });
ok(r.ok && r.usage.calls_handled === 2 && r.usage.sms_sent === 3 && r.usage.bookings_made === 1 && r.usage.minutes_used === 7, `usage comes from real events: ${JSON.stringify(r.usage)}`);
ok(r.has_subscription && r.plan === 'pro' && r.service.ok, 'status says: subscribed, Pro, service on');
r = await run('billing.js', { method: 'GET', query: { action: 'plans' } });
ok(r.plans.map((p) => p.id).join() === 'starter,pro,medspa' && r.plans[2].annual_cents === 574800, 'plans endpoint = the site’s three plans');

// ══ 4. Stripe webhook ══
const hook = (await import(P + 'stripe-webhook.js')).default;
let evn = 0;
function send(type, object, extra = {}) {
  const payload = JSON.stringify({ id: 'evt_mf_' + (++evn), type, data: { object }, ...extra });
  const header = sx.webhooks.generateTestHeaderString({ payload, secret: 'whsec_acct' });
  const req = Readable.from([Buffer.from(payload)]); req.method = 'POST'; req.headers = { 'stripe-signature': header };
  return new Promise((resolve) => { hook(req, { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(o) { resolve({ status: this.statusCode, body: o }); }, setHeader() {} }); });
}
resetBilling(); T.billing_events = [];
T.tenants[1].operator_phone = '+17865550123'; T.tenants[1].phone_number = '+13055550100';
await send('customer.subscription.updated', { id: 'sub_b', customer: 'cus_b', status: 'active', cancel_at_period_end: false, current_period_end: Math.floor((now + 300 * DAY) / 1000), metadata: {}, items: { data: [{ price: { id: 'price_rand', unit_amount: 382800, recurring: { interval: 'year' } } }] } });
ok(T.tenants[1].plan === 'pro' && T.tenants[1].billing_interval === 'annual', 'plan read from the subscription PRICE (no metadata) → Pro annual');
await send('invoice.payment_failed', { customer: 'cus_b', subscription: 'sub_b' });
const firstFail = T.tenants[1].past_due_since;
ok(T.tenants[1].subscription_status === 'past_due' && firstFail, 'failed payment → past_due, grace clock starts');
await send('invoice.payment_failed', { customer: 'cus_b', subscription: 'sub_b' });
ok(T.tenants[1].past_due_since === firstFail, 'Stripe retry failing again does not restart the grace clock');
await send('invoice.payment_succeeded', { customer: 'cus_b', subscription: 'sub_b' });
ok(T.tenants[1].subscription_status === 'active' && !T.tenants[1].past_due_since, 'paid → active, grace cleared');
await send('customer.subscription.updated', { id: 'sub_b', customer: 'cus_b', status: 'active', cancel_at_period_end: true, current_period_end: Math.floor((now + 20 * DAY) / 1000), items: { data: [{ price: { unit_amount: 382800, recurring: { interval: 'year' } } }] } });
await send('invoice.payment_succeeded', { customer: 'cus_b', subscription: 'sub_b' });
ok(T.tenants[1].subscription_status === 'canceling', 'a payment never overwrites a pending cancel');
texts.length = 0;
await send('customer.subscription.trial_will_end', { id: 'sub_b', customer: 'cus_b', trial_end: Math.floor((now + 3 * DAY) / 1000) });
ok(texts.some((t) => t.to === '+17865550123' && /trial ends/.test(t.text)), 'trial_will_end → the owner gets a text');
await send('customer.subscription.deleted', { id: 'sub_b', customer: 'cus_b', ended_at: Math.floor(now / 1000) });
ok(T.tenants[1].subscription_status === 'canceled' && T.tenants[1].canceled_at && !serviceStatus(T.tenants[1]).ok, 'deleted → canceled, service off now');

// deposits
T.deposits = [{ id: 'd1', tenant_id: A, booking_id: 'bkc', status: 'pending', stripe_payment_intent_id: 'plink_1' }, { id: 'd2', tenant_id: A, booking_id: 'bkok', status: 'pending', stripe_payment_intent_id: 'plink_2' }];
T.bookings = [{ id: 'bkc', tenant_id: A, status: 'cancelled' }, { id: 'bkok', tenant_id: A, status: 'confirmed' }];
stripeCalls.length = 0;
await send('checkout.session.completed', { mode: 'payment', payment_link: 'plink_2', payment_intent: 'pi_ok', amount_total: 2500 });
ok(T.deposits[1].status === 'paid' && T.deposits[1].stripe_payment_intent_id === 'pi_ok' && !stripeCalls.some((x) => /refunds/.test(x.u)), 'deposit for a live booking → paid, kept');
ok(stripeCalls.some((x) => /payment_links\/plink_2$/.test(x.u) && x.body.active === 'false'), 'its link is switched off after the payment');
await send('checkout.session.completed', { mode: 'payment', payment_link: 'plink_2', payment_intent: 'pi_second', amount_total: 2500, metadata: { kind: 'deposit', tenant_id: A } });
ok(stripeCalls.some((x) => /\/refunds$/.test(x.u) && x.body.payment_intent === 'pi_second'), 'a SECOND payment on a paid deposit is refunded automatically');
ok(T.usage_events.some((e) => e.kind === 'deposit_auto_refund' && e.metadata.reason === 'deposit_already_paid'), '…and logged');
stripeCalls.length = 0;
await send('checkout.session.completed', { mode: 'payment', payment_link: 'plink_1', payment_intent: 'pi_late' });
ok(stripeCalls.some((x) => /\/refunds$/.test(x.u) && x.body.payment_intent === 'pi_late') && T.deposits[0].status === 'refunded', 'paid after the booking was cancelled → refunded, deposit marked refunded');
await send('charge.dispute.created', { id: 'dp_1', payment_intent: 'pi_ok', amount: 2500, reason: 'fraudulent' });
ok(T.deposits[1].status === 'disputed' && T.usage_events.some((e) => e.kind === 'payment_disputed' && e.tenant_id === A), 'dispute → deposit at risk, logged, admin alerted');
await send('charge.refunded', { payment_intent: 'pi_ok', amount: 2500, amount_refunded: 2500, refunded: true });
ok(T.deposits[1].status === 'refunded', 'charge.refunded → deposit refunded');
r = await send('checkout.session.async_payment_failed', { mode: 'subscription', customer: 'cus_b', metadata: { tenant_id: B } });
ok(r.status === 200, 'async payment failure handled');

// payment links on the salon's connected account, one payment only
const { createPaymentLink, deactivatePaymentLink } = await import(P + 'lib/stripe.js');
T.stripe_connect_accounts = [{ tenant_id: A, stripe_account_id: 'acct_salon', charges_enabled: true }];
stripeCalls.length = 0;
const link = await createPaymentLink({ amountCents: 2500, description: 'Deposit', tenantId: A });
const lc = stripeCalls.find((x) => /\/payment_links$/.test(x.u));
ok(link.destination === 'acct_salon' && lc.body['transfer_data[destination]'] === 'acct_salon' && lc.body['restrictions[completed_sessions][limit]'] === '1', 'deposit link pays the salon (destination charge) and accepts one payment');
ok((await deactivatePaymentLink('plink_x')).ok, 'deactivatePaymentLink exposed');

// ══ 5. Booking fees follow the booking; waiver decided at the appointment; cancelled salons still pay ══
const fees = await import(P + 'lib/booking-fees.js');
const { db } = await import(P + 'lib/db.js'); const c = db();
resetBilling();
T.tenants[1].subscription_status = 'active';
T.booking_fees = [];
const bk = (id, o) => ({ id, tenant_id: B, source: 'voice', status: 'confirmed', total_amount: 80, start_time: iso(now + 5 * DAY), created_at: iso(now), ...o });
await fees.recordFee(c, T.tenants[1], bk('f1'));
await fees.moveFee('f1', iso(now + 40 * DAY));
const f1 = T.booking_fees.find((f) => f.booking_id === 'f1');
ok(f1.appointment_at === iso(now + 40 * DAY) && f1.period === iso(now + 40 * DAY).slice(0, 7), 'reschedule → the fee moves to the new time and month');
await fees.voidFee('f1', 'no_show');
ok(f1.status === 'void', 'voidFee(bookingId) works without a client handle');
// trial booking for an appointment after the salon subscribed → earned
T.tenants[0].subscription_status = 'trial';
T.bookings = [bk('f2', { tenant_id: A, start_time: iso(now - 2 * DAY), created_at: iso(now - 10 * DAY) })];
await fees.recordFee(c, T.tenants[0], T.bookings[0]);
ok(T.booking_fees.find((f) => f.booking_id === 'f2').status === 'waived', 'booked during the trial → provisionally waived');
T.tenants[0].subscription_status = 'active';
let out = await fees.runBookingFees(c, { policy: { ...fees.feePolicy({}), live: false } });
ok(T.booking_fees.find((f) => f.booking_id === 'f2').status === 'earned', 'the salon was paying when the appointment happened → earned (decided at settlement)');
// paging: more bookings than one page
T.bookings = []; T.booking_fees = [];
for (let i = 0; i < 1203; i++) T.bookings.push(bk('p' + String(i).padStart(5, '0'), { created_at: iso(now - DAY) }));
out = await fees.runBookingFees(c, { policy: { ...fees.feePolicy({}), live: false } });
ok(out.recorded === 1203, `sweep pages through every booking (${out.recorded}/1203), ordered`);
// cancelled salon: earned fees → final invoice now; canceling with time left → held
T.bookings = []; T.booking_fees = [
  { id: 'e1', tenant_id: B, booking_id: 'x1', status: 'earned', fee_cents: 100, appointment_at: iso(now - 3 * DAY) },
  { id: 'e2', tenant_id: A, booking_id: 'x2', status: 'earned', fee_cents: 100, appointment_at: iso(now - 3 * DAY) },
];
T.tenants[1].subscription_status = 'canceled'; T.tenants[1].stripe_customer_id = 'cus_b';
T.tenants[0].subscription_status = 'canceling'; T.tenants[0].stripe_customer_id = 'cus_a'; T.tenants[0].current_period_end = iso(now + 20 * DAY);
const billedTo = [], finals = [];
out = await fees.runBookingFees(c, { policy: { ...fees.feePolicy({}), live: true }, bill: async (t, l) => { billedTo.push(t.id); return { id: 'ii_' + t.id }; }, finalize: async (t) => { finals.push(t.id); return { id: 'in_' + t.id }; } });
ok(billedTo.includes(B) && finals.includes(B) && T.booking_fees.find((f) => f.id === 'e1').status === 'billed', 'cancelled salon: earned fees invoiced and finalized now');
ok(!billedTo.includes(A) && out.held === 1, 'canceling salon with weeks left: fees held for its final invoice');
ok(fees.billingMode({ subscription_status: 'canceling', current_period_end: iso(now + DAY) }) === 'final', '…and invoiced as the period ends');

// ══ 6. One trial per salon; per-IP brake persisted; no number at sign-up ══
const users = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url)); const body = init.body ? (() => { try { return JSON.parse(init.body); } catch { return {}; } })() : {};
  if (u.pathname === '/auth/v1/admin/users' && init.method === 'POST') { if (users.some((x) => x.email === body.email)) return J({ error_code: 'email_exists', msg: 'already been registered' }, 422); const user = { id: 'su' + users.length, email: body.email, password: body.password, email_confirmed_at: iso(now) }; users.push(user); return J(user); }
  if (u.pathname === '/auth/v1/admin/users') return J({ users });
  if (u.pathname === '/auth/v1/token') { const x = users.find((y) => y.email === body.email); return x && x.password === body.password ? J({ access_token: 'at_' + x.id + 'z'.repeat(24), refresh_token: 'r', expires_in: 3600, user: { id: x.id, email: x.email } }) : J({ error: 'invalid_grant' }, 400); }
  return realFetch(url, init);
};
T.tenants = [{ id: 'old1', slug: 'glow', name: 'Glow Studio', owner_email: 'first@glow.com', website_url: 'https://www.glowstudio.com', subscription_status: 'canceled', trial_ends_at: iso(now - 60 * DAY) }];
T.tenant_users = []; T.legal_acceptances = []; T.tenant_onboarding = []; T.signup_attempts = []; T.tenant_numbers = []; T.tenant_channels = [];
telnyx.length = 0;
r = await run('auth/signup.js', { headers: { 'x-forwarded-for': '7.7.7.7' }, body: { email: 'again@glow.com', password: 'longenough1', salonName: 'Glow Studio', websiteUrl: 'glowstudio.com/book', accept_terms: true } });
const again = T.tenants.find((t) => t.owner_email === 'again@glow.com');
ok(r.status === 200 && r.trial === false && r.trial_used && /already used its free/.test(r.message), 'same salon website, new email → account created, no new trial, clear message');
ok(again && Date.parse(again.trial_ends_at) <= Date.now() && again.trial_denied_reason === 'website', 'its trial ends now (reason: website)');
r = await run('auth/signup.js', { headers: { 'x-forwarded-for': '7.7.7.8' }, body: { email: 'new@fresh.com', password: 'longenough1', salonName: 'Fresh', websiteUrl: 'https://instagram.com/fresh', accept_terms: true } });
ok(r.status === 200 && r.trial === true, 'a new salon (shared hosts like instagram never match) gets its 14-day trial');
ok(!r.autoProvisioned && !telnyx.some((x) => /phone_numbers/.test(x.u)), 'no Lola number is attached at sign-up');
ok(T.signup_attempts.length === 2, 'sign-ups recorded per IP in the database');
process.env.SIGNUP_IP_DAILY = '2';
T.signup_attempts.push({ ip: '8.8.8.8', trial: true, created_at: iso(now - 3600e3) }, { ip: '8.8.8.8', trial: true, created_at: iso(now - 7200e3) });
r = await run('auth/signup.js', { headers: { 'x-forwarded-for': '8.8.8.8' }, body: { email: 'bulk@x.com', password: 'longenough1', salonName: 'Bulk', accept_terms: true } });
ok(r.status === 429, 'per-IP limit survives cold starts (persisted table)');
delete process.env.SIGNUP_IP_DAILY;
globalThis.fetch = realFetch;

// ══ 7. Numbers: trials use the pool only; one per plan ══
const { getNumber } = await import(P + 'lib/setup/telecom.js');
T.tenants = [
  { id: 'tr', name: 'Trial', subscription_status: 'trial', trial_ends_at: iso(now + 5 * DAY), plan: 'starter' },
  { id: 'st', name: 'Starter', subscription_status: 'active', plan: 'starter', phone_number: '+13055550001' },
  { id: 'ms', name: 'Med', subscription_status: 'active', plan: 'medspa', phone_number: '+13055550002' },
  { id: 'gone', name: 'Gone', subscription_status: 'canceled', current_period_end: iso(now - DAY), plan: 'pro' },
];
T.tenant_numbers = [{ tenant_id: 'st', phone_number: '+13055550001', status: 'active', kind: 'primary' }, { tenant_id: 'ms', phone_number: '+13055550002', status: 'active', kind: 'primary' }];
T.usage_events = []; telnyx.length = 0;
r = await getNumber(T.tenants[0], { confirmed: true });
ok(!r.ok && r.trial_pool_empty && !telnyx.some((x) => /number_orders/.test(x.u)), 'trial salon, empty pool → no purchase: ' + r.say.slice(0, 70) + '…');
r = await getNumber(T.tenants[1], { additional: true });
ok(!r.ok && r.limit === 1, 'Starter already has its 1 included line → no second number');
r = await getNumber(T.tenants[2], { additional: true });
ok(r.ok && r.needs_confirmation, 'Med-Spa includes 2 lines → second number offered');
r = await getNumber(T.tenants[3], {});
ok(!r.ok && r.paused === 'canceled', 'service off → no number');

// ══ 8. Costs in cents; monthly accrual; extra-line rent billed ══
const { logCost, costCents } = await import(P + 'lib/costs.js');
T.usage_events = [];
await logCost('st', 'cost_port', 100, { phone_number: '+1305' });
ok(T.usage_events[0].kind === 'cost_port' && T.usage_events[0].units === 100 && T.usage_events[0].metadata.unit === 'cents', 'logCost: units = cents, tagged');
ok(costCents({ kind: 'cost_10dlc_brand', units: 1, metadata: {} }) === 400, 'legacy count rows priced at defaults');
ok((await logCost(null, 'cost_x', 5)).ok === false, 'logCost never throws');
const { accrueMonthly, runRentBilling } = await import(P + 'lib/rent.js');
T.usage_events = [];
T.tenant_numbers.push({ tenant_id: 'st', phone_number: '+13055550009', status: 'active', kind: 'secondary' });
T.tenants[1].stripe_customer_id = 'cus_st';
T.integrations = [];
let acc = await accrueMonthly(c);
ok(T.usage_events.filter((e) => e.kind === 'cost_number_month').length === 3 && T.usage_events.find((e) => e.kind === 'cost_number_month').units === 100, 'every live line accrues its $1.00/mo cost');
ok(T.usage_events.filter((e) => e.kind === 'number_rent' && e.tenant_id === 'st').length === 1, 'Starter’s second line → rent (beyond the plan)');
acc = await accrueMonthly(c);
ok(acc.number_costs === 0 && acc.number_rent === 0, 'accrual is once a month (safe to run daily)');
const rentBills = [];
const rb = await runRentBilling(c, { live: true, bill: async (t, l, cents) => { rentBills.push({ t: t.id, cents }); return { id: 'ii_rent' }; } });
ok(rentBills.length === 1 && rentBills[0].cents === 500 && T.usage_events.find((e) => e.kind === 'number_rent').metadata.billed_at, 'rent goes on the next invoice once ($5.00), marked billed');
await runRentBilling(c, { live: true, bill: async () => { rentBills.push(1); return { id: 'x' }; } });
ok(rentBills.length === 1, 'never billed twice');

// ══ 9. Numbers released 30 days after the service stops ══
const { runReleaseNumbers } = await import(P + 'lib/release-numbers.js');
T.tenants = [
  { id: 'r1', name: 'Left', subscription_status: 'canceled', current_period_end: iso(now - 40 * DAY), phone_number: '+13055551111', operator_phone: '+17865551111' },
  { id: 'r2', name: 'Soon', subscription_status: 'canceled', current_period_end: iso(now - 25 * DAY), phone_number: '+13055552222', operator_phone: '+17865552222' },
  { id: 'r3', name: 'Ported', subscription_status: 'canceled', current_period_end: iso(now - 45 * DAY), phone_number: '+13055553333' },
  { id: 'r4', name: 'Live', subscription_status: 'active', phone_number: '+13055554444' },
];
T.tenant_numbers = [
  { tenant_id: 'r1', phone_number: '+13055551111', status: 'active', kind: 'primary' },
  { tenant_id: 'r2', phone_number: '+13055552222', status: 'active', kind: 'primary' },
  { tenant_id: 'r3', phone_number: '+13055553333', status: 'active', kind: 'primary', notes: 'ported in' },
  { tenant_id: 'r4', phone_number: '+13055554444', status: 'active', kind: 'primary' },
];
T.tenant_number_ports = []; T.client_memories = []; T.usage_events = [];
const notes = [];
const say = async (t, text) => { notes.push({ t: t.id, text }); return { texted: true }; };
out = await runReleaseNumbers(c, { notify: say, env: { ...process.env, RELEASE_NUMBERS_LIVE: '' } });
ok(!notes.length && T.tenant_numbers.every((n) => n.status === 'active'), 'without RELEASE_NUMBERS_LIVE=1 it only reports: ' + JSON.stringify(out.tenants.map((x) => x.tenant)));
out = await runReleaseNumbers(c, { notify: say });
ok(notes.length === 3 && T.tenant_numbers.every((n) => n.status === 'active'), 'first: every salon about to lose its line gets a heads-up — nothing is released without one');
await runReleaseNumbers(c, { notify: say });
ok(notes.length === 3, 'heads-up sent once');
const later = new Date(now + 8 * DAY);
await runReleaseNumbers(c, { notify: say, now: later });
ok(T.tenant_numbers.find((n) => n.tenant_id === 'r1').status === 'released' && T.tenants[0].phone_number === null, 'a week after the heads-up, off 30+ days → line released back to the pool (row kept as history)');
ok(T.tenant_numbers.find((n) => n.tenant_id === 'r3').status === 'parked', 'a number the salon ported in is parked — never handed to another salon');
ok(T.tenant_numbers.find((n) => n.tenant_id === 'r4').status === 'active' && T.tenants[3].phone_number, 'paying salons untouched');
r = await run('cron/release-numbers.js', { method: 'GET', headers: {} });
ok(r.status === 401, 'cron needs CRON_SECRET');

// ══ 10. Admin: MRR, status by subscription, $ costs + margin ══
T.tenants = [
  { id: 'm1', name: 'One', plan: 'starter', subscription_status: 'active', created_at: iso(now) },
  { id: 'm2', name: 'Two', plan: 'pro', billing_interval: 'annual', subscription_status: 'past_due', past_due_since: iso(now - DAY), created_at: iso(now) },
  { id: 'm3', name: 'Three', plan: 'medspa', subscription_status: 'trial', billing_status: 'active', created_at: iso(now) },
];
T.usage_events = [{ tenant_id: 'm1', kind: 'cost_number_month', units: 100, metadata: { unit: 'cents' }, created_at: iso(now) }, { tenant_id: 'm1', kind: 'cost_10dlc_brand', units: 1, metadata: {}, created_at: iso(now) }];
T.booking_fees = [{ tenant_id: 'm1', status: 'earned', fee_cents: 300, period: iso(now).slice(0, 7) }];
T.messages = []; T.calls = []; T.bookings = [];
r = await run('admin.js', { method: 'GET', headers: { authorization: 'Bearer tok-admin' } });
ok(r.ok && r.metrics.mrr_cents === 9900 + 31900 && r.metrics.by_status.active === 1 && r.metrics.by_status.past_due === 1 && r.metrics.by_status.trial === 1, `MRR from plans.js ($${r.metrics.mrr_dollars}) and status by subscription`);
const m1 = r.tenants.find((t) => t.id === 'm1');
ok(m1.cost_cents === 500 && m1.margin_cents === 9900 + 300 - 500 && m1.cost_dollars === 5, 'per salon: $ costs (legacy rows priced) and margin = MRR + fees − costs');
ok(r.tenants.find((t) => t.id === 'm3').service === 'on', 'admin-comped salon shows service on');

// ══ 11. eSIM only for paid salons; pulse tells the truth ══
T.tenants = [{ id: A, slug: 'a', name: 'Salon A', owner_email: 'a@salon.com', subscription_status: 'trial', trial_ends_at: iso(now + 5 * DAY) }];
T.tenant_users = [{ tenant_id: A, user_id: 'u-a', role: 'owner', status: 'active' }]; T.integrations = [];
r = await run('telnyx-esim.js', { headers: { authorization: 'Bearer tok-a' }, body: { action: 'order' } });
ok(r.status === 402 && r.upgrade && !telnyx.some((x) => /sim_card_orders/.test(x.u)), 'trial salon can’t order an eSIM (nothing ordered)');
const { lolaPulse } = await import(P + 'lola/pulse.js');
T.booking_settings = []; T.conversations = [];
let p = await lolaPulse(c, { id: 'pz', phone_number: '+13055550000', subscription_status: 'canceled', current_period_end: iso(now + 5 * DAY) });
ok(p.live, 'canceled but paid through the period → still live');
p = await lolaPulse(c, { id: 'pz', phone_number: '+13055550000', subscription_status: 'trial', trial_ends_at: iso(now - 10 * DAY) });
ok(!p.live && /paused because your free trial ended/.test(p.headline), 'really paused → says why: ' + p.headline);

// ══ 12. Crons skip salons whose service is off ══
const { pauseInactive } = await import(P + 'cron/campaigns.js');
T.tenants = [{ id: 'on', subscription_status: 'active' }, { id: 'off', subscription_status: 'unpaid' }];
T.lola_campaigns = [{ id: 'c-on', tenant_id: 'on', status: 'sending' }, { id: 'c-off', tenant_id: 'off', status: 'sending' }];
const paused = await pauseInactive(c);
ok(paused.length === 1 && T.lola_campaigns.find((x) => x.id === 'c-off').status === 'paused' && T.lola_campaigns.find((x) => x.id === 'c-on').status === 'sending', 'campaigns of an unpaid salon are paused, not cancelled');
const { gatedSend } = await import(P + 'cron/booking-reminders.js');
const sent = []; const gs = gatedSend(async (o) => { sent.push(o.tenantId); return { ok: true }; });
await gs({ tenantId: 'on', to: '+1' }); const sk = await gs({ tenantId: 'off', to: '+1' });
ok(sent.join() === 'on' && sk.skipped && gs.stats.paused === 1, 'reminders skip salons whose service is off');
const { runFillPlans } = await import(P + 'lib/fill-plan.js');
T.lola_fill_plans = [{ id: 'fp', tenant_id: 'off', status: 'active', items: [], created_at: iso(now) }];
out = await runFillPlans(c, { budgetMs: 20000 });
ok(out.paused === 1 && out.plans === 0, 'fill plans skip salons whose service is off');

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
