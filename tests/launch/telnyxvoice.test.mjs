// The owner chose Telnyx for Lola's voice (VOICE_PROVIDER=telnyx): ONE Telnyx voice everywhere —
// the app, every phone assistant (the ElevenLabs link removed) and the calls LolaDesk places. No ElevenLabs needed.
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'tk';
const BRAIN = 'assistant-57f2d23e-48b1-4107-9811-c40b296f15b6';
process.env.TELNYX_LOLA_BRAIN_ID = BRAIN; process.env.APP_URL = 'https://www.loladesk.com';
process.env.VOICE_PROVIDER = 'telnyx'; delete process.env.LOLA_TELNYX_VOICE; delete process.env.TELNYX_TTS_VOICE;
process.env.ELEVENLABS_API_KEY = 'out-of-credit'; process.env.ELEVENLABS_VOICE_ID = 'ValetLola01';
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const A = {
  [BRAIN]: { id: BRAIN, name: 'LolaBrain', greeting: '{{lola_greeting}}', instructions: 'You are Lola.', tools: [],
    voice_settings: { voice: 'ElevenLabs.eleven_multilingual_v2.ValetLola01', api_key_ref: 'loladesk_elevenlabs_x' },
    dynamic_variables: { lola_greeting: 'Hi, this call may be recorded. I’m Lola, an AI assistant.' },
    dynamic_variables_webhook_url: 'https://www.loladesk.com/api/agent-variables', dynamic_variables_webhook_timeout_ms: 3000,
    telephony_settings: { default_texml_app_id: 'app-1', supports_unauthenticated_web_calls: true } },
  'assistant-front': { id: 'assistant-front', name: 'Front Desk Receptionist Workflow', voice_settings: { voice: 'Telnyx.KokoroTTS.af_heart', expressive_mode: true } },
};
const calls = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  calls.push(u);
  if (u.includes('elevenlabs')) return J({ detail: { code: 'quota_exceeded' } }, 401);
  if (u.includes('/text-to-speech/speech')) { calls.push('voice=' + JSON.parse(init.body).voice); return new Response(Buffer.alloc(800, 1), { headers: { 'content-type': 'audio/mpeg' } }); }
  const m = u.match(/\/ai\/assistants\/([^/?]+)/);
  if (m && A[m[1]]) {
    if (init.method === 'POST' || init.method === 'PATCH') {
      const b = JSON.parse(init.body);
      if (b.voice_settings?.expressive_mode && !/^Telnyx\.U/.test(b.voice_settings.voice)) return J({ errors: [{ detail: 'expressive_mode can only be enabled for Telnyx Ultra or XAI voices' }] }, 422);
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
const ov = await import(P + 'lib/one-voice.js');
ok(ov.lolaPhoneVoice() === 'Telnyx.Ultra.Clara', 'her one voice is the Telnyx voice: ' + ov.lolaPhoneVoice());
const { wireAssistant } = await import(P + 'lib/assistant-wiring.js');
const w = await wireAssistant({ heal: true });
ok(A[BRAIN].voice_settings.voice === 'Telnyx.Ultra.Clara' && !A[BRAIN].voice_settings.api_key_ref && !w.voice?.error, 'LolaBrain speaks with it on the phone (no ElevenLabs link): ' + JSON.stringify(A[BRAIN].voice_settings));
const u = await ov.unifyAssistantVoices({ heal: true });
ok(A['assistant-front'].voice_settings.voice === 'Telnyx.Ultra.Clara' && !u.errors.length, 'every other assistant gets the same voice (and Telnyx accepts it): ' + JSON.stringify(u.errors));
ok(JSON.stringify(await ov.lolaSpeakVoice()) === '{"voice":"Telnyx.Ultra.Clara"}', 'calls LolaDesk places start in the same voice');
const el = await import(P + 'lib/elevenlabs.js');
const buf = await el.synthesize('Hi');
ok(buf.length > 200 && calls.includes('voice=Telnyx.Ultra.Clara') && !calls.some((c) => c.includes('elevenlabs.io/v1/text-to-speech')), 'the app speaks with it too — ElevenLabs credit no longer matters');
process.env.LOLA_TELNYX_VOICE = 'Telnyx.Ultra.Callie';
ok(ov.lolaPhoneVoice() === 'Telnyx.Ultra.Callie' && el.telnyxVoice() === 'Telnyx.Ultra.Callie', 'one setting (LOLA_TELNYX_VOICE) changes her voice everywhere');
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
