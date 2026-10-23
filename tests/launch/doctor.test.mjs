// The doctor: LolaDesk checks itself, repairs what it can, verifies the repair by looking again, keeps the
// exact evidence when it can't (what was sent, what the provider answered, what it holds), and tells the
// platform owner once. No more guessing in circles.
import crypto from 'node:crypto';
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'tk';
process.env.INTEGRATION_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64'); process.env.CRON_SECRET = 'cron';
process.env.APP_URL = 'https://www.loladesk.com'; process.env.SENDGRID_API_KEY = 'sg'; process.env.EMAIL_FROM = 'lola@loladesk.com'; process.env.ADMIN_EMAILS = 'meddy@loladesk.com';
const BRAIN = 'assistant-77777777-2222-4333-8444-555555555555';
process.env.TELNYX_LOLA_BRAIN_ID = BRAIN;
process.env.SQUARE_APP_ID = 'sq0idp-loM-9aa_zQsNM1ct2wiY3w'; process.env.SQUARE_APP_SECRET = 'sq0csp-x'; delete process.env.SQUARE_ENV;
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const wh = (name) => ({ type: 'webhook', webhook: { name, description: name, url: 'https://www.loladesk.com/api/lola-tools?tool=' + name, method: 'POST' } });
const LIB = { 'lib-recall': 'recall_client', 'lib-confirm': 'confirm_booking', 'lib-other': 'transfer_to_salon' };
let stubborn = false; const mails = [];
const asst = { id: BRAIN, name: 'LolaBrain', greeting: '{{lola_greeting}}', instructions: '', model: 'zai-org/GLM-5.3-Flash', _inline: ['recall_client', 'confirm_booking', 'book_appointment', 'check_availability'].map(wh), tool_ids: ['lib-recall', 'lib-confirm', 'lib-other'],
  dynamic_variables: { lola_greeting: 'Hi, this call may be recorded. I’m Lola, an AI assistant.' }, dynamic_variables_webhook_url: 'https://www.loladesk.com/api/agent-variables', telephony_settings: { default_texml_app_id: 'app-1', supports_unauthenticated_web_calls: true } };
const view = () => ({ ...asst, tools: [...asst._inline, ...asst.tool_ids.map((id) => ({ type: 'webhook', id, shared: true, webhook: { name: LIB[id], url: 'https://elsewhere.example.com' } }))] });
let sq = { token: 'tok', scopes: ['APPOINTMENTS_READ'] };
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  if (u.includes('api.sendgrid.com')) { mails.push(JSON.parse(init.body)); return new Response('', { status: 202 }); }
  if (u.startsWith('https://connect.squareup.com')) {
    const path = u.replace('https://connect.squareup.com', '');
    if (path === '/oauth2/token/status') return J({ scopes: sq.scopes, merchant_id: 'M' });
    if (path === '/oauth2/token') return J({ access_token: 'tok', refresh_token: 'r', expires_at: new Date(Date.now() + 30 * 864e5).toISOString() });
    if (path.startsWith('/v2/locations')) return J({ locations: [{ id: 'L1', status: 'ACTIVE', timezone: 'America/New_York' }] });
    if (path.startsWith('/v2/payments')) return J({ payments: [] });
    if (path.startsWith('/v2/orders/search')) return J({ orders: [] });
    if (path.startsWith('/v2/customers')) return J({ customers: [] });
    if (path.startsWith('/v2/payouts')) return J({ payouts: [] });
    return J({});
  }
  if (init.method === 'DELETE') return J({ errors: [{ detail: 'not found' }] }, 404);
  const tm = u.match(/\/ai\/tools\/([\w-]+)$/); if (tm) return LIB[tm[1]] ? J({ data: { id: tm[1], type: 'webhook', tool_definition: { webhook: { name: LIB[tm[1]] } } } }) : J({}, 404);
  if (/\/ai\/tools(\?|$)/.test(u)) return J({ data: Object.entries(LIB).map(([id, n]) => ({ id, type: 'webhook', tool_definition: { webhook: { name: n } } })) });
  if (u.endsWith('/ai/openai/models')) return J({ data: [{ id: 'zai-org/GLM-5.3-Flash' }] });
  if (u.includes('/ai/assistants/' + BRAIN)) {
    if (init.method === 'POST' || init.method === 'PATCH') {
      const b = JSON.parse(init.body);
      const ids = Array.isArray(b.tool_ids) ? b.tool_ids : asst.tool_ids;              // docs: replaces
      const inline = (b.tools || asst._inline).map((t) => t.webhook?.name);
      const all = [...inline, ...ids.map((i) => LIB[i])];
      const dup = [...new Set(all.filter((x, i) => all.indexOf(x) !== i))];
      if (stubborn || dup.length) return J({ errors: [{ detail: 'Webhook tools names must be unique, the following are not unique: ' + (dup.length ? dup : ['recall_client']).join(', ') }] }, 422);
      if (b.tools) asst._inline = b.tools; asst.tool_ids = ids; const { tools, tool_ids, ...rest } = b; Object.assign(asst, rest);
    }
    return J({ data: view() });
  }
  if (u.includes('/ai/assistants')) return J({ data: [{ id: BRAIN, name: 'LolaBrain' }] });
  return J({ data: [] });
};
const { T } = await import('./fake-supabase.mjs');
const TID = '12121212-1212-4121-8121-121212121212';
T.tenants = [{ id: TID, name: 'MMA Salon', slug: 'mma', owner_email: 'owner@mmasalon.com' }];
for (const k of ['platform_settings', 'clients', 'bookings', 'lola_campaigns', 'lola_campaign_recipients', 'salon_sales', 'salon_sale_items', 'salon_payouts', 'salon_payout_entries', 'calendar_sync_jobs', 'cached_availability', 'booking_sync_log', 'usage_events']) T[k] = [];
const { encrypt } = await import('../../api/lib/crypto.js');
T.integrations = [{ id: 'int-sq', tenant_id: TID, provider: 'square', status: 'connected', access_token: encrypt('tok'), refresh_token: encrypt('r'), expires_at: new Date(Date.now() + 25 * 864e5).toISOString(), metadata: { merchant_id: 'M', location_id: 'L1' } }];
const P = new URL('../../api/', import.meta.url).href;
const { runDoctor, doctorLines } = await import(P + 'lib/doctor.js');
const { db } = await import(P + 'lib/db.js');
const byKey = (r, k) => r.checks.find((x) => x.key === k);

// ── 1. Telnyx duplicates: repaired, and verified by looking again ──
let r = await runDoctor({ c: db() });
const tt = byKey(r, 'telnyx_tools');
ok(tt.ok && tt.healed, 'Lola had Library copies of recall_client + confirm_booking → the doctor detached them (documented way) and checked again: clean');
{ const v = view().tools.map((t) => t.webhook?.name); ok(v.filter((n) => n === 'recall_client').length === 1 && v.filter((n) => n === 'confirm_booking').length === 1 && asst.tool_ids.includes('lib-other'), 'each tool exactly once — her other Library tool stays, nothing deleted'); }

// ── 2. When Telnyx still refuses: the exact evidence, not a guess ──
stubborn = true; asst.tool_ids = ['lib-recall', 'lib-other'];
r = await runDoctor({ c: db() });
const t2 = byKey(r, 'telnyx_tools');
ok(!t2.ok && t2.evidence && /library:recall_client/.test(t2.evidence.holds) && /not unique/.test(t2.evidence.telnyx_said) && /remove the Tools-Library copy of recall_client/.test(t2.fix), 'still refused → evidence: what Telnyx holds, what it said, and the one manual step');
const lines = doctorLines(r).join('\n');
ok(/✗ Lola on Telnyx \(tools\)/.test(lines) && /evidence: telnyx_said=/.test(lines), 'the live check prints it line by line');
stubborn = false;

