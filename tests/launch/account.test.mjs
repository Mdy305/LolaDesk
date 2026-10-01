// LolaDesk sets up its own Telnyx account: adopts (or creates) the texting
// profile and points incoming texts at LolaDesk, switches on outbound calling,
// and links every salon number to that profile — no portal clicking.
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'k';
delete process.env.TELNYX_MESSAGING_PROFILE_ID; delete process.env.TELNYX_MESSAGING_PROFILE; delete process.env.TELNYX_LOLA_BRAIN_ID;
process.env.TELNYX_VOICE_APP_ID = '2982432232334951429'; process.env.APP_URL = 'https://www.loladesk.com';
const tx = { profiles: [{ id: 'mp-old', name: 'Default', webhook_url: 'https://old.example.com/sms' }], app: { id: '2982432232334951429', application_name: 'LolaDesk', webhook_event_url: 'https://www.loladesk.com/api/telnyx-voice', outbound: {} }, ovps: [{ id: 'ovp1', name: 'Main', enabled: true }], numbers: [{ id: 'pn1', phone_number: '+13055550100', messaging_profile_id: null, connection_id: 'c1' }] };
const log = [];
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url)); const m = init.method || 'GET'; const b = init.body ? JSON.parse(init.body) : null;
  const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  log.push(m + ' ' + u.pathname);
  if (u.pathname === '/v2/messaging_profiles' && m === 'GET') return J({ data: tx.profiles });
  const mp = u.pathname.match(/^\/v2\/messaging_profiles\/(.+)$/);
  if (mp) { const p = tx.profiles.find(x => x.id === mp[1]); if (!p) return J({ errors: [{ detail: 'not found' }] }, 404); if (m === 'PATCH') Object.assign(p, b); return J({ data: p }); }
  if (u.pathname === '/v2/call_control_applications/2982432232334951429') { if (m === 'PATCH') Object.assign(tx.app, b); return J({ data: tx.app }); }
  if (u.pathname === '/v2/outbound_voice_profiles') return J({ data: tx.ovps });
  if (u.pathname === '/v2/phone_numbers') return J({ data: tx.numbers, meta: { total_pages: 1 } });
  const pm = u.pathname.match(/^\/v2\/phone_numbers\/(pn\d)\/(messaging|voice)$/);
  if (pm && m === 'PATCH') { const n = tx.numbers.find(x => x.id === pm[1]); if (pm[2] === 'messaging') n.messaging_profile_id = b.messaging_profile_id; else n.connection_id = b.connection_id; return J({ data: n }); }
  return J({ data: [] });
};
const { T } = await import('./fake-supabase.mjs');
const P = new URL('../../api/', import.meta.url).href;
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
T.platform_settings = []; T.tenants = [{ id: 't1', name: 'MMA Salon', phone_number: '+13055550100' }]; T.tenant_numbers = [{ tenant_id: 't1', phone_number: '+13055550100', status: 'active', kind: 'primary' }];
const { wireAccount } = await import(P + 'lib/telnyx-account.js');
const { db } = await import(P + 'lib/db.js');
let r = await wireAccount(db(), { heal: false });
ok(!r.ok && !r.voice.ok && log.every(l => !l.startsWith('PATCH')), 'a look changes nothing and finds what’s missing');
r = await wireAccount(db(), { heal: true });
ok(r.messaging.ok && r.messaging.id === 'mp-old' && tx.profiles[0].webhook_url === 'https://www.loladesk.com/api/telnyx-sms', 'texting profile adopted; incoming texts now go to LolaDesk');
ok(T.platform_settings.some(x => x.key === 'telnyx_messaging_profile_id'), 'remembered without needing a Vercel variable');
ok(r.voice.ok && tx.app.outbound.outbound_voice_profile_id === 'ovp1' && tx.app.application_name === 'LolaDesk', 'outbound calling switched on (outbound voice profile attached)');
const { wireTenantNumbers } = await import(P + 'lib/tenant-wiring.js');
const w = await wireTenantNumbers(db(), { heal: true });
ok(w.ok && tx.numbers[0].messaging_profile_id === 'mp-old', 'every salon number joins that texting profile');
r = await wireAccount(db(), { heal: true });
ok(r.ok && !r.messaging.did.length && !r.voice.did.length, 'second run: all set, nothing to change');
tx.profiles = []; T.platform_settings = [];
const { wireMessaging } = await import(P + 'lib/telnyx-account.js');
let created = null; const of = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => { const u = new URL(String(url)); if (u.pathname === '/v2/messaging_profiles' && init.method === 'POST') { created = JSON.parse(init.body); return new Response(JSON.stringify({ data: { id: 'mp-new', ...created } }), { status: 200, headers: { 'content-type': 'application/json' } }); } return of(url, init); };
const m2 = await wireMessaging(db(), { heal: true });
ok(m2.ok && created?.name === 'LolaDesk' && created.webhook_url === 'https://www.loladesk.com/api/telnyx-sms', 'no profile at all → LolaDesk creates one');
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
