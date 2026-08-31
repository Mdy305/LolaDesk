import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkHealth } from '../api/lib/elevenlabs.js';

const ENV_KEYS = ['ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID'];
function withEnv(kv, fn){
  const saved = {};
  for(const k of ENV_KEYS){ saved[k] = process.env[k]; }
  for(const k of ENV_KEYS){ if(kv[k] === undefined) delete process.env[k]; else process.env[k] = kv[k]; }
  try{ return fn(); }
  finally { for(const k of ENV_KEYS){ if(saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

test('checkHealth: reports configured:false when env is missing', async () => {
  const h = await withEnv({}, () => checkHealth());
  assert.equal(h.ok, false);
  assert.equal(h.configured, false);
  assert.match(h.message, /ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID/i);
});

test('checkHealth: surfaces a provider failure reason without leaking the key', async () => {
  const h = await withEnv(
    { ELEVENLABS_API_KEY: 'sk_test_1234567890', ELEVENLABS_VOICE_ID: 'abc123' },
    () => checkHealth({ listVoices: async () => { throw new Error('ElevenLabs 402: insufficient_balance_detail_here'); } })
  );
  assert.equal(h.ok, false);
  assert.equal(h.configured, true);
  assert.equal(h.status, 402);
  // The key must never appear in the surfaced message.
  assert.ok(!String(h.message).includes('sk_test'));
  assert.match(h.message, /402|insufficient/i);
});

test('checkHealth: flags a voice ID that is not on the account', async () => {
  const h = await withEnv(
    { ELEVENLABS_API_KEY: 'sk_test_123', ELEVENLABS_VOICE_ID: 'does-not-exist' },
    () => checkHealth({ listVoices: async () => [{ id: 'real-voice', name: 'Lola' }] })
  );
  assert.equal(h.ok, false);
  assert.equal(h.voiceIdValid, false);
  assert.match(h.message, /not on this ElevenLabs account/i);
});

test('checkHealth: ok when the key is valid and the canonical voice resolves', async () => {
  const h = await withEnv(
    { ELEVENLABS_API_KEY: 'sk_test_123', ELEVENLABS_VOICE_ID: 'v1' },
    () => checkHealth({ listVoices: async () => [{ id: 'v1', name: 'Lola' }] })
  );
  assert.equal(h.ok, true);
  assert.equal(h.voice, 'Lola');
});