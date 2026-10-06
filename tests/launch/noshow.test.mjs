// No-show fees: never guessed. Only a booking the salon marked "no-show" is considered, only when the
// salon's ONE policy (booking_settings.metadata.deposits) says so, and the client gets one link — once.
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'k';
process.env.CRON_SECRET = 'cron'; process.env.STRIPE_SECRET_KEY = 'sk_test_x';
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const sms = [], links = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  if (u.includes('api.stripe.com') && u.includes('/payment_links')) { links.push(String(init.body)); return J({ id: 'plink_' + links.length, url: 'https://buy.stripe.com/x' + links.length }); }
  if (u.includes('api.stripe.com')) return J({ id: 'acct_x', charges_enabled: true });
  if (u.includes('/v2/messages')) { sms.push(JSON.parse(init.body)); return J({ data: { id: 'm' + sms.length } }); }
  return J({ data: [] });
};
const { T } = await import('./fake-supabase.mjs');
const TID = '00000000-0000-4000-8000-00000000ab01';
const ago = (h) => new Date(Date.now() - h * 3600e3).toISOString();
T.tenants = [{ id: TID, name: 'MMA Salon', phone_number: '+13055550100', subscription_status: 'active' }];
T.clients = [{ id: 'c1', tenant_id: TID, name: 'Sarah Kim', phone: '+13055554444' }, { id: 'c2', tenant_id: TID, name: 'Bo Lee', phone: '+13055555555' }];
T.services = [{ id: 's1', tenant_id: TID, name: 'Haircut', price: 80 }];
T.bookings = [
  { id: 'b-done', tenant_id: TID, client_id: 'c1', service_id: 's1', status: 'confirmed', start_time: ago(5) },   // happened, never checked out
  { id: 'b-ns', tenant_id: TID, client_id: 'c1', service_id: 's1', status: 'no_show', start_time: ago(3) },        // salon marked no-show
];
T.payments = []; T.deposits = []; T.tenant_numbers = []; T.opt_outs = []; T.usage_events = []; T.messages = []; T.conversations = []; T.integrations = [];
T.booking_settings = [{ tenant_id: TID, metadata: { deposits: { no_show: { enabled: false, type: 'fixed', amount: 25 }, auto_charge: { no_show_fee: true } } } }];
const P = new URL('../../api/', import.meta.url).href;
const scan = (await import(P + 'cron/no-show-scan.js')).default;
const run = (auth = 'Bearer cron') => new Promise((resolve) => { const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(o) { resolve({ status: this.statusCode, ...o }); } }; scan({ method: 'GET', headers: { authorization: auth } }, res); });

let r = await run('Bearer nope');
ok(r.status === 401, 'only Vercel Cron can run it');
r = await run();
ok(r.ok && !sms.length && T.bookings.find((b) => b.id === 'b-done').status === 'confirmed', 'policy off → nothing charged, and a visit that wasn’t checked out is never turned into a no-show');

T.booking_settings[0].metadata.deposits.no_show.enabled = true;
r = await run();
ok(sms.length === 1 && /\$25\.00 missed-appointment fee/.test(sms[0].text) && /buy\.stripe\.com/.test(sms[0].text), 'policy on → the marked no-show gets one kind text with the fee link: ' + (sms[0]?.text || ''));
ok(T.payments.length === 1 && T.payments[0].sub_kind === 'no_show_fee' && T.payments[0].amount === 2500 && T.payments[0].stripe_id === 'plink_1', 'the fee is recorded for the salon (Payments)');
ok(/kind.*no_show_fee|no_show_fee/.test(decodeURIComponent(links[0] || '')), 'the Stripe link is tagged as a no-show fee');
r = await run();
ok(sms.length === 1 && T.payments.length === 1, 'the next run never texts again');

T.booking_settings[0].metadata.deposits.no_show.waive_first_offense = true;
T.bookings.push({ id: 'b-ns2', tenant_id: TID, client_id: 'c2', service_id: 's1', status: 'no_show', start_time: ago(2) });
r = await run();
ok(sms.length === 1 && T.payments.some((p) => p.booking_id === 'b-ns2' && p.status === 'waived'), 'first no-show forgiven when the salon chose that');
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
