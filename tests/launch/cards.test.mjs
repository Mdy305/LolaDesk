// Card on file: when the salon charges a no-show fee, every booking is held with a card (the deposit link
// saves it, or one text with a secure Stripe page — nothing charged then). A marked no-show is charged to
// that card, money to the salon; if the bank says no, the client gets the pay link. Never another salon's card.
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'k';
process.env.STRIPE_SECRET_KEY = 'sk_test_x'; process.env.STRIPE_WEBHOOK_SECRET = 'whsec_acct'; process.env.CRON_SECRET = 'cron'; process.env.APP_URL = 'https://www.loladesk.com';
import { Readable } from 'node:stream';
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const sms = [], stripe = [];
let declineNext = false, failNext = 0;
const form = (b) => decodeURIComponent(String(b || ''));
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  if (u.includes('api.stripe.com')) {
    const path = u.replace('https://api.stripe.com/v1', ''); stripe.push({ path, method: init.method || 'GET', body: form(init.body), headers: init.headers || {} });
    if (path === '/customers') return J({ id: 'cus_' + stripe.length });
    if (path === '/checkout/sessions') return J({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' });
    if (path.startsWith('/setup_intents/')) return J({ id: 'seti_1', payment_method: 'pm_visa' });
    if (path.startsWith('/payment_intents/') && (init.method || 'GET') === 'GET') return J({ id: 'pi_dep', payment_method: 'pm_amex' });
    if (path.startsWith('/payment_methods/')) return J({ id: path.split('/').pop(), customer: null, card: path.endsWith('pm_amex') ? { brand: 'amex', last4: '1005', exp_month: 1, exp_year: 2030 } : { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 } });
    if (path === '/payment_intents') { if (failNext > 0) { failNext--; return J({ error: { message: 'An error occurred with our connection to Stripe.', type: 'api_error' } }, 500); } if (declineNext) { declineNext = false; return J({ error: { message: 'Your card was declined.', code: 'card_declined' } }, 402); } return J({ id: 'pi_ns_' + stripe.length, status: 'succeeded' }); }
    if (path === '/payment_links') return J({ id: 'plink_' + stripe.length, url: 'https://buy.stripe.com/x' + stripe.length });
    if (path.startsWith('/payment_links/')) return J({ id: 'plink', active: false });
    return J({ id: 'x' });
  }
  if (u.includes('/v2/messages')) { sms.push(JSON.parse(init.body)); return J({ data: { id: 'm' + sms.length } }); }
  return J({ data: [] });
};
const { T } = await import('./fake-supabase.mjs');
const TID = '00000000-0000-4000-8000-0000000cab01', OTHER = '00000000-0000-4000-8000-0000000cab02';
const H = 3600e3, soon = (h) => new Date(Date.now() + h * H).toISOString(), ago = (h) => new Date(Date.now() - h * H).toISOString();
T.tenants = [{ id: TID, name: 'MMA Salon', phone_number: '+13055550100', subscription_status: 'active' }, { id: OTHER, name: 'Other Salon', phone_number: '+13055550200', subscription_status: 'active' }];
T.clients = [{ id: 'c1', tenant_id: TID, name: 'Sarah Kim', phone: '+13055554444' }, { id: 'c2', tenant_id: TID, name: 'Bo Lee', phone: '+13055555555' }, { id: 'c9', tenant_id: OTHER, name: 'Sarah Kim', phone: '+13055554444' }];
T.services = [{ id: 's1', tenant_id: TID, name: 'Haircut', price: 80 }, { id: 's9', tenant_id: OTHER, name: 'Haircut', price: 80 }];
T.bookings = [{ id: 'bk-1', tenant_id: TID, client_id: 'c1', service_id: 's1', status: 'confirmed', start_time: soon(48), total_amount: 80 }];
T.stripe_connect_accounts = [{ tenant_id: TID, stripe_account_id: 'acct_salon', charges_enabled: true }];
for (const k of ['payments', 'deposits', 'client_cards', 'tenant_numbers', 'opt_outs', 'usage_events', 'messages', 'conversations', 'integrations', 'billing_events', 'billing_policies']) T[k] = [];
const policy = (on) => ({ tenant_id: TID, metadata: { deposits: { enabled: false, no_show: { enabled: on, type: 'fixed', amount: 40 }, auto_charge: { no_show_fee: on } } } });
T.booking_settings = [policy(false), { tenant_id: OTHER, metadata: { deposits: { no_show: { enabled: true, type: 'fixed', amount: 40 }, auto_charge: { no_show_fee: true } } } }];
const P = new URL('../../api/', import.meta.url).href;
const { requestDeposit } = await import(P + 'lib/deposits.js');

// ── 1. Only salons that charge a no-show fee ask for a card ──
let r = await requestDeposit({ tenantId: TID, booking: T.bookings[0] });
ok(r.skipped && !r.card && !sms.length, 'no no-show policy → no card ask, no text');
T.booking_settings[0] = policy(true);
r = await requestDeposit({ tenantId: TID, booking: T.bookings[0] });
const url = r.card?.url || '';
ok(r.card?.sent && sms.length === 1 && /NOT charged now/.test(sms[0].text) && /\$40/.test(sms[0].text) && sms[0].text.includes(url) && /\/api\/card\?b=bk-1&s=/.test(url), 'no-show policy on, no deposit → ONE text: card holds it, not charged now, the fee in plain words: ' + sms[0]?.text);

// ── 2. The link opens a fresh Stripe page (setup mode: nothing charged) that shows the policy ──
const card = (await import(P + 'card.js')).default;
const open = (q) => new Promise((resolve) => { const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) { resolve({ status: this.statusCode, location: this.headers.Location, body: b }); } }; card({ query: q }, res); });
let o = await open({ b: 'bk-1', s: 'forged' });
ok(o.status === 404 && !stripe.some((x) => x.path === '/checkout/sessions'), 'a forged link opens nothing');
const sig = new URL(url).searchParams.get('s');
o = await open({ b: 'bk-1', s: sig });
const sess = stripe.find((x) => x.path === '/checkout/sessions');
ok(o.status === 302 && o.location === 'https://checkout.stripe.com/c/pay/cs_1' && /mode=setup/.test(sess.body) && /customer=cus_/.test(sess.body) && /no-show fee of \$40/.test(sess.body) && /It is not charged now/.test(sess.body), 'the link → a Stripe setup page for her, with the salon’s policy on it');
ok(T.client_cards.length === 1 && T.client_cards[0].tenant_id === TID && T.client_cards[0].status === 'pending', 'her Stripe customer is kept for this salon only');

