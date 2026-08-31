import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getUserSubscription } from '../api/lib/elevenlabs.js';

const ENV_KEYS = ['ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID'];
function withEnv(kv, fn){
  const saved = {};
  for(const k of ENV_KEYS){ saved[k] = process.env[k]; }
  for(const k of ENV_KEYS){ if(kv[k] === undefined) delete process.env[k]; else process.env[k] = kv[k]; }
  try{ return fn(); }
  finally { for(const k of ENV_KEYS){ if(saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

test('getUserSubscription: reports remaining credits on an active account', async () => {
  const sub = await withEnv(
    { ELEVENLABS_API_KEY: 'sk_live_secret' },
    () => getUserSubscription({ fetch: async () => json({ character_count: 90, character_limit: 100, tier: 'free', next_character_count_reset_unix: 1700000000 }) })
  );
  assert.equal(sub.ok, true);
  assert.equal(sub.remaining, 10);
  assert.equal(sub.quotaExhausted, false);
  assert.equal(sub.tier, 'free');
  assert.equal(sub.characterLimit, 100);
  // the key must never surface
  assert.ok(!JSON.stringify(sub).includes('sk_live_secret'));
});

test('getUserSubscription: flags quotaExhausted when credits are depleted (0 remaining)', async () => {
  const sub = await withEnv(
    { ELEVENLABS_API_KEY: 'sk_live_secret' },
    () => getUserSubscription({ fetch: async () => json({ character_count: 100, character_limit: 100, tier: 'free' }) })
  );
  assert.equal(sub.remaining, 0);
  assert.equal(sub.quotaExhausted, true);
});

test('getUserSubscription: treats an uncapped plan as never-exhausted', async () => {
  // character_limit is the string "unlimited" on uncapped plans — not a hard gate.
  const sub = await withEnv(
    { ELEVENLABS_API_KEY: 'sk_live_secret' },
    () => getUserSubscription({ fetch: async () => json({ character_count: 999, character_limit: 'unlimited', tier: 'pro' }) })
  );
  assert.equal(sub.characterLimit, null);
  assert.equal(sub.remaining, null);
  assert.equal(sub.quotaExhausted, false);
});

test('getUserSubscription: surfaces a provider failure without leaking the key', async () => {
  await assert.rejects(
    withEnv({ ELEVENLABS_API_KEY: 'sk_live_secret' }, () =>
      getUserSubscription({ fetch: async () => json({ detail: 'some_api_body' }, 401) })),
    /ElevenLabs subscription 401/
  );
  // no test needs the key outside the request; ensure exceptions don't carry it either
  try{
    await withEnv({ ELEVENLABS_API_KEY: 'sk_live_secret' }, () =>
      getUserSubscription({ fetch: async () => json({ detail: 'some_api_body' }, 500) }));
    assert.fail('should have thrown');
  }catch(e){
    assert.ok(!String(e.message).includes('sk_live_secret'));
  }
});