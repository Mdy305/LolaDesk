/**
 * /api/stt-relay — browser mic ⇄ server ⇄ Deepgram streaming STT
 * ════════════════════════════════════════════════════════════════
 * WHY: Chrome's SpeechRecognition ("web speech") breaks with `network`
 * errors for many users (Google's own endpoint refuses/unreachable), which
 * muted the whole wake-word/listening path. This relay replaces it: the
 * browser streams PCM16 mic audio over WebSocket, we pipe it to Deepgram
 * with the SERVER-side key (DEEPGRAM_API_KEY, already in prod env), and
 * forward transcripts back as JSON. Same shape the shim (lola-telnyx-stt.js)
 * turns into SpeechRecognition events, so lola-resonance.js works unchanged.
 *
 * Auth: requires a valid session token (?token=<loladesk_token>) — same
 * gate as /api/voice-session.
 *
 * Requires Fluid compute (vercel.json already sets "fluid": true).
 */
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import { getUserFromToken } from './lib/auth.js';

const DEEPGRAM_KEY = process.env.DEEPGRAM_API_KEY;

const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (client, req) => {
  const url = new URL(req.url, 'http://x');
  const token = url.searchParams.get('token') || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const model = url.searchParams.get('model') || 'nova-2';
  const sampleRate = Number(url.searchParams.get('sample_rate') || 16000);

  getUserFromToken(token).then((user) => {
    if (!user) { client.close(4401, 'unauthorized'); return; }
    if (!DEEPGRAM_KEY) { client.close(4403, 'stt not configured'); return; }

    const upstream = new WebSocket(
      `${'wss://api.deepgram.com/v1/listen'}?model=${encodeURIComponent(model)}` +
      `&encoding=linear16&sample_rate=${sampleRate}&interim_results=true&endpointing=300&punctuate=true`,
      { headers: { Authorization: `Token ${DEEPGRAM_KEY}` } }
    );

    const queued = [];
    let upstreamOpen = false;
    let clientClosed = false;

    upstream.on('open', () => {
      upstreamOpen = true;
      client.send(JSON.stringify({ type: 'ready' }));
      while (queued.length) { try { upstream.send(queued.shift()); } catch (e) { /* dropped */ } }
    });

    upstream.on('message', (data) => {
      if (!clientClosed && client.readyState === client.OPEN) client.send(data.toString());
    });

    upstream.on('close', () => { if (!clientClosed) { try { client.close(1000, 'stt-closed'); } catch (e) {} } });
    upstream.on('error', (err) => {
      console.error('[stt-relay] upstream:', err?.message || err);
      if (!clientClosed) { try { client.close(1011, 'stt-error'); } catch (e) {} }
    });

    client.on('message', (data) => {
      if (!upstreamOpen) { queued.push(Buffer.from(data)); return; }
      try { upstream.send(data); } catch (e) { /* dropped */ }
    });
    client.on('close', () => { clientClosed = true; try { upstream.close(); } catch (e) {} });
    client.on('error', () => { clientClosed = true; try { upstream.close(); } catch (e) {} });
  }).catch(() => { try { client.close(4401, 'unauthorized'); } catch (e) {} });
});

export default function handler(req, res) {
  if (req.headers.upgrade?.toLowerCase() !== 'websocket') {
    return res.status(426).json({ error: 'Upgrade required' });
  }
  wss.handleUpgrade(req, req.socket, Buffer.alloc(0), (ws) => wss.emit('connection', ws, req));
}

export const config = { api: { bodyParser: false } };
