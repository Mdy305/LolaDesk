// ONE voice, everywhere: the valet-girl Lola from ElevenLabs. Every phone assistant is switched to it
// (the ElevenLabs key linked in Telnyx automatically), the app never substitutes another voice,
// and /api/status says exactly why she's quiet when she is.
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'secret-key-123';
process.env.TELNYX_LOLA_BRAIN_ID = 'assistant-1'; process.env.TELNYX_VOICE_APP_ID = 'v1'; process.env.CRON_SECRET = 'x'; process.env.ADMIN_EMAILS = 'a@b.c'; process.env.INTEGRATION_ENCRYPTION_KEY = 'k';
process.env.ELEVENLABS_API_KEY = 'el-key-999'; process.env.ELEVENLABS_VOICE_ID = 'ValetLola01'; delete process.env.VOICE_PROVIDER; delete process.env.LOLA_TELNYX_VOICE;
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const telnyxTts = [], updates = [], secrets = [], numberPatches = []; let quota = { character_count: 100, character_limit: 100000 }, elevenTts = 200;
const assistants = [
  { id: 'assistant-1', name: 'Lola', greeting: '{{lola_greeting}}', voice_settings: { voice: 'Telnyx.KokoroTTS.af_heart', voice_speed: 1 }, telephony_settings: { default_texml_app_id: 'app-1' } },
  { id: 'assistant-care', name: 'LolaDesk Support', greeting: 'Hi', voice_settings: { voice: 'Telnyx.NaturalHD.astra' } },
];
const phone = [{ id: 'n1', phone_number: '+13055550100', connection_id: 'app-1', messaging_profile_id: 'mp' }, { id: 'n2', phone_number: '+13055550101', connection_id: null, messaging_profile_id: 'mp' }];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  if (u.includes('api.telnyx.com/v2/text-to-speech')) { telnyxTts.push(u); return new Response(new Uint8Array(3000), { status: 200 }); }
  if (u.includes('api.elevenlabs.io/v1/user/subscription')) return J(quota);
  if (u.includes('api.elevenlabs.io/v1/text-to-speech/ValetLola01')) return elevenTts === 200 ? new Response(new Uint8Array(5000), { status: 200, headers: { 'content-type': 'audio/mpeg' } }) : J({ detail: { status: 'quota_exceeded' } }, elevenTts);
  if (u.includes('/integration_secrets')) { if (init.method === 'POST') { const b = JSON.parse(init.body); secrets.push(b); return J({ data: { identifier: b.identifier } }, 201); } return J({ data: secrets.map((s) => ({ identifier: s.identifier })) }); }
  const am = u.match(/\/ai\/assistants\/([^/?]+)/);
  if (am) { const a = assistants.find((x) => x.id === decodeURIComponent(am[1])); if (init.method === 'POST' || init.method === 'PATCH') { const b = JSON.parse(init.body); updates.push({ id: a.id, ...b }); Object.assign(a, b); } return J({ data: a }); }
  if (u.includes('/ai/assistants')) return J({ data: assistants });
  if (/\/phone_numbers\/n\d\/voice/.test(u)) { numberPatches.push(u); const n = phone.find((p) => u.includes('/' + p.id + '/')); n.connection_id = JSON.parse(init.body).connection_id; return J({ data: n }); }
  if (u.includes('/phone_numbers')) return J({ data: phone });
  if (u.endsWith('/balance')) return J({ data: { balance: '12.50', available_credit: '12.50' } });
  if (u.includes('/ai/models')) return J({ data: [{ id: 'meta-llama/Llama-3.3-70B-Instruct' }] });
  if (u.includes('/10dlc/phone_number_campaigns')) return J({ records: phone.map((p) => ({ phoneNumber: p.phone_number })) });
  return J({ data: [] });
};
const { T } = await import('./fake-supabase.mjs');
T.tenants = [{ id: 't1', phone_number: '+13055550100' }];
T.tenant_numbers = [{ tenant_id: 't1', phone_number: '+13055550100', status: 'active' }, { tenant_id: 't1', phone_number: '+13055550101', status: 'active' }];
T.tenant_channels = []; T.settings = [];
const P = new URL('../../api/', import.meta.url).href;
const ov = await import(P + 'lib/one-voice.js');

ok(ov.lolaPhoneVoice() === 'ElevenLabs.eleven_multilingual_v2.ValetLola01', 'her phone voice = her ElevenLabs voice id, in Telnyx’s format');
ok(!ov.voiceIsLola(assistants[0].voice_settings) && ov.voiceIsLola({ voice: 'ElevenLabs.eleven_turbo_v2_5.ValetLola01', api_key_ref: 'x' }) && !ov.voiceIsLola({ voice: 'ElevenLabs.eleven_turbo_v2_5.ValetLola01' }), 'a Telnyx voice is not her; her voice without the linked key is not enough');

// ── /api/status: finds every assistant in another voice, switches them, says so ──
const { buildStatus } = await import(P + 'status.js');
let s = await buildStatus();
ok(s.live.voice_app === true && telnyxTts.length === 0, 'in the app: she speaks in her ElevenLabs voice (no Telnyx stand-in)');
ok(secrets.length === 1 && secrets[0].type === 'bearer' && secrets[0].token === 'el-key-999' && /^loladesk_elevenlabs_[0-9a-f]{8}$/.test(secrets[0].identifier), 'the ElevenLabs key is linked in Telnyx once, as an integration secret');
const v1 = updates.filter((u) => u.voice_settings);
ok(v1.length === 2 && v1.every((u) => u.voice_settings.voice === 'ElevenLabs.eleven_multilingual_v2.ValetLola01' && u.voice_settings.api_key_ref === secrets[0].identifier), 'both phone assistants (salon Lola + support Lola) now speak in her voice');
ok(assistants[0].voice_settings.voice_speed === 1, 'their other voice settings are kept');
ok(s.healed.some((h) => /2 phone assistants now speak in Lola’s own voice/.test(h) && /KokoroTTS/.test(h)), 'status says what it switched: ' + s.healed[0]);
ok(numberPatches.some((u) => u.includes('/n2/')) && s.live.salon_numbers_ringing_lola === 2, 'the salon number that didn’t ring Lola now does');
ok(s.ok && s.fixes.length === 0, 'nothing left to fix');
ok(!JSON.stringify(s).includes('el-key-999') && !JSON.stringify(s).includes('secret-key-123') && !JSON.stringify(s).includes('+1305'), 'never reveals a key or a phone number');
updates.length = 0;
await ov.unifyAssistantVoices({ heal: true });
ok(updates.length === 0 && secrets.length === 1, 'already her voice → left alone (idempotent)');

// ── ElevenLabs out of credit: she is quiet, never someone else; the fix is named ──
quota = { character_count: 100000, character_limit: 100000 }; elevenTts = 401;
const fresh = (await import(P + 'status.js?quota')).buildStatus;
s = await fresh();
ok(s.live.voice_app === false && telnyxTts.length === 0, 'out of credit → no different voice anywhere');
ok(s.fixes.some((f) => /ElevenLabs is out of credit/.test(f) && /never switches to a different voice/.test(f)), 'the fix says exactly that: ' + s.fixes.find((f) => /ElevenLabs/.test(f)));

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
