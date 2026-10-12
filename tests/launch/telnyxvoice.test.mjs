// The owner chose Telnyx for Lola's voice (VOICE_PROVIDER=telnyx): ONE real Telnyx voice everywhere —
// the app, every phone assistant and the calls LolaDesk places. The voice is never guessed: it comes from
// Telnyx's own voice list (a natural en-US female first), and a voice Telnyx refuses is replaced by the next.
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'tk';
const BRAIN = 'assistant-57f2d23e-48b1-4107-9811-c40b296f15b6';
process.env.TELNYX_LOLA_BRAIN_ID = BRAIN; process.env.APP_URL = 'https://www.loladesk.com';
process.env.VOICE_PROVIDER = 'telnyx'; delete process.env.LOLA_TELNYX_VOICE; delete process.env.TELNYX_TTS_VOICE;
process.env.ELEVENLABS_API_KEY = 'out-of-credit'; process.env.ELEVENLABS_VOICE_ID = 'ValetLola01';
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const VOICES = [
  { voice_id: 'Telnyx.KokoroTTS.am_adam', language: 'en-US', gender: 'male' },
  { voice_id: 'Telnyx.NaturalHD.astra', language: 'en-US', gender: 'female' },
  { voice_id: 'Telnyx.KokoroTTS.af_heart', language: 'en-US', gender: 'female' },
  { voice_id: 'Telnyx.NaturalHD.marcel', language: 'fr-FR', gender: 'male' },
];
const ASSISTANT_OK = new Set(['Telnyx.KokoroTTS.af_heart', 'Telnyx.NaturalHD.astra']);
let ttsBroken = new Set();
const A = {
  [BRAIN]: { id: BRAIN, name: 'LolaBrain', greeting: '{{lola_greeting}}', instructions: 'You are Lola.', tools: [],
    voice_settings: { voice: 'ElevenLabs.eleven_multilingual_v2.ValetLola01', api_key_ref: 'loladesk_elevenlabs_x' },
    dynamic_variables: { lola_greeting: 'Hi, this call may be recorded. I’m Lola, an AI assistant.' },
    dynamic_variables_webhook_url: 'https://www.loladesk.com/api/agent-variables', dynamic_variables_webhook_timeout_ms: 3000,
    telephony_settings: { default_texml_app_id: 'app-1', supports_unauthenticated_web_calls: true } },
  'assistant-front': { id: 'assistant-front', name: 'Front Desk Receptionist Workflow', voice_settings: { voice: 'Telnyx.Ultra.Clara' } },
};
const calls = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  calls.push(u);
  if (u.includes('elevenlabs')) return J({ detail: { code: 'quota_exceeded' } }, 401);
  if (u.includes('/text-to-speech/voices')) return J({ voices: VOICES });
  if (u.includes('/text-to-speech/speech')) { const v = JSON.parse(init.body).voice; calls.push('voice=' + v); if (ttsBroken.has(v) || !VOICES.some((x) => x.voice_id === v)) return J({ errors: { detail: 'Internal Server Error' } }, 500); return new Response(Buffer.alloc(800, 1), { headers: { 'content-type': 'audio/mpeg' } }); }
  const m = u.match(/\/ai\/assistants\/([^/?]+)/);
  if (m && A[m[1]]) {
    if (init.method === 'POST' || init.method === 'PATCH') {
      const b = JSON.parse(init.body);
      if (b.voice_settings && !ASSISTANT_OK.has(b.voice_settings.voice)) return J({ errors: [{ detail: `Voice \`${b.voice_settings.voice}\` not found. Ensure the voice ID is valid.` }] }, 422);
      if (b.voice_settings) A[m[1]].voice_settings = b.voice_settings; else Object.assign(A[m[1]], b);
      return J({ data: A[m[1]] });
    }
    return J({ data: A[m[1]] });
  }
  if (u.includes('/ai/assistants')) return J({ data: Object.values(A) });
  return J({ data: [] });
};
await import('./fake-supabase.mjs');
const P = new URL('../../api/', import.meta.url).href;
const el = await import(P + 'lib/elevenlabs.js');
const ov = await import(P + 'lib/one-voice.js');
const v = await el.resolveTelnyxVoice();
ok(v === 'Telnyx.NaturalHD.astra', 'picked from Telnyx’s own list: a natural en-US female voice (never a made-up id): ' + v);
const { wireAssistant } = await import(P + 'lib/assistant-wiring.js');
const w = await wireAssistant({ heal: true });
ok(A[BRAIN].voice_settings.voice === 'Telnyx.NaturalHD.astra' && !A[BRAIN].voice_settings.api_key_ref && !w.voice?.error, 'LolaBrain speaks with it on the phone (no ElevenLabs link): ' + JSON.stringify(A[BRAIN].voice_settings));
const u1 = await ov.unifyAssistantVoices({ heal: true });
ok(A['assistant-front'].voice_settings.voice === 'Telnyx.NaturalHD.astra' && !u1.errors.length, 'the assistant stuck on a voice Telnyx doesn’t have gets the real one: ' + JSON.stringify(u1.errors));
ok(JSON.stringify(await ov.lolaSpeakVoice()) === '{"voice":"Telnyx.NaturalHD.astra"}', 'calls LolaDesk places start in the same voice');
const buf = await el.synthesize('Hi');
ok(buf.length > 200 && calls.includes('voice=Telnyx.NaturalHD.astra') && !calls.some((c) => c.includes('elevenlabs.io/v1/text-to-speech')), 'the app speaks with it too — ElevenLabs credit no longer matters');

// Telnyx stops serving that voice → the next real one, automatically
ttsBroken.add('Telnyx.NaturalHD.astra');
const buf2 = await el.synthesize('Hi again');
ok(buf2.length > 200 && calls.includes('voice=Telnyx.KokoroTTS.af_heart'), 'a voice Telnyx refuses (500) is dropped and the next real female voice speaks');
ttsBroken.clear();

// Assistants refuse a voice the TTS list has → the next one
el._resetVoiceCache(); A['assistant-front'].voice_settings = { voice: 'ElevenLabs.x.y' };
VOICES.unshift({ voice_id: 'Telnyx.Ultra.7f3c', language: 'en-US', gender: 'female' });
await el.resolveTelnyxVoice({ force: true });
const u2 = await ov.unifyAssistantVoices({ heal: true });
ok(ASSISTANT_OK.has(A['assistant-front'].voice_settings.voice) && !u2.errors.length, 'a voice assistants can’t use (“not found”) is replaced by the next real one: ' + A['assistant-front'].voice_settings.voice);

// The owner's choice wins when Telnyx has it; a made-up one never reaches a call
el._resetVoiceCache(); process.env.LOLA_TELNYX_VOICE = 'Telnyx.KokoroTTS.af_heart';
ok(await el.resolveTelnyxVoice() === 'Telnyx.KokoroTTS.af_heart' && ov.lolaPhoneVoice() === 'Telnyx.KokoroTTS.af_heart', 'LOLA_TELNYX_VOICE (one setting) changes her voice everywhere');
el._resetVoiceCache(); process.env.LOLA_TELNYX_VOICE = 'Telnyx.Ultra.Clara';
ok(await el.resolveTelnyxVoice() !== 'Telnyx.Ultra.Clara', 'a voice id Telnyx doesn’t list is never used');
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
