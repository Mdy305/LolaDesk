import test from 'node:test';
import assert from 'node:assert/strict';

import { supabaseConfigStatus, telnyxConfigStatus } from '../api/lib/runtime-config.js';
import { chat } from '../api/lib/llm.js';

test('runtime config helpers report missing env vars clearly', () => {
  const supabase = supabaseConfigStatus({});
  assert.equal(supabase.ok, false);
  assert.deepEqual(supabase.missing, ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY']);

  const telnyx = telnyxConfigStatus({ voice:true, messaging:true, signature:true }, {});
  assert.equal(telnyx.ok, false);
  assert.deepEqual(telnyx.missing, [
    'TELNYX_API_KEY',
    'TELNYX_VOICE_APP_ID',
    'TELNYX_MESSAGING_PROFILE',
    'TELNYX_PUBLIC_KEY'
  ]);
});

test('llm chat enables JSON mode for Telnyx onboarding analysis', async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.TELNYX_API_KEY;
  const originalAnthropic = process.env.ANTHROPIC_API_KEY;

  let payload = null;
  process.env.TELNYX_API_KEY = 'test-key';
  delete process.env.ANTHROPIC_API_KEY;

  global.fetch = async (_url, init = {}) => {
    payload = JSON.parse(init.body);
    return {
      ok: true,
      async json(){
        return { choices:[{ message:{ content:'{\"summary\":\"ok\"}' } }] };
      }
    };
  };

  try{
    const result = await chat({
      system: 'Return structured onboarding data.',
      messages: [{ role:'user', content:'Analyze this salon website.' }],
      jsonMode: true
    });

    assert.equal(result.ok, true);
    assert.equal(payload.response_format.type, 'json_object');
    assert.match(payload.messages[0].content, /Return valid JSON only/);
  } finally {
    global.fetch = originalFetch;
    if(originalKey === undefined) delete process.env.TELNYX_API_KEY;
    else process.env.TELNYX_API_KEY = originalKey;
    if(originalAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalAnthropic;
  }
});
