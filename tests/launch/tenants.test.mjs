// Many salons, one Telnyx account: each salon texts and answers on its OWN
// line, never another salon's; every salon number is kept wired to texts
// (messaging profile) and to Lola (voice connection), healed if it drifts.
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'k';
process.env.TELNYX_FROM_NUMBER = '+13055550000';                 // the platform's own line
delete process.env.TELNYX_MESSAGING_PROFILE; process.env.TELNYX_MESSAGING_PROFILE_ID = 'mp-platform';
process.env.TELNYX_VOICE_APP_ID = 'voice-app'; delete process.env.TELNYX_LOLA_BRAIN_ID;
const sent = [], patched = [];
const live = {
  '+13055550100': { id: 'pn-a', phone_number: '+13055550100', messaging_profile_id: 'mp-platform', connection_id: 'voice-app' },
  '+17865550200': { id: 'pn-b', phone_number: '+17865550200', messaging_profile_id: null, connection_id: null },
};
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  if (u.includes('/v2/messages')) { sent.push(JSON.parse(init.body)); return J({ data: { id: 'm' + sent.length } }); }
  const pm = u.match(/\/phone_numbers\/(pn-[ab])(?:\/(messaging|voice))?(?:\?|$)/);
  if (pm && init.method === 'PATCH') {
    pm[2] = pm[2] || 'voice';   // connection_id is set on PATCH /phone_numbers/{id}
    const b = JSON.parse(init.body); patched.push(pm[1] + ':' + pm[2]);
    const n = Object.values(live).find(x => x.id === pm[1]);
    if (pm[2] === 'messaging') n.messaging_profile_id = b.messaging_profile_id; else n.connection_id = b.connection_id;
    return J({ data: n });
  }
  if (u.includes('/v2/phone_numbers')) return J({ data: Object.values(live), meta: { total_pages: 1 } });
  return J({ data: [] });
};
const { T } = await import('./fake-supabase.mjs');
const P = new URL('../../api/', import.meta.url).href;
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const A = '00000000-0000-4000-8000-00000000000a', B = '00000000-0000-4000-8000-00000000000b', C = '00000000-0000-4000-8000-00000000000c';
T.tenants = [{ id: A, name: 'Salon A', phone_number: '+13055550100' }, { id: B, name: 'Salon B', phone_number: '+17865550200' }, { id: C, name: 'Salon C (no line yet)' }];
T.tenant_numbers = [{ tenant_id: A, phone_number: '+13055550100', kind: 'primary', status: 'active' }, { tenant_id: B, phone_number: '+17865550200', kind: 'primary', status: 'active' }];
T.client_memories = []; T.opt_outs = []; T.clients = [];

const { sendSms } = await import(P + 'lib/sms.js');
await sendSms({ tenantId: A, to: '+13055551111', text: 'From A' });
await sendSms({ tenantId: B, to: '+13055552222', text: 'From B' });
const rc = await sendSms({ tenantId: C, to: '+13055553333', text: 'From C' });
ok(sent[0]?.from === '+13055550100' && sent[1]?.from === '+17865550200', 'each salon texts from its own line');
ok(rc?.skipped && rc.reason === 'no_salon_number' && !sent.some(m => m.text === 'From C'), 'a salon without a line never borrows another salon’s (or the platform’s) number');
await sendSms({ to: '+13055554444', text: 'Platform note' });
ok(sent.at(-1)?.from === '+13055550000', 'platform messages still use the platform line');

const { sendSMS: legacy } = await import(P + 'lib/telnyx.js');
await legacy({ from: '+17865550200', to: '+13055555555', text: 'legacy path', tenantId: B });
ok(sent.at(-1)?.text === 'legacy path', 'the old sender now goes through the one funnel (opt-outs, logging)');

const { wireTenantNumbers } = await import(P + 'lib/tenant-wiring.js');
const { db } = await import(P + 'lib/db.js');
let w = await wireTenantNumbers(db(), { heal: false });
ok(!w.ok && w.broken === 1 && w.numbers.find(n => n.tenant_id === B && !n.texts && !n.calls), 'drift found: Salon B’s number can’t text or take calls');
w = await wireTenantNumbers(db(), { heal: true });
ok(w.ok && w.healed === 1 && patched.includes('pn-b:messaging') && patched.includes('pn-b:voice') && !patched.some(p => p.startsWith('pn-a')), 'healed: only Salon B re-wired to texts and to Lola');
w = await wireTenantNumbers(db(), { tenantId: A });
ok(w.ok && w.numbers.length === 1 && w.numbers[0].phone_number === '+13055550100', 'one salon’s check only touches that salon');

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
