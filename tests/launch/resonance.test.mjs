// Calls that feel like a person: no dead air after the caller talks (Flux turn-taking), her Ultra voice
// with Expressive Mode (real feeling), the greeting's disclosure can't be talked over, and her phone rules
// say "never leave silence while you look something up". Updated rules replace the old block, once.
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'tk';
const BRAIN = 'assistant-44444444-2222-4333-8444-555555555555';
process.env.TELNYX_LOLA_BRAIN_ID = BRAIN; process.env.APP_URL = 'https://www.loladesk.com';
delete process.env.VOICE_PROVIDER; delete process.env.LOLA_TELNYX_VOICE;
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const SIG = 'Telnyx.Ultra.81eeddd4-4185-4ffa-81b9-2cf690fa16c7';
let refuseExpressive = false;
const posts = [];
const asst = { id: BRAIN, name: 'LolaBrain', greeting: '{{lola_greeting}}', model: 'zai-org/GLM-5.3-Flash',
  instructions: 'You are Lola.\n\n[LolaDesk human]\n- an older version of the rules\n\n[LolaDesk extra]\n- kept',
  dynamic_variables: { lola_greeting: 'Hi, this call may be recorded. I’m Lola, an AI assistant.' },
  dynamic_variables_webhook_url: 'https://www.loladesk.com/api/agent-variables', dynamic_variables_webhook_timeout_ms: 3000,
  voice_settings: { voice: 'Telnyx.KokoroTTS.af_heart' }, transcription: { model: 'deepgram/nova-3', language: 'en' },
  telephony_settings: { default_texml_app_id: 'app-1', supports_unauthenticated_web_calls: true } };
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  if (u.endsWith('/ai/openai/models')) return J({ data: [{ id: 'zai-org/GLM-5.3-Flash' }] });
  if (u.includes('/text-to-speech/voices')) return J({ voices: [{ voice_id: 'Telnyx.NaturalHD.astra', language: 'en-US', gender: 'female' }] });
  if (u.includes('/ai/assistants/' + BRAIN)) {
    if (init.method === 'POST' || init.method === 'PATCH') {
      const b = JSON.parse(init.body); posts.push(b);
      if (b.voice_settings?.expressive_mode && refuseExpressive) return J({ errors: [{ detail: 'expressive_mode is not valid for this voice' }] }, 422);
      const { tools, ...rest } = b; Object.assign(asst, rest);
    }
    return J({ data: { ...asst, tools: [] } });
  }
  if (u.includes('/ai/assistants')) return J({ data: [{ id: BRAIN, name: 'LolaBrain', voice_settings: asst.voice_settings }] });
  if (u.includes('/ai/tools')) return J({ data: [] });
  return J({ data: [] });
};
await import('./fake-supabase.mjs');
const { wireAssistant, NATURAL_TURNS } = await import(new URL('../../api/lib/assistant-wiring.js', import.meta.url).href);
const { HUMAN_RULES } = await import(new URL('../../api/lib/human-touch.js', import.meta.url).href);
const ov = await import(new URL('../../api/lib/one-voice.js', import.meta.url).href);

await wireAssistant({ heal: true });
ok(asst.transcription?.model === 'deepgram/flux' && asst.transcription.settings?.eager_eot_threshold === NATURAL_TURNS.eager_eot_threshold && asst.transcription.language === 'en', 'Flux turn-taking: she answers the moment the caller is done (eager end-of-turn), language kept');
ok(asst.interruption_settings?.enable === true && asst.interruption_settings.disable_greeting_interruption === true && asst.interruption_settings.start_speaking_plan?.wait_seconds <= 0.4, 'callers can talk over her like a person — except the recorded-call disclosure');
ok(asst.voice_settings?.voice === SIG && asst.voice_settings.expressive_mode === true, 'her own Ultra voice with Expressive Mode: real feeling in her voice');
const instr = String(asst.instructions);
ok(instr.includes(HUMAN_RULES.trim()) && !instr.includes('an older version of the rules') && instr.includes('[LolaDesk extra]\n- kept') && instr.split('[LolaDesk human]').length === 2, 'the old human rules are replaced by the new ones (once), other blocks kept');
ok(/No dead air, ever/.test(instr) && /one sec/.test(instr), 'she says a quick bridge before anything that takes a moment — never dead air');

// The owner tuned Flux themselves: left alone.
asst.transcription = { model: 'deepgram/flux', settings: { eot_threshold: 0.9, eot_timeout_ms: 8000, eager_eot_threshold: 0.6 } };
const n = posts.length; await wireAssistant({ heal: true });
ok(asst.transcription.settings.eot_threshold === 0.9 && !posts.slice(n).some((p) => p.transcription), 'an owner’s own Flux tuning is never overwritten');

// Telnyx refuses Expressive Mode: her voice stays, only the flag goes.
asst.voice_settings = { voice: 'Telnyx.KokoroTTS.af_heart' }; refuseExpressive = true; ov._resetExpressive();
await ov.unifyAssistantVoices({ heal: true });
ok(asst.voice_settings.voice === SIG && !asst.voice_settings.expressive_mode, 'Expressive Mode refused → still her voice (never a different one)');
ok(ov.voiceIsLola(asst.voice_settings), 'and the check reads it as her voice from then on');

console.log(fails ? `\n${fails} FAILED` : '\nall resonance checks pass');
process.exit(fails ? 1 : 0);
