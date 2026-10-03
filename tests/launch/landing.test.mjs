// The front door: a landing page that sells honestly and converts, every sign-up URL lands in the
// wizard, and the wizard is truly multi-tenant (a salon never sees another salon's number or the platform's balance).
import fs from 'node:fs';
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'tk'; process.env.ADMIN_EMAILS = 'boss@loladesk.com';
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const R = (f) => fs.readFileSync(new URL('../../' + f, import.meta.url), 'utf8');
const html = R('index.html');
ok(/Never miss<br>a client <span>again\.<\/span>/.test(html) && (html.match(/href="\/start/g) || []).length >= 5, 'one idea in the hero, and every path leads to “Start free”');
ok(/id="callForm"/.test(html) && /\/api\/demo-call/.test(html) && /AI assistant; the call may be recorded/.test(html), 'live demo: Lola calls the visitor — with the AI + recording notice');
ok(/data-voice-demo="book"/.test(html) && /data-voice-demo="recover"/.test(html) && /data-voice-demo="upsell"/.test(html) && /\/lola-sound\.js/.test(html), 'hear her work: three real scenarios in her one voice');
ok(/data-m="99"/.test(html) && /data-m="399"/.test(html) && /data-m="599"/.test(html) && /plan=pro/.test(html) && /billing=/.test(html), 'pricing: the same three plans and plan links');
ok(/telnyx-ai-agent/.test(html) && /customer-care\?public=1/.test(html), 'talk to Lola live (the current support assistant, not a hard-coded stale id)');
ok(!/HIPAA-(compliant|aware)/i.test(html) && !/not realizing|won't believe she's AI|most advanced AI on earth/i.test(html), 'no claims that contradict the Terms or the AI disclosure');
for (const p of ['/privacy', '/terms', '/sms-terms', '/ai', '/legal', '/support']) ok(html.includes(`href="${p}"`), 'footer links ' + p);
ok(!/<section class="reveal">/.test(html) && /classList\.remove\('js'\)/.test(html), 'content is visible even if animations never run (no more black voids)');
ok(fs.existsSync(new URL('../../index-classic.html', import.meta.url)), 'the previous landing is kept at /index-classic');
ok(/id="awakeText"/.test(html) && html.includes('Lola isn'), 'she is alive: she knows the visitor’s time of day (“It’s 11:40 PM. Your salon is closed. Lola isn’t.”)');
ok(/class="stage" id="orbWrap"/.test(html) && /bleed:0\.32/.test(html) && /LolaWakeBurst\.trigger\(stage\)/.test(html) && /lola-wake-burst\.js/.test(html), 'the signature: her full particle body is the hero, she forms on arrival and speaks when tapped');
ok(/id="phPlay"/.test(html) && /Text sent/.test(html) && /lolaSays\(/.test(html), 'a full call, start to finish, in her real voice — ending in a booking and the confirmation text');
ok(/<title>AI Receptionist for Salons &amp; Spas/.test(html) && /"@type":"Organization"/.test(html) && /"@type":"FAQPage"/.test(html), 'SEO: the words salon owners search, structured data for Google');
const SLUGS = ['hair-salons', 'barbershops', 'nail-salons', 'med-spas', 'day-spas', 'lash-and-brow-studios'];
for (const s of SLUGS) {
  const pg = R('ai-receptionist/' + s + '.html');
  ok(html.includes('/ai-receptionist/' + s) && /<link rel="canonical" href="https:\/\/www\.loladesk\.com\/ai-receptionist\//.test(pg) && /"@type": "FAQPage"/.test(pg) && /href="\/start"/.test(pg) && /AI assistant/.test(pg), 'SEO page for ' + s + ': linked, canonical, FAQ data, Start free, honest');
}
const sm = R('sitemap.xml');
ok(SLUGS.every((s) => sm.includes('/ai-receptionist/' + s)) && sm.includes('2026-10-03'), 'sitemap lists every page');
const vj = JSON.parse(R('vercel.json'));
for (const s of ['/signup', '/sign-up', '/register', '/join', '/trial', '/start', '/get-started']) ok(vj.redirects.some((r) => r.source === s && r.destination === '/onboarding'), s + ' → the sign-up wizard');

// ── the wizard's number step is multi-tenant ──
const owned = [{ id: 'a', phone_number: '+13055550100' }, { id: 'b', phone_number: '+13055550101' }, { id: 'c', phone_number: '+13055550102' }];
let bought = 0;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  if (u.includes('/available_phone_numbers')) return J({ data: [{ phone_number: '+13055559999' }] });
  if (u.includes('/phone_numbers?page')) return J({ data: owned });
  if (u.includes('/balance')) return J({ data: { balance: '123.45', available_credit: '123.45', currency: 'USD' } });
  if (u.includes('/number_orders')) { bought++; return J({ data: { id: 'o' } }); }
  return J({ data: [] });
};
const { T } = await import('./fake-supabase.mjs');
T.tenants = [{ id: 'mma', slug: 'mma', phone_number: '+13055550100', owner_email: 'm@mma.com' }, { id: 'new', slug: 'new', phone_number: null, owner_email: 'n@new.com' }];
T.tenant_users = [{ user_id: 'un', tenant_id: 'new', role: 'owner', status: 'active' }, { user_id: 'um', tenant_id: 'mma', role: 'owner', status: 'active' }];
T.tenant_numbers = [{ tenant_id: 'mma', phone_number: '+13055550100', status: 'active' }, { tenant_id: 'mma', phone_number: '+13055550101', status: 'active' }];
T.platform_settings = [];
globalThis.__authUsers = { tokNew: { id: 'un', email: 'n@new.com' }, tokMma: { id: 'um', email: 'm@mma.com' } };
const P = new URL('../../api/', import.meta.url).href;
const h = (await import(P + 'provision-number.js')).default;
const run = (req) => new Promise((resolve) => { const res = { statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(o) { resolve({ status: this.statusCode, ...o }); }, end() { resolve({ status: this.statusCode }); } }; h({ query: {}, headers: {}, ...req }, res); });
let r = await run({ method: 'GET', headers: { authorization: 'Bearer tokNew' } });
ok(r.ok && r.owned.map((n) => n.phone_number).join() === '+13055550102', 'a new salon only sees numbers no salon uses (never MMA’s): ' + r.owned.map((n) => n.phone_number).join());
ok(r.balance === null, 'and never the platform’s Telnyx balance');
r = await run({ method: 'POST', headers: { authorization: 'Bearer tokMma' }, body: {} });
ok(r.ok && r.already && r.phoneNumber === '+13055550100' && bought === 0, 'a salon that already has its Lola number isn’t charged for a second one from the wizard');
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
