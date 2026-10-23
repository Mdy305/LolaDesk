// Did the money really reach the bank? Lola reads Square's payouts and every line inside them, matches each
// card sale to the deposit that paid it, keeps cash apart, and flags what didn't arrive, failed or doesn't
// add up — on the Deposits page, when the owner asks, in her brief, and by text the moment it happens.
import crypto from 'node:crypto';
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'k';
process.env.INTEGRATION_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64'); process.env.SQUARE_ENV = 'production';
process.env.SENDGRID_API_KEY = 'sg'; process.env.EMAIL_FROM = 'lola@loladesk.com';
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const DAY = 864e5, NOW = Date.now();
const iso = (d) => new Date(NOW - d * DAY).toISOString();
const P_ = []; const mails = [], texts = [];
const pay = (id, d, dollars, { src = 'CARD', fee = Math.round(dollars * 2.6 + 15), cust = 'C1', refund = 0 } = {}) => P_.push({ id, status: 'COMPLETED', created_at: iso(d), amount_money: { amount: dollars * 100 }, refunded_money: refund ? { amount: refund * 100 } : undefined, tip_money: { amount: 0 }, source_type: src, processing_fee: src === 'CARD' ? [{ amount_money: { amount: fee } }] : [], customer_id: cust, order_id: 'O' + id, location_id: 'L1' });
pay('p1', 20, 100); pay('p2', 19, 200, { cust: 'C2' }); pay('p3', 18, 50);        // deposited (payout A)
pay('p4', 2, 120, { cust: 'C2' });                                            // on its way (payout B, SENT)
pay('p5', 1, 80);                                                             // just now: waiting, normal
pay('p6', 12, 90, { cust: 'C2' });                                            // 12 days, no payout line: MISSING
pay('p7', 9, 300);                                                            // in the FAILED payout C
pay('c1', 5, 60, { src: 'CASH', cust: null }); pay('x1', 6, 40, { src: 'EXTERNAL', cust: null });
const fee = (id) => P_.find((p) => p.id === id).processing_fee[0].amount_money.amount;
const entry = (eid, pid, type = 'CHARGE', amt) => { const p = P_.find((x) => x.id === pid); const g = amt ?? p.amount_money.amount; const f = type === 'CHARGE' ? fee(pid) : 0; return { id: eid, type, effective_at: p ? p.created_at : iso(15), gross_amount_money: { amount: g }, fee_amount_money: { amount: -f }, net_amount_money: { amount: g - f }, type_charge_details: { payment_id: pid } }; };
const netOf = (ids) => ids.reduce((t, id) => t + P_.find((p) => p.id === id).amount_money.amount - fee(id), 0);
const PAYOUTS = [
  { id: 'po_A', status: 'PAID', amount_money: { amount: netOf(['p1', 'p2', 'p3']) - 2500, currency: 'USD' }, arrival_date: new Date(NOW - 16 * DAY).toISOString().slice(0, 10), created_at: iso(17), destination: { type: 'BANK_ACCOUNT', id: 'bact_9921' }, type: 'BATCH' },
  { id: 'po_B', status: 'SENT', amount_money: { amount: netOf(['p4']), currency: 'USD' }, arrival_date: new Date(NOW + 1 * DAY).toISOString().slice(0, 10), created_at: iso(1), destination: { type: 'BANK_ACCOUNT', id: 'bact_9921' }, type: 'BATCH' },
  { id: 'po_C', status: 'FAILED', amount_money: { amount: netOf(['p7']), currency: 'USD' }, arrival_date: new Date(NOW - 7 * DAY).toISOString().slice(0, 10), created_at: iso(8), destination: { type: 'BANK_ACCOUNT', id: 'bact_9921' }, type: 'BATCH' },
];
const ENTRIES = { po_A: [entry('e1', 'p1'), entry('e2', 'p2'), entry('e3', 'p3'), { id: 'e4', type: 'DISPUTE', effective_at: iso(17), gross_amount_money: { amount: -2500 }, fee_amount_money: { amount: 0 }, net_amount_money: { amount: -2500 }, type_dispute_details: { payment_id: 'p1' } }, { id: 'e5', type: 'ADJUSTMENT', effective_at: iso(17), gross_amount_money: { amount: -900 }, fee_amount_money: { amount: 0 }, net_amount_money: { amount: -900 } }],
  po_B: [entry('e6', 'p4')], po_C: [entry('e7', 'p7')] };
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  if (u.includes('api.sendgrid.com')) { mails.push(JSON.parse(init.body)); return new Response('', { status: 202 }); }
  if (u.endsWith('/v2/messages')) { texts.push(JSON.parse(init.body)); return J({ data: { id: 'm' } }); }
  if (!u.startsWith('https://connect.squareup.com')) return J({ data: [] });
  const path = u.replace('https://connect.squareup.com', ''); const body = init.body ? JSON.parse(init.body) : {};
  if (path.startsWith('/v2/locations')) return J({ locations: [{ id: 'L1', status: 'ACTIVE', timezone: 'America/New_York' }] });
  if (path.startsWith('/v2/payments?')) { const q = new URL(u).searchParams; const a = Date.parse(q.get('begin_time')), b = Date.parse(q.get('end_time')); return J({ payments: P_.filter((p) => Date.parse(p.created_at) >= a && Date.parse(p.created_at) < b) }); }
  if (path === '/v2/orders/search') return J({ orders: [] });
  if (path.startsWith('/v2/customers?')) return J({ customers: [{ id: 'C1', given_name: 'Ana', family_name: 'Lopez', phone_number: '+13055551111' }, { id: 'C2', given_name: 'Mia', family_name: 'Chen', phone_number: '+13055552222' }] });
  let m = path.match(/^\/v2\/payouts\/(po_[A-Z])\/payout-entries/); if (m) return J({ payout_entries: ENTRIES[m[1]] || [] });
  if (path.startsWith('/v2/payouts?')) return J({ payouts: PAYOUTS });
  return J({ errors: [{ code: 'NOT_FOUND', detail: path }] }, 404);
};
const { T } = await import('./fake-supabase.mjs');
const TID = '99999999-1111-4111-8111-999999999999';
T.tenants = [{ id: TID, name: 'MMA Salon', slug: 'mma', subscription_status: 'active', phone_number: '+13055550100', owner_email: 'owner@mmasalon.com', owner_phone: '+13053227442' }];
T.tenant_numbers = [{ tenant_id: TID, phone_number: '+13055550100', status: 'active' }];
for (const k of ['bookings', 'usage_events', 'provider_mappings', 'platform_settings', 'lola_campaign_recipients', 'lola_campaigns', 'booking_settings', 'services', 'staff', 'clients', 'salon_sales', 'salon_sale_items', 'salon_payouts', 'salon_payout_entries', 'opt_outs']) T[k] = [];
globalThis.__authUsers = { tok: { id: 'u1', email: 'o@mma.com' } };
T.tenant_users = [{ user_id: 'u1', tenant_id: TID, role: 'owner', status: 'active' }];
const { encrypt } = await import('../../api/lib/crypto.js');
const SC = ['PAYMENTS_READ', 'ORDERS_READ', 'PAYOUTS_READ'];
T.integrations = [{ id: 'int-sq', tenant_id: TID, provider: 'square', status: 'connected', access_token: encrypt('tok'), refresh_token: encrypt('r'), expires_at: new Date(NOW + 25 * DAY).toISOString(), metadata: { merchant_id: 'M', location_id: 'L1', tz: 'America/New_York', scopes: SC } }];
const P = new URL('../../api/', import.meta.url).href;
const SQ = await import(P + 'lib/connectors/square.js');
ok(SQ.SCOPE_LIST.includes('PAYOUTS_READ') && !SQ.SCOPE_LIST.some((s) => /PAYOUTS_WRITE|BANK_ACCOUNTS/.test(s)), 'Square permission: read deposits (never move money)');
const SD = await import(P + 'lib/square-data.js');
const D = await import(P + 'lib/square-deposits.js');
const { db } = await import(P + 'lib/db.js');
const integ = { ...T.integrations[0], access_token: 'tok', refresh_token: 'r' };