// ── 3. Square app settings: the silent killer caught ──
const sa = byKey(r, 'square_app');
ok(sa.ok && /from the app id/.test(sa.detail), 'production Square app with SQUARE_ENV missing → healed by itself: production read from the app id (Connect no longer goes to Square’s test site)');
const SQC = await import(P + 'lib/connectors/square.js');
ok(SQC.squareEnv() === 'production' && SQC.getAuthUrl('s').startsWith('https://connect.squareup.com/oauth2/authorize?client_id=sq0idp-'), 'the Connect link goes to real Square');
process.env.SQUARE_ENV = 'sandbox';
const bad = byKey(await runDoctor({ c: db(), notify: false }), 'square_app');
ok(!bad.ok && /must be production/.test(bad.detail) && /SQUARE_ENV = production/.test(bad.fix), 'SQUARE_ENV set to the wrong value → caught, with the exact fix');
process.env.SQUARE_ENV = 'production';

// ── 4. A failed Connect is remembered and explained ──
const cb = (await import(P + 'oauth/callback.js')).default;
await new Promise((resolve) => { const res = { writeHead(c, h) { this.loc = h.Location; }, end() { resolve(); } }; cb({ url: '/api/oauth/callback?error=access_denied&error_description=user+denied', headers: { host: 'www.loladesk.com' } }, res); });
const oe = T.platform_settings.find((x) => x.key === 'oauth:last_error');
ok(oe && /access_denied/.test(oe.value.reason), 'a failed Square connect is recorded (it used to vanish)');
const fs = await import('node:fs');
const set = fs.readFileSync(new URL('../../settings.html', import.meta.url), 'utf8');
ok(/didn’t connect/.test(set) && /fixFor/.test(set) && /is connected\. Lola is reading everything now/.test(set), 'and Settings now says what happened after Connect — success or the reason + the fix');

// ── 5. Square connection: permissions + data ──
T.integrations[0].metadata = { merchant_id: 'M', location_id: 'L1' };
r = await runDoctor({ c: db() });
const sc = byKey(r, 'square_connections');
ok(!sc.ok && /must reconnect once/.test(sc.detail) && T.integrations[0].metadata.missing_scopes.includes('PAYMENTS_READ'), 'connected with old permissions → flagged “reconnect once” (Settings shows Reconnect)');
sq.scopes = (await import(P + 'lib/connectors/square.js')).SCOPE_LIST;
r = await runDoctor({ c: db() });
const sc2 = byKey(r, 'square_connections');
ok(sc2.ok && /synced now/.test(String(sc2.healed || sc2.detail)), 'full permissions + data never read → the doctor syncs it right away: ' + sc2.detail);

// ── 6. Tables + jobs ──
ok(byKey(r, 'tables').ok && byKey(r, 'crons').ok, 'database tables and background jobs checked');

// ── 7. Told once — and told when fixed ──
const alertsBefore = mails.length;
await runDoctor({ c: db() });
ok(mails.length === alertsBefore, 'nothing new → no alert (never spams)');
ok(mails.some((m) => /doctor/i.test(JSON.stringify(m))), 'the platform owner was alerted about problems and about fixes');

// ── 8. Live check shows it; settings know who must reconnect ──
const st = await import(P + 'status.js');
const pub = st.publicStatus({ ok: false, live: { doctor_lines: ['✗ Square app settings: key sq0csp-abcdefghijklmnop leaked? → fix'], square_connections: 1, square_reconnect: 1 }, healed: [], fixes: [] });
ok(pub.live.doctor_lines?.length === 1 && !/abcdefghijklmnop/.test(pub.live.doctor_lines[0]) && pub.live.square_connections === 1, 'the public live check shows the doctor’s lines (secrets scrubbed) and the Square counts');
const heal = fs.readFileSync(new URL('../../api/cron/lola-heal.js', import.meta.url), 'utf8');
ok(/runDoctor/.test(heal), 'and it runs by itself every 30 minutes (cron lola-heal)');
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
