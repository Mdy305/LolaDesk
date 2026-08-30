/**
 * /api/voice-relay — WebSocket relay: browser ↔ us ↔ Telnyx AI Assistant
 * ════════════════════════════════════════════════════════════════════
 *   wss://<host>/api/voice-relay?assistant=<id>&token=<session_token>
 *
 * Why proxy:
 *   1. Browsers cannot set WebSocket Authorization headers.
 *   2. We never expose TELNYX_API_KEY to the client.
 *   3. This is where we enforce session scoping + fail loudly.
 *
 * Wire protocol is Telnyx's REAL conversation WebSocket (OpenAI-Realtime-
 * clone), NOT the exact frame names in the earlier design doc. The relay
 * is transparent: it proxies JSON frames both ways and only adds error
 * surfacing. Frames the client/app may rely on:
 *
 *   client → { "type":"session.update", "session":{ "assistant":{ "dynamic_variables": {...} } } }
 *   telnyx → { "type":"session.created", "session":{ "audio":{ "output":{ "format":{ "rate": N } } } } }
 *   client → { "type":"input_audio_buffer.append", "audio":"<b64 pcm16>" }
 *   telnyx → { "type":"input_audio_buffer.speech_started" | "speech_stopped" }
 *   telnyx → { "type":"conversation.item.input_audio_transcription.completed", "transcript":"..." }
 *   telnyx → { "type":"response.output_audio.delta", "delta":"<b64 pcm16>" }        (NOT response.audio.delta)
 *   telnyx → { "type":"response.output_audio_transcript.delta", "delta":"..." }     (NOT response.audio_transcript.delta)
 *   telnyx → { "type":"response.output_audio.done", ... }
 *   telnyx → { "type":"response.done", "response":{ "status":"completed"|"cancelled" } }
 *   telnyx → { "type":"response.tool_call.completed", ... }
 *   telnyx → { "type":"conversation.item.created", "item":{ "type":"function_call", ... } }  (client-side tool)
 *   telnyx → { "type":"error", "error":{ "code":..., "message":... } }
 *
 * Requires Fluid compute (vercel.json already sets "fluid": true).
 */
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import { verifyVoiceToken } from './lib/voice-session-token.js';

const TELNYX_KEY = process.env.TELNYX_API_KEY;

const KNOWN_CODES = new Set([
  'assistant_not_configured', 'session_not_ready', 'frame_too_large',
  'unsupported_event', 'invalid_json', 'invalid_audio', 'invalid_item',
  'invalid_session_update', 'session_update_after_start',
  'ingress_budget_exceeded', 'unsupported_voice_output_format',
  'conversation_start_failed', 'conversation_ended', 'session_idle_timeout',
  'session_max_duration_exceeded',
]);

const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (client, req) => {
  const url = new URL(req.url, 'http://telnyx.local');
  const assistantId = url.searchParams.get('assistant');
  const sessionToken = url.searchParams.get('token');
  const sess = verifyVoiceToken(sessionToken);

  if (!sess || !assistantId) {
    client.close(4401, 'unauthorized');
    return;
  }
  if (!TELNYX_KEY) {
    client.close(4403, 'telnyx key not configured');
    return;
  }

  // Strictly whitelist the paths the client may send; drop everything else
  // before it reaches Telnyx. This is the tenant-scope boundary.
  const allowedClientTypes = new Set([
    'session.update',
    'input_audio_buffer.append',
    'input_audio_buffer.commit',
    'input_audio_buffer.clear',
    'response.cancel',
    'conversation.item.create',
  ]);

  const upstreamUrl = `wss://api.telnyx.com/v2/ai/assistants/${encodeURIComponent(assistantId)}/conversation?input_sample_rate=16000`;
  const upstream = new WebSocket(upstreamUrl, {
    headers: { Authorization: `Bearer ${TELNYX_KEY}` },
  });

  const bufferedFromClient = [];
  let upstreamOpen = false;
  let clientClosed = false;

  upstream.on('open', () => {
    upstreamOpen = true;
    while (bufferedFromClient.length) {
      const raw = bufferedFromClient.shift();
      try { upstream.send(raw); } catch (e) { /* dropped */ }
    }
  });

  upstream.on('message', (data) => {
    if (clientClosed || client.readyState !== client.OPEN) return;
    // Log a warning for the common low-latency/format failures so the
    // operator sees WHY Lola goes silent instead of "no error".
    try {
      const frame = JSON.parse(String(data));
      if (frame?.type === 'error' && KNOWN_CODES.has(frame?.error?.code)) {
        console.warn('[voice-relay] Telnyx error frame',
          frame.error.code, frame.error.message, sessionToken.split('.')[1]);
      }
      if (frame?.type === 'session.created') {
        const rate = frame.session?.audio?.output?.format?.rate;
        if (rate) console.log('[voice-relay] session created, output rate', rate);
      }
    } catch (e) { /* not JSON text; forward raw */ }
    client.send(data);
  });

  upstream.on('close', (code, reason) => {
    if (!clientClosed && client.readyState === client.OPEN) {
      client.close(code || 1000, reason?.toString() || 'upstream-closed');
    }
  });

  upstream.on('error', (err) => {
    console.error('[voice-relay] upstream error', err?.message || err);
    try { if (!clientClosed) client.close(1011, 'upstream-error'); } catch (e) { /* noop */ }
  });

  client.on('message', (data) => {
    // Only forward frames we explicitly allow; log everything else so
    // misbehaving clients are visible but ignored.
    let type = null;
    try { type = JSON.parse(String(data))?.type; } catch (e) { type = '__non_json__'; }
    if (!allowedClientTypes.has(type)) {
      console.warn('[voice-relay] dropped disallowed client frame', type);
      return;
    }
    if (upstreamOpen) { try { upstream.send(data); } catch (e) { /* noop */ } }
    else bufferedFromClient.push(data);
  });

  client.on('close', () => {
    clientClosed = true;
    try { upstream.close(); } catch (e) { /* noop */ }
  });
  client.on('error', () => {
    clientClosed = true;
    try { upstream.close(); } catch (e) { /* noop */ }
  });
});

export default function handler(req, res) {
  if (req.headers.upgrade?.toLowerCase() !== 'websocket') {
    return res.status(426).json({ error: 'Upgrade required — connect via wss://' });
  }
  wss.handleUpgrade(req, req.socket, Buffer.alloc(0), (ws) => {
    wss.emit('connection', ws, req);
  });
}

export const config = { api: { bodyParser: false } };