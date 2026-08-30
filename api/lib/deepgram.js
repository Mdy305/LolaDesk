/**
 * api/lib/deepgram.js — Deepgram streaming speech-to-text
 * ════════════════════════════════════════════════════════════════
 * Feeds the duplex voice path (api/voice-stream.js). Telnyx media frames are
 * G.711 mu-law at 8kHz, which Deepgram accepts natively — the raw frames are
 * forwarded with NO transcoding, so the caller's speech lands as text with
 * minimal latency while Lola is still talking or thinking.
 *
 * ENV: DEEPGRAM_API_KEY
 *
 * The WebSocket implementation is injectable for tests; production uses the
 * `ws` package already in the repo.
 */

import WebSocket from 'ws';

const DEEPGRAM_WS = 'wss://api.deepgram.com/v1/listen';

export class DeepgramStream {
  constructor({
    apiKey,
    model = 'nova-2',
    encoding = 'mulaw',
    sampleRate = 8000,
    interimResults = true,
    endpointing = 300,
    onTranscript = null,
    onInterim = null,
    onError = null,
    WebSocketImpl = WebSocket
  } = {}) {
    if(!apiKey) throw new Error('Missing DEEPGRAM_API_KEY');
    this.apiKey = apiKey;
    this.onTranscript = onTranscript;
    this.onInterim = onInterim;
    this.onError = onError;
    this.WebSocketImpl = WebSocketImpl;
    this.ws = null;
    this.ready = false;
    this.closed = false;
    this.pending = [];

    const params = new URLSearchParams({
      model,
      encoding,
      sample_rate: String(sampleRate),
      interim_results: String(!!interimResults),
      endpointing: String(endpointing),
      utterance_end_ms: '1000',
      punctuate: 'true'
    });
    this.url = `${DEEPGRAM_WS}?${params}`;
  }

  connect() {
    if(this.closed) return this;
    try {
      this.ws = new this.WebSocketImpl(this.url, {
        headers: { Authorization: `Token ${this.apiKey}` }
      });
    } catch(e) {
      this.onError?.(e);
      return this;
    }
    this.ws.on('open', () => {
      this.ready = true;
      // Drain audio that arrived before the socket opened (e.g. greeting play).
      for(const chunk of this.pending) this.ws.send(chunk);
      this.pending = [];
    });
    this.ws.on('message', data => this.handleMessage(data));
    this.ws.on('error', e => this.onError?.(e));
    this.ws.on('close', () => { this.ready = false; });
    return this;
  }

  handleMessage(data) {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if(msg.type !== 'Results') return;
    const alt = msg.channel?.alternatives?.[0];
    const text = (alt?.transcript || '').trim();
    if(!text) return;
    if(msg.is_final) this.onTranscript?.(text);
    else this.onInterim?.(text);
  }

  // Forward a raw audio frame (Buffer). Buffered until the socket is open.
  send(audioBuffer) {
    if(this.closed) return;
    if(!this.ws || this.ws.readyState !== 1) {
      if(this.pending.length < 4000) this.pending.push(audioBuffer);
      return;
    }
    try { this.ws.send(audioBuffer); } catch {}
  }

  close() {
    this.closed = true;
    try {
      if(this.ws && this.ws.readyState === 1) {
        this.ws.send(JSON.stringify({ type: 'CloseStream' }));
        this.ws.close();
      }
    } catch {}
    this.ready = false;
  }
}

export function createDeepgramStream(opts) {
  return new DeepgramStream(opts).connect();
}

export default DeepgramStream;
