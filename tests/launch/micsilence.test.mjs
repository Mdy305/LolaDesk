// "Your microphone is sending silence" must only be said when the mic really is silent: a level meter
// that reads zero (suspended analyser, some Bluetooth mics) never throws the recording away — Telnyx
// still listens — and when it truly is silent she names the mic the browser picked.
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../../lola-ears.js', import.meta.url), 'utf8');

function browser({ heard = '', label = 'AirPods Pro (Bluetooth)', muted = false } = {}) {
  const w = { isSecureContext: true, localStorage: { getItem: () => 'tok' } };
  const calls = [];
  w.navigator = { mediaDevices: { getUserMedia: async () => ({ getAudioTracks: () => [{ label, muted }], getTracks: () => [{ stop() {} }] }) } };
  w.MediaRecorder = class { constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; }
    static isTypeSupported(t) { return t === 'audio/webm'; }
    start() { this.state = 'recording'; this._t = setInterval(() => this.ondataavailable && this.ondataavailable({ data: new Blob([new Uint8Array(800)]) }), 50); }
    stop() { clearInterval(this._t); this.state = 'inactive'; setTimeout(() => this.onstop && this.onstop(), 5); } };
  // The meter reads pure zero — as if the mic were dead.
  w.AudioContext = class { constructor() { this.state = 'running'; } resume() { return Promise.resolve(); } close() {}
    createAnalyser() { return { fftSize: 1024, getFloatTimeDomainData(b) { b.fill(0); } }; } createMediaStreamSource() { return { connect() {} }; } };
  w.FileReader = class { readAsDataURL() { this.result = 'data:audio/webm;base64,AAAA'; setTimeout(() => this.onload(), 1); } };
  w.requestAnimationFrame = (f) => setTimeout(f, 16); w.cancelAnimationFrame = (t) => clearTimeout(t);
  w.fetch = async (u, init) => { calls.push(String(u)); return new Response(JSON.stringify({ ok: true, text: heard }), { status: 200 }); };
  w.window = w;
  new Function('window', 'navigator', 'MediaRecorder', 'FileReader', 'fetch', 'localStorage', 'requestAnimationFrame', 'cancelAnimationFrame',
    src.replace(/^\(function \(\) \{/, '(function () {'))(w, w.navigator, w.MediaRecorder, w.FileReader, w.fetch, w.localStorage, w.requestAnimationFrame, w.cancelAnimationFrame);
  return { w, calls };
}

// The meter says silence, but the person really spoke: Telnyx hears them, so Lola answers.
{
  const { w, calls } = browser({ heard: 'what is my day tomorrow' });
  globalThis.window = w; globalThis.AudioContext = w.AudioContext;
  const r = await w.LolaEars.listen({ waitMs: 300, maxMs: 800 });
  ok(r.text === 'what is my day tomorrow' && calls.some((u) => u.includes('/api/lola/hear')), 'a zero meter never drops your words: Telnyx still hears the recording');
}
// Truly silent: she says so, and names the mic the browser picked.
{
  const { w } = browser({ heard: '' });
  globalThis.window = w; globalThis.AudioContext = w.AudioContext;
  const r = await w.LolaEars.listen({ waitMs: 300, maxMs: 800 });
  ok(r.error === 'no_speech' && /“AirPods Pro \(Bluetooth\)”/.test(r.say || '') && /System Settings → Sound → Input/.test(r.say || ''), 'really silent: she names the mic and where to switch it — ' + (r.say || ''));
}
// No mic name available: the plain message.
{
  const { w } = browser({ heard: '', label: '' });
  globalThis.window = w; globalThis.AudioContext = w.AudioContext;
  const r = await w.LolaEars.listen({ waitMs: 300, maxMs: 800 });
  ok(r.say === w.LolaEars.SAY.silent_mic, 'no mic name: the plain words');
}
console.log(fails ? `\n${fails} FAILED` : '\nall mic checks pass');
process.exit(fails ? 1 : 0);
