// Lola never goes silent: ElevenLabs first when configured, Telnyx when it
// fails (no key, out of credit), Telnyx only when VOICE_PROVIDER=telnyx.
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k';
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const calls = []; let elevenStatus = 200;
globalThis.fetch = async (url, init) => {
  const u = String(url); calls.push(u);
  if (u.includes('elevenlabs')) return new Response(elevenStatus === 200 ? new Uint8Array([1, 2, 3]) : JSON.stringify({ detail: { status: 'quota_exceeded' } }), { status: elevenStatus });
  if (u.includes('api.telnyx.com/v2/text-to-speech/speech')) { const b = JSON.parse(init.body); calls.push('voice=' + b.voice); return new Response(new Uint8Array([9, 9]), { status: 200, headers: { 'content-type': 'audio/mpeg' } }); }
  return new Response('{}', { status: 404 });
};
const { synthesize, voiceProvider } = await import('../../api/lib/elevenlabs.js');
const reset = () => { calls.length = 0; };

process.env.ELEVENLABS_API_KEY = 'e'; process.env.ELEVENLABS_VOICE_ID = 'v'; process.env.TELNYX_API_KEY = 't'; delete process.env.VOICE_PROVIDER;
let buf = await synthesize({ text: 'Hi' });
ok(buf.length === 3 && calls.every(c => !c.includes('telnyx')), 'ElevenLabs speaks when it works');
reset(); elevenStatus = 401;
buf = await synthesize({ text: 'Hi' });
ok(buf.length === 2 && calls.some(c => c.includes('text-to-speech/speech')), 'out of credit → Lola speaks through Telnyx');
ok(calls.includes('voice=Telnyx.KokoroTTS.af_heart'), 'with the same voice her phone assistant uses');
reset(); delete process.env.ELEVENLABS_API_KEY;
buf = await synthesize('Hi');
ok(buf.length === 2 && !calls.some(c => c.includes('elevenlabs')), 'no ElevenLabs key → Telnyx directly');
reset(); process.env.ELEVENLABS_API_KEY = 'e'; elevenStatus = 200; process.env.VOICE_PROVIDER = 'telnyx'; process.env.LOLA_TELNYX_VOICE = 'Telnyx.Ultra.Clara';
buf = await synthesize('Hi');
ok(!calls.some(c => c.includes('elevenlabs')) && calls.includes('voice=Telnyx.Ultra.Clara'), 'VOICE_PROVIDER=telnyx and LOLA_TELNYX_VOICE are honored');
ok(voiceProvider() === 'telnyx', 'health reports the engine speaking');
delete process.env.VOICE_PROVIDER; delete process.env.TELNYX_API_KEY; elevenStatus = 500; reset();
let threw = false; try { await synthesize('Hi'); } catch (e) { threw = true; }
ok(threw, 'nothing to fall back to → the error surfaces (never a fake success)');
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
