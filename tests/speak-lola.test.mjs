import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TELNYX_API_KEY = 'test-telnyx-key';

const { default: handler } = await import('../api/speak-lola.js');

const REAL_FETCH = globalThis.fetch;
const AUDIO = Buffer.from('fake-mp3-bytes');
function mp3(status = 200, body = AUDIO) {
  return { ok: status >= 200 && status < 300, status, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength), text: async () => 'err' };
}
function err(status, body) {
  return { ok: false, status, text: async () => body };
}

function makeRes() {
  const out = { code: 200, headers: {}, body: null, sent: null };
  return [{
    setHeader(k, v) { out.headers[k] = v; },
    status(c) { out.code = c; return this; },
    json(o) { out.body = o; return o; },
    send(b) { out.sent = b; return b; }
  }, out];
}
const req = (body) => ({ method: 'POST', headers: {}, body, on: () => {} });

test('POST required', async () => {
  const [res, out] = makeRes();
  await handler({ method: 'GET', headers: {}, body: {} }, res);
  assert.equal(out.code, 405);
});

test('empty text -> 400', async () => {
  const [res, out] = makeRes();
  await handler(req({ text: '   ' }), res);
  assert.equal(out.code, 400);
});

test('ElevenLabs success -> elevenlabs audio, X-Lola-Voice: elevenlabs', async () => {
  process.env.ELEVENLABS_API_KEY = 'ek';
  process.env.ELEVENLABS_VOICE_ID = 'vid';
  let sawUrl = '';
  globalThis.fetch = async (url) => {
    sawUrl = String(url);
    if (String(url).includes('api.elevenlabs.io')) return mp3();
    throw new Error('unexpected fetch ' + url);
  };
  try {
    const [res, out] = makeRes();
    await handler(req({ text: 'Hello beautiful' }), res);
    assert.equal(out.code, 200);
    assert.equal(out.headers['X-Lola-Voice'], 'elevenlabs');
    assert.ok(out.sent, 'audio bytes sent');
    assert.ok(sawUrl.includes('api.elevenlabs.io'));
  } finally {
    globalThis.fetch = REAL_FETCH;
    delete process.env.ELEVENLABS_API_KEY;
    delete process.env.ELEVENLABS_VOICE_ID;
  }
});

test('ElevenLabs quota_exceeded -> falls back to Telnyx, X-Lola-Voice: telnyx, no key leak', async () => {
  process.env.ELEVENLABS_API_KEY = 'ek';
  process.env.ELEVENLABS_VOICE_ID = 'vid';
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    if (String(url).includes('api.elevenlabs.io')) return err(401, '{"detail":{"code":"quota_exceeded"}}');
    if (String(url).includes('api.telnyx.com/v2/text-to-speech/speech')) return mp3();
    throw new Error('unexpected fetch ' + url);
  };
  try {
    const [res, out] = makeRes();
    await handler(req({ text: 'Hi' }), res);
    assert.equal(out.code, 200);
    assert.equal(out.headers['X-Lola-Voice'], 'telnyx');
    assert.ok(out.sent, 'telnyx audio bytes sent');
    assert.equal(JSON.stringify(out.body), 'null', 'no JSON error body once telnyx speaks');
    assert.ok(!JSON.stringify(seen).includes('test-telnyx-key') && !(out.sent || '').toString?.().includes?.('test-telnyx-key'), 'must never leak the Telnyx key');
  } finally {
    globalThis.fetch = REAL_FETCH;
    delete process.env.ELEVENLABS_API_KEY;
    delete process.env.ELEVENLABS_VOICE_ID;
  }
});

test('ElevenLabs down + Telnyx down -> 502 with sanitized reason, no key leak', async () => {
  process.env.ELEVENLABS_API_KEY = 'ek';
  process.env.ELEVENLABS_VOICE_ID = 'vid';
  globalThis.fetch = async (url) => {
    if (String(url).includes('api.elevenlabs.io')) return err(401, '{"detail":{"code":"quota_exceeded"}}');
    return err(500, 'boom');
  };
  try {
    const [res, out] = makeRes();
    await handler(req({ text: 'Hi' }), res);
    assert.equal(out.code, 502);
    assert.equal(out.body.voice, 'elevenlabs');
    assert.ok(!JSON.stringify(out.body).includes('test-telnyx-key'), 'no key leak');
  } finally {
    globalThis.fetch = REAL_FETCH;
    delete process.env.ELEVENLABS_API_KEY;
    delete process.env.ELEVENLABS_VOICE_ID;
  }
});

test('ElevenLabs not configured + Telnyx up -> telnyx speaks', async () => {
  delete process.env.ELEVENLABS_API_KEY;
  delete process.env.ELEVENLABS_VOICE_ID;
  globalThis.fetch = async (url) => {
    if (String(url).includes('api.telnyx.com/v2/text-to-speech/speech')) return mp3();
    throw new Error('unexpected fetch ' + url);
  };
  try {
    const [res, out] = makeRes();
    await handler(req({ text: 'Hello' }), res);
    assert.equal(out.code, 200);
    assert.equal(out.headers['X-Lola-Voice'], 'telnyx');
    assert.ok(out.sent, 'audio bytes sent');
  } finally {
    globalThis.fetch = REAL_FETCH;
  }
});