// ── Once connected: everything ──
const s1 = await SD.syncEverything(db(), integ, { now: NOW, budgetMs: 60000 });
ok(s1.ok && T.salon_sales.length === P_.length && s1.deposits?.payouts === 3 && T.salon_payouts.every((p) => p.entries_loaded) && T.salon_payout_entries.length === 7, 'one sync: sales, clients, 3 deposits and all 7 lines inside them');
ok(T.salon_sales.find((r) => r.external_id === 'c1').source === 'CASH' && T.salon_sales.find((r) => r.external_id === 'p1').fee_cents === fee('p1'), 'each sale knows how it was paid (card / cash) and Square’s fee');
ok(T.salon_payouts.find((p) => p.external_id === 'po_A').destination_ref === '…9921', 'bank account shown masked (…9921), never in full');

// ── The check ──
const r = await D.reconcile(db(), T.tenants[0], { days: 30, now: NOW });
const X = r.totals;
ok(r.ok && X.counts.card === 7 && X.counts.deposited === 3 && X.counts.on_its_way === 1 && X.counts.waiting === 1 && X.counts.missing === 1 && X.counts.failed === 1, 'every card sale matched: 3 in the bank, 1 on its way, 1 just made, 1 missing, 1 in a failed deposit');
ok(X.cash_count === 1 && X.cash_sales === 6000 && X.outside_sales === 4000, 'cash ($60) and paid-outside-Square ($40) kept apart — never “missing”');
ok(X.square_fees === ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'].reduce((t, id) => t + fee(id), 0) && X.fee_rate > 2 && X.fee_rate < 4, `Square fees: $${(X.square_fees / 100).toFixed(2)} (${X.fee_rate}% of card sales)`);
const kinds = r.issues.map((i) => i.key.split(':')[0]);
ok(kinds[0] === 'failed' && kinds.includes('missing') && kinds.includes('mismatch') && kinds.includes('adj'), 'what needs you, worst first: the failed deposit, the missing payment, the deposit that doesn’t add up, the dispute');
ok(/Mia Chen · \$90\.00/.test(r.issues.find((i) => i.key.startsWith('missing')).detail), 'the missing one by name and amount: ' + r.issues.find((i) => i.key.startsWith('missing')).detail);
ok(!r.all_clear && /need you/.test(D.sayDeposits(r)), 'Lola, asked: ' + D.sayDeposits(r));

// ── Told once ──
ok(s1.deposits.alerted === 1 && (texts.some((t) => /deposit failed/.test(t.text)) || mails.some((m) => /deposit failed/.test(JSON.stringify(m)))), 'the owner is texted/emailed as soon as the sync finds a failed deposit');
let a = await D.depositAlerts(db(), T.tenants[0], r);
ok(a.sent === 0, 'and not again for the same problem');

// ── Lola + the page ──
const { routeOwnerIntent } = await import(P + 'lib/owner-intents.js');
ok(routeOwnerIntent('did all my money arrive?')?.tool === 'verify_deposits' && routeOwnerIntent('check my payouts for the last 90 days')?.args?.days === 90 && routeOwnerIntent('was I paid this week')?.tool === 'verify_deposits', '“Did all my money arrive?” · “check my payouts” · “was I paid”');
ok(routeOwnerIntent('turn on deposits for bookings')?.tool !== 'verify_deposits' && routeOwnerIntent('require a deposit for balayage')?.tool !== 'verify_deposits', 'booking deposits (clients paying ahead) are a different thing — never confused');
const { runOwnerTool } = await import(P + 'lib/owner-tools.js');
const t = await runOwnerTool({ tenant: T.tenants[0], name: 'verify_deposits', args: { days: 30 } });
ok(t.ok && /reached your bank/.test(t.say) && t.deposits.issues.length, 'her answer: ' + t.say.slice(0, 110) + '…');
const api = (await import(P + 'deposits.js')).default;
const call = (method, query = {}, body) => new Promise((resolve) => { const res = { statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(o) { resolve({ status: this.statusCode, ...o }); }, end() { resolve({}); } }; api({ method, headers: { authorization: 'Bearer tok' }, query, body, url: '/api/deposits' }, res); });
const g = await call('GET', { days: '30' });
ok(g.ok && g.reconcile.payouts.length === 3 && g.reconcile.payouts.find((p) => p.id === 'po_A').adds_up === false, 'Deposits page: every deposit, and the one that doesn’t add up is marked');
const one = await call('GET', { payout: 'po_A' });
ok(one.ok && one.lines.length === 5 && one.lines.some((l) => l.client === 'Ana Lopez' && l.type === 'CHARGE') && one.lines.some((l) => l.type === 'DISPUTE'), 'tap a deposit → every sale (with the client), fee, dispute and adjustment inside it');
const sy = await call('POST', {}, { action: 'sync' });
ok(sy.ok && sy.deposits, '“Check now” re-reads Square');
const fs = await import('node:fs');
ok(/href: '\/deposits'/.test(fs.readFileSync(new URL('../../sidebar.js', import.meta.url), 'utf8')) && fs.existsSync(new URL('../../deposits.html', import.meta.url)), 'Growth → Deposits in the sidebar');
ok(/salon_payouts/.test(fs.readFileSync(new URL('../../sql/square-sales.sql', import.meta.url), 'utf8')) && /salon_payout_entries/.test(fs.readFileSync(new URL('../../sql/square-sales.sql', import.meta.url), 'utf8')), 'sql/square-sales.sql has the deposit tables too');

// ── Not granted yet → skipped, never an error ──
T.integrations[0].metadata = { ...T.integrations[0].metadata, scopes: ['PAYMENTS_READ', 'ORDERS_READ'] };
const s2 = await SD.syncEverything(db(), { ...integ, metadata: T.integrations[0].metadata }, { now: NOW, budgetMs: 20000 });
ok(s2.deposits?.skipped === 'needs_reconnect', 'a salon that hasn’t granted deposit access yet: sales still sync, deposits wait for the reconnect');
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