// ── 3. Stripe says done → the card is on file ──
const Stripe = (await import('stripe')).default; const st = new Stripe('sk_test_x');
const hook = (await import(P + 'stripe-webhook.js')).default;
const send = (event) => { const payload = JSON.stringify(event); const header = st.webhooks.generateTestHeaderString({ payload, secret: 'whsec_acct' }); const req = Readable.from([Buffer.from(payload)]); req.method = 'POST'; req.headers = { 'stripe-signature': header }; return new Promise((resolve) => { const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(x) { resolve({ status: this.statusCode, body: x }); }, setHeader() {} }; hook(req, res); }); };
await send({ id: 'evt_c1', type: 'checkout.session.completed', data: { object: { id: 'cs_1', mode: 'setup', customer: T.client_cards[0].stripe_customer_id, setup_intent: 'seti_1', metadata: { kind: 'card_on_file', tenant_id: TID, client_id: 'c1', booking_id: 'bk-1' } } } });
ok(T.client_cards[0].status === 'active' && T.client_cards[0].payment_method_id === 'pm_visa' && T.client_cards[0].last4 === '4242', 'the card is on file (Visa ending 4242) — only a Stripe id, never a card number');
o = await open({ b: 'bk-1', s: sig });
ok(o.status === 302 && /card=already/.test(o.location), 'tapping the link again → "already on file", no second card');
r = await requestDeposit({ tenantId: TID, booking: T.bookings[0] });
ok(!r.card && sms.length === 1, 'a client with a card on file is never asked again');

// ── 4. A deposit link saves the card too ──
const { createPaymentLink } = await import(P + 'lib/stripe.js');
await createPaymentLink({ amountCents: 2000, description: 'Deposit', tenantId: TID, metadata: { booking_id: 'bk-2' }, saveCard: true });
const pl = stripe.filter((x) => x.path === '/payment_links').pop();
ok(/customer_creation=always/.test(pl.body) && /payment_intent_data\[setup_future_usage\]=off_session/.test(pl.body) && /save_card\]=1/.test(pl.body), 'with the no-show policy on, paying the deposit also keeps the card');
await createPaymentLink({ amountCents: 2000, description: 'Deposit', tenantId: TID, saveCard: true, saveCardNote: 'Paying this deposit also keeps your card on file' });
ok(/custom_text\[submit\]\[message\]=Paying this deposit also keeps your card on file/.test(stripe.filter((x) => x.path === '/payment_links').pop().body), 'the deposit page says the card is kept (consent before any charge)');
T.bookings.push({ id: 'bk-2', tenant_id: TID, client_id: 'c2', service_id: 's1', status: 'confirmed', start_time: soon(72), total_amount: 80 });
T.deposits.push({ id: 'd2', tenant_id: TID, booking_id: 'bk-2', status: 'pending', stripe_payment_intent_id: 'plink_dep2' });
await send({ id: 'evt_c2', type: 'checkout.session.completed', data: { object: { id: 'cs_2', mode: 'payment', payment_link: 'plink_dep2', payment_intent: 'pi_dep', customer: 'cus_bo', metadata: { kind: 'deposit', tenant_id: TID, booking_id: 'bk-2', save_card: '1' } } } });
const bo = T.client_cards.find((x) => x.client_id === 'c2');
ok(T.deposits[0].status === 'paid' && bo?.payment_method_id === 'pm_amex' && bo.last4 === '1005' && bo.stripe_customer_id === 'cus_bo', 'deposit paid → deposit marked paid AND Bo’s card kept on file');

// ── 5. A marked no-show is charged to the card, money to the salon ──
T.bookings.push({ id: 'ns-1', tenant_id: TID, client_id: 'c1', service_id: 's1', status: 'no_show', start_time: ago(3), total_amount: 80 });
const scan = (await import(P + 'cron/no-show-scan.js')).default;
const run = () => new Promise((resolve) => { const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(x) { resolve({ status: this.statusCode, ...x }); } }; scan({ method: 'GET', headers: { authorization: 'Bearer cron' } }, res); });
const before = sms.length;
let s = await run();
const pi = stripe.filter((x) => x.path === '/payment_intents').pop();
ok(s.results.some((x) => x.action === 'fee_charged_card') && /amount=4000/.test(pi.body) && /off_session=true/.test(pi.body) && /confirm=true/.test(pi.body) && /payment_method=pm_visa/.test(pi.body) && /transfer_data\[destination\]=acct_salon/.test(pi.body) && pi.headers['Idempotency-Key'] === 'noshow_ns-1', 'no-show → $40 charged to her card off-session, paid to the salon’s Stripe, once (idempotent)');
const pay = T.payments.find((x) => x.booking_id === 'ns-1');
ok(pay?.status === 'succeeded' && /^pi_ns_/.test(pay.stripe_id) && sms.length === before + 1 && /charged to your card ending 4242/.test(sms[sms.length - 1].text) && !stripe.some((x) => x.path === '/payment_links' && /ns-1/.test(x.body)), 'the salon’s Payments shows it paid; she gets one honest receipt text; no pay link');
s = await run();
ok(stripe.filter((x) => x.path === '/payment_intents').length === 1, 'the next scan never charges twice');

// ── 6. The bank says no → the pay link instead ──
T.bookings.push({ id: 'ns-2', tenant_id: TID, client_id: 'c2', service_id: 's1', status: 'no_show', start_time: ago(2), total_amount: 80 });
declineNext = true;
s = await run();
ok(s.results.some((x) => x.booking_id === 'ns-2' && x.action === 'fee_link_sent') && /buy\.stripe\.com/.test(sms[sms.length - 1].text), 'declined card → Bo gets the secure pay link instead (nothing lost)');
ok(T.client_cards.find((x) => x.client_id === 'c2').status === 'declined', 'the declined card no longer counts — Bo can add a new one through his link');
const cof0 = await import(P + 'lib/card-on-file.js');
o = await open({ b: 'bk-2', s: cof0.cardSig('bk-2') });
ok(o.status === 302 && /checkout\.stripe\.com/.test(o.location), 'his link opens a fresh card page (not "already on file")');

// ── 6b. Stripe doesn't answer clearly → never a pay link on top of a charge that may have happened ──
T.bookings.push({ id: 'ns-3', tenant_id: TID, client_id: 'c1', service_id: 's1', status: 'no_show', start_time: ago(1), total_amount: 80 });
failNext = 2; const smsBefore = sms.length, linksBefore = stripe.filter((x) => x.path === '/payment_links').length;
s = await run();
const p3 = T.payments.find((x) => x.booking_id === 'ns-3');
const tries = stripe.filter((x) => x.path === '/payment_intents' && /ns-3/.test(x.body));
ok(s.results.some((x) => x.booking_id === 'ns-3' && x.action === 'charge_uncertain') && p3.status === 'review' && p3.at_risk === true && sms.length === smsBefore && stripe.filter((x) => x.path === '/payment_links').length === linksBefore, 'Stripe error → flagged for the salon to check; no text, no pay link');
ok(tries.length === 2 && tries.every((x) => x.headers['Idempotency-Key'] === 'noshow_ns-3'), 'it retried once with the SAME key (Stripe can never charge twice)');
const { data: _ } = { data: null };
// ── 6c. No connected Stripe account → never charge into LolaDesk's balance ──
const saved = T.stripe_connect_accounts; T.stripe_connect_accounts = [];
const nc = await cof0.chargeSavedCard({ tenantId: TID, clientId: 'c1', amountCents: 4000 });
ok(!nc.ok && nc.needs_link && nc.reason === 'salon_stripe_not_connected', 'salon not connected to Stripe → no card charge (money only ever goes to the salon)');
T.stripe_connect_accounts = saved;

// ── 7. Never another salon's card ──
const cof = await import(P + 'lib/card-on-file.js');
const other = await cof.chargeSavedCard({ tenantId: OTHER, clientId: 'c9', amountCents: 4000 });
ok(!other.ok && other.reason === 'no_card', 'the same person at another salon has no card there — nothing is charged');
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
