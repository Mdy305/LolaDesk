/**
 * tests/deepgram-stream.test.mjs — Deepgram streaming STT client + MCP routing.
 *
 * Run: node tests/deepgram-stream.test.mjs  (or node --test tests/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeepgramStream } from '../api/lib/deepgram.js';
import { extractToolCall } from '../api/lib/telnyx-mcp-integration.js';

// A fake WebSocket that records constructor args, buffers sent frames, and
// lets the test emit server messages.
class FakeWebSocket {
  static OPEN = 1;
  constructor(url, opts) {
    this.url = url;
    this.opts = opts;
    this.readyState = 0; // CONNECTING
    this.sent = [];
    this.handlers = {};
    this.closed = false;
  }
  on(evt, fn) { this.handlers[evt] = fn; }
  emit(evt, ...args) { this.handlers[evt]?.(...args); }
  send(data) { this.sent.push(data); }
  close() { this.closed = true; this.readyState = -1; }
  _open() { this.readyState = 1; this.emit('open'); }
  _message(data) { this.emit('message', Buffer.from(JSON.stringify(data))); }
  _error(e) { this.emit('error', e); }
}

test('DeepgramStream builds a mulaw 8k streaming URL and authenticates', () => {
  const s = new DeepgramStream({ apiKey: 'dg-key', WebSocketImpl: FakeWebSocket });
  assert.match(s.url, /wss:\/\/api\.deepgram\.com\/v1\/listen\?/);
  assert.match(s.url, /encoding=mulaw/);
  assert.match(s.url, /sample_rate=8000/);
  assert.match(s.url, /model=nova-2/);
  assert.match(s.url, /interim_results=true/);
  s.connect();
  const ws = s.ws;
  assert.ok(ws instanceof FakeWebSocket);
  assert.equal(ws.opts.headers.Authorization, 'Token dg-key');
});

test('DeepgramStream buffers audio sent before the socket opens, then drains it', () => {
  const s = new DeepgramStream({ apiKey: 'k', WebSocketImpl: FakeWebSocket }).connect();
  const ws = s.ws;
  const frame = Buffer.from([0xff, 0x80, 0x40, 0x00]);
  s.send(frame);
  assert.equal(ws.sent.length, 0); // not open yet
  ws._open();
  assert.equal(ws.sent.length, 1);
  assert.deepEqual(ws.sent[0], frame);
});

test('DeepgramStream fires onTranscript only for final results, onInterim for interim', () => {
  const finals = [], interims = [];
  const s = new DeepgramStream({
    apiKey: 'k',
    WebSocketImpl: FakeWebSocket,
    onTranscript: t => finals.push(t),
    onInterim: t => interims.push(t)
  }).connect();
  const ws = s.ws;
  ws._open();

  ws._message({ type: 'Results', is_final: false, channel: { alternatives: [{ transcript: 'book a balayage' }] } });
  ws._message({ type: 'Results', is_final: false, channel: { alternatives: [{ transcript: 'book a balayage for' }] } });
  assert.equal(finals.length, 0);
  assert.equal(interims.length, 2);

  ws._message({ type: 'Results', is_final: true, channel: { alternatives: [{ transcript: 'book a balayage for friday' }] } });
  assert.deepEqual(finals, ['book a balayage for friday']);
  assert.equal(interims.length, 2);

  // Empty transcripts are ignored (keepalive / silence)
  ws._message({ type: 'Results', is_final: true, channel: { alternatives: [{ transcript: '' }] } });
  assert.equal(finals.length, 1);
});

test('DeepgramStream forwards raw frames and closes cleanly with CloseStream', () => {
  const s = new DeepgramStream({ apiKey: 'k', WebSocketImpl: FakeWebSocket }).connect();
  const ws = s.ws;
  ws._open();
  ws.sent.length = 0;
  s.send(Buffer.from([1, 2, 3]));
  assert.equal(ws.sent.length, 1);
  s.close();
  // sent[0] is the audio frame; the CloseStream control message is last.
  assert.equal(JSON.parse(ws.sent[1].toString()).type, 'CloseStream');
  assert.equal(s.closed, true);
  s.send(Buffer.from([9])); // no-op after close
  assert.equal(ws.sent.length, 2);
});

test('DeepgramStream reports socket errors via onError', () => {
  const errors = [];
  const s = new DeepgramStream({ apiKey: 'k', WebSocketImpl: FakeWebSocket, onError: e => errors.push(e) }).connect();
  s.ws._error(new Error('boom'));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, 'boom');
});

// ── MCP tool-call parsing (what routes the duplex path to booking-brain) ──

test('extractToolCall parses [TOOL: name {json}] out of an LLM reply', () => {
  const reply = 'Let me check that for you. [TOOL: lola_check_availability {"service":"Balayage","date":"2026-08-20"}]';
  const call = extractToolCall(reply);
  assert.ok(call);
  assert.equal(call.name, 'lola_check_availability');
  assert.equal(call.params.service, 'Balayage');
  assert.equal(call.params.date, '2026-08-20');
});

test('extractToolCall returns null when there is no tool invocation', () => {
  assert.equal(extractToolCall('We have 2:00 and 4:00 open.'), null);
  assert.equal(extractToolCall(''), null);
  // malformed JSON inside the tag -> null (never crashes the call)
  assert.equal(extractToolCall('[TOOL: lola_book_appointment {not json}'), null);
});
