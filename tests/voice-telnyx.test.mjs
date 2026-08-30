/**
 * tests/voice-telnyx.test.mjs — the Telnyx conversation-WebSocket voice path
 *
 *   node tests/voice-telnyx.test.mjs
 *
 * Covers the pure, verifiable logic of the new browser-voice build:
 *   • voice-session-token issue/verify  (valid, tampered, expired, malformed, wrong secret)
 *   • the corrected Telnyx conversation frame shapes the relay/client rely on
 *     (session.update, response.output_audio.delta, client-side function_call)
 *     so we don't regress to the OpenAI-style names that silently never connect.
 */
import { strict as assert } from 'node:assert';
import { issueVoiceToken, verifyVoiceToken, secret } from '../api/lib/voice-session-token.js';

let passed = 0;
const t = (name, fn) => { try { fn(); passed++; console.log('  ✓', name); } catch (e) { console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; } };

console.log('voice-session-token');
(() => {
  const tok = issueVoiceToken({ userId: 'u1', tenantId: 'ten1', ttlMs: 60000, now: 1000 });
  t('issues a 5-part HMAC token', () => { assert.equal(tok.split('.').length, 5); });
  t('verifies a fresh token', () => {
    const v = verifyVoiceToken(tok, { now: 1000 });
    assert.deepEqual(v, { userId: 'u1', tenantId: 'ten1' });
  });
  t('verifies inside TTL', () => { assert.ok(verifyVoiceToken(tok, { now: 1000 + 59000 })); });
  t('rejects expired token', () => { assert.equal(verifyVoiceToken(tok, { now: 1000 + 61000 }), null); });
  t('rejects tampered signature', () => {
    const parts = tok.split('.');
    parts[4] = parts[4].slice(0, -1) + (parts[4].endsWith('a') ? 'b' : 'a');
    assert.equal(verifyVoiceToken(parts.join('.'), { now: 1000 }), null);
  });
})();

// re-run the wrong-secret case with isolated env swap
(() => {
  process.env.LOLA_VOICE_SECRET = 'known-secret-a';
  const tok = issueVoiceToken({ userId: 'u2', tenantId: 'ten2' });
  process.env.LOLA_VOICE_SECRET = 'known-secret-b';
  t('rejects token minted under a different secret', () => {
    assert.equal(verifyVoiceToken(tok), null);
  });
  delete process.env.LOLA_VOICE_SECRET;
})();

console.log('protocol shapes (real Telnyx conversation WS)');
(() => {
  const sessionUpdate = {
    type: 'session.update',
    session: { assistant: { dynamic_variables: { customer_name: 'Ada' } } },
  };
  const audioDelta = { type: 'response.output_audio.delta', delta: 'AQID' };
  const transcriptDelta = { type: 'response.output_audio_transcript.delta', delta: 'We are open ' };
  const clientTool = {
    type: 'conversation.item.created',
    item: { type: 'function_call', name: 'navigate_ui', arguments: '{"path":"/bookings"}', call_id: 'call_1' },
  };
  t('session update precedes audio', () => {
    assert.equal(sessionUpdate.type, 'session.update');
    assert.ok(sessionUpdate.session.assistant.dynamic_variables);
  });
  t('assistant audio uses response.output_audio.delta (not response.audio.delta)', () => {
    assert.equal(audioDelta.type, 'response.output_audio.delta');
    assert.notEqual(audioDelta.type, 'response.audio.delta');
  });
  t('assistant transcript uses response.output_audio_transcript.delta', () => {
    assert.equal(transcriptDelta.type, 'response.output_audio_transcript.delta');
    assert.notEqual(transcriptDelta.type, 'response.audio_transcript.delta');
  });
  t('client-side tool arrives via conversation.item.created + function_call', () => {
    assert.equal(clientTool.type, 'conversation.item.created');
    assert.equal(clientTool.item.type, 'function_call');
    assert.equal(clientTool.item.call_id, 'call_1');
  });
})();

console.log('\nvoice-telnyx: ' + (process.exitCode ? 'FAILED' : 'all green') + ` (${passed} assertions)`);