// /api/status: one public call that says what's live and exactly what to fix — never a secret.
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'secret-key-123';
delete process.env.CRON_SECRET; process.env.TELNYX_LOLA_BRAIN_ID = 'assistant-1'; process.env.TELNYX_VOICE_APP_ID = 'v1';
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
let registered = [];
globalThis.fetch = async (url) => {
  const u = String(url), J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  if (u.endsWith('/balance')) return J({ data: { balance: '12.50', available_credit: '12.50' } });
  if (u.includes('/ai/models')) return J({ data: [{ id: 'meta-llama/Llama-3.3-70B-Instruct' }, { id: 'moonshotai/Kimi-K2.6' }] });
  if (u.includes('/phone_numbers')) return J({ data: [{ phone_number: '+13055550100' }, { phone_number: '+13055550101' }] });
  if (u.includes('/10dlc/phone_number_campaigns')) return J({ records: registered.map((p) => ({ phoneNumber: p })) });
  return J({ data: [] });
};
const { T } = await import('./fake-supabase.mjs');
T.tenants = [{ id: 't' }];
const { buildStatus } = await import(new URL('../../api/status.js', import.meta.url).href);
let s = await buildStatus();
ok(s.live.database && s.live.telnyx_key && s.live.telnyx_ai && s.live.fast_model, 'live probes: database, Telnyx key, Telnyx AI, fast model');
ok(s.live.numbers === 2 && s.live.numbers_registered_10dlc === 0 && s.fixes.some((f) => /10DLC/.test(f)), 'unregistered numbers → “texts get blocked, register 10DLC”');
ok(s.fixes.some((f) => /CRON_SECRET/.test(f)), 'missing CRON_SECRET is named with the exact fix');
ok(!JSON.stringify(s).includes('secret-key-123') && !JSON.stringify(s).includes('+1305'), 'never reveals a key or a phone number');
registered = ['+13055550100', '+13055550101']; process.env.CRON_SECRET = 'x'; process.env.ADMIN_EMAILS = 'a@b.c'; process.env.INTEGRATION_ENCRYPTION_KEY = 'k';
s = await buildStatus();
ok(s.ok && s.fixes.length === 0, 'all set → ok, nothing to fix');
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
