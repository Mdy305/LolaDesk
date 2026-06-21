import { WebSocketServer } from 'ws';
import url from 'url';
import {
  getTenantByPhone, upsertClient, getOrStartConversation,
  logMessage, getConversationHistory, logUsage, e164, tenantKnowledgePrompt
} from './lib/db.js';
import { chat } from './lib/llm.js';
import { synthesize, isConfigured as elevenLabsConfigured } from './lib/elevenlabs.js';

export const activeStreams = new Map();

// mu-law decoding table
const decodeTable = [0, 132, 396, 924, 1980, 4092, 8316, 16764];

function decodeSample(muLawSample) {
  const b = ~muLawSample;
  const sign = (b & 0x80);
  const exponent = (b >> 4) & 0x07;
  const mantissa = b & 0x0F;
  let sample = decodeTable[exponent] + (mantissa << (exponent + 3));
  return sign !== 0 ? -sample : sample;
}

function getRms(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const s = decodeSample(buf[i]);
    sum += s * s;
  }
  return Math.sqrt(sum / buf.length);
}

function systemPrompt(t) {
  const kb = tenantKnowledgePrompt(t);
  return `You are Lola, the premier AI concierge and desk manager for this ultra-luxury salon/spa. 
You are the equivalent of a 5-star Beverly Hills hotel concierge: incredibly attentive, upscale, warm, slightly bubbly, and highly capable. 
You sound completely natural, confident, and eager to provide a luxurious experience. Keep replies concise, conversational, and direct (usually 1-2 natural sentences). Use high-end, enthusiastic language (e.g., "Oh my gosh, I'd *love* to get you in for that!", "Absolutely, let me take care of that for you", "We have our absolute best stylist available").

BUSINESS DETAILS & KNOWLEDGE:
${kb}

YOUR CAPABILITIES & PROTOCOL:
- Reception & Booking: Help callers book appointments. Gather the service, client name, and preferred day/time, then tell them you'll instantly text them the booking link to complete the confirmation.
- Profit Maximization & Upselling: You must actively look for luxurious upsells to maximize the ticket size. When quoting a service, enthusiastically suggest complementary treatments. (e.g. "Since you're coming in for a balayage, you *have* to try our new restorative gloss, it makes the color pop beautifully. Should I add that on?")
- Escalation: If a request is beyond your capabilities or they need human help, politely offer to take a detailed message for the management team.
- Compliance: Never state you are an AI or bot unless the caller asks directly. Focus entirely on being a high-end, indispensable member of the salon team.`;
}

function shape(t) {
  return { name: t.name, location: t.location, hours: t.hours, bookingUrl: t.booking_url, services: t.services || [] };
}

async function sendCallControlCommand(callControlId, action, payload = {}) {
  if (!process.env.TELNYX_API_KEY) return;
  try {
    const res = await fetch(`https://api.telnyx.com/v2/calls/${callControlId}/actions/${action}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`
      },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`[voice-stream] Call Control error ${action}: ${res.status} - ${text}`);
    }
  } catch (e) {
    console.error(`[voice-stream] Call Control request failed:`, e);
  }
}

class CallContext {
  constructor(ws, callControlId, toN, fromN) {
    this.ws = ws;
    this.callControlId = callControlId;
    this.toN = toN;
    this.fromN = fromN;

    this.tenant = null;
    this.client = null;
    this.conv = null;
    this.history = [];

    this.isPlaying = false;
    this.isPlayingNative = false;
    this.playbackTimeout = null;
    this.isInterrupted = false;

    this.speechFrames = 0;
    this.abortController = null;
  }

  async initialize() {
    try {
      // 1. Tenant lookup
      const row = await getTenantByPhone(this.toN);
      this.tenantId = row?.id;
      this.tenant = shape(row);

      // 2. Client & Conversation
      if (this.fromN && this.tenantId) {
        this.client = await upsertClient(this.tenantId, { phone: this.fromN });
        this.conv = await getOrStartConversation(this.tenantId, { clientId: this.client?.id, channel: 'voice', agent: 'lola' });
      }

      // 3. Load message history
      if (this.conv?.id) {
        this.history = await getConversationHistory(this.conv.id, 8);
      }

      // 4. Initial greeting after 500ms
      setTimeout(() => this.greet(), 500);

    } catch (e) {
      console.error('[voice-stream] Init error:', e);
    }
  }

  async greet() {
    const name = this.client?.name ? `, ${this.client.name.split(' ')[0]}` : '';
    const isReturn = this.history.length > 0;
    const greetingText = isReturn
      ? `Welcome back${name}! It's Lola at ${this.tenant.name} — how can I help you today?`
      : `Hi, thanks for calling ${this.tenant.name}! This is Lola. How can I help you today?`;

    if (this.tenantId) {
      try { await logUsage(this.tenantId, 'voice_call', 1, { source: 'voice' }); } catch {}
    }

    await this.speak(greetingText);
  }

  async speak(text) {
    console.log(`[voice-stream] Lola speaking: "${text}"`);
    this.isInterrupted = false;

    if (elevenLabsConfigured()) {
      try {
        this.abortController = new AbortController();
        const audioBuffer = await synthesize(text, {
          outputFormat: 'ulaw_8000',
          signal: this.abortController.signal
        });
        this.abortController = null;

        if (this.isInterrupted) return; // check if interrupted during API fetch
        this.playUlawBuffer(audioBuffer);
        return;
      } catch (e) {
        if (e.name === 'AbortError') {
          console.log('[voice-stream] Synthesis aborted due to interruption');
          return;
        }
        console.error('[voice-stream] ElevenLabs error, falling back to native speak:', e.message);
      }
    }

    // Fallback to Telnyx Call Control speak
    this.isPlayingNative = true;
    await sendCallControlCommand(this.callControlId, 'speak', {
      text,
      voice: 'en-US-Neural2-F',
      payload_type: 'text'
    });
  }

  playUlawBuffer(buffer) {
    this.isPlaying = true;
    let playIndex = 0;

    const sendNext = () => {
      if (this.isInterrupted || !this.ws || this.ws.readyState !== 1) {
        this.isPlaying = false;
        return;
      }
      if (playIndex >= buffer.length) {
        this.isPlaying = false;
        return;
      }

      const chunk = buffer.slice(playIndex, playIndex + 160);
      playIndex += 160;

      this.ws.send(JSON.stringify({
        event: 'media',
        media: {
          payload: chunk.toString('base64')
        }
      }));

      this.playbackTimeout = setTimeout(sendNext, 20);
    };

    sendNext();
  }

  // Handle incoming raw audio frames for VAD detection
  handleInboundAudio(payload) {
    const buf = Buffer.from(payload, 'base64');
    const rms = getRms(buf);

    if (rms > 1500) {
      this.speechFrames++;
      if (this.speechFrames >= 3) { // 60ms of speech
        this.triggerInterruption();
      }
    } else {
      this.speechFrames = Math.max(0, this.speechFrames - 1);
    }
  }

  triggerInterruption() {
    if (this.isPlaying) {
      console.log('[voice-stream] Speech detected! Interrupting ElevenLabs playback.');
      this.isInterrupted = true;
      this.isPlaying = false;
      if (this.playbackTimeout) {
        clearTimeout(this.playbackTimeout);
        this.playbackTimeout = null;
      }
      // Send clear event over WebSocket to flush Telnyx's audio queue
      this.ws.send(JSON.stringify({ event: 'clear' }));
    }

    if (this.isPlayingNative) {
      console.log('[voice-stream] Speech detected! Interrupting native speak playback.');
      this.isPlayingNative = false;
      sendCallControlCommand(this.callControlId, 'playback_stop');
    }

    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  async handleUserSpeech(text) {
    if (!text || !text.trim()) return;
    console.log(`[voice-stream] Caller said: "${text}"`);

    // Reset interruption state for next Lola response
    this.isInterrupted = false;

    this.history.push({ role: 'user', content: text });

    let reply = "I'm sorry, I had a little trouble there — could you say that again?";
    try {
      const r = await chat({
        system: systemPrompt(this.tenant),
        messages: this.history,
        maxTokens: 90,
        temperature: 0.7
      });
      if (r.ok && r.text) reply = r.text.trim();
    } catch (e) {
      console.error('[voice-stream] chat error:', e);
    }

    this.history.push({ role: 'assistant', content: reply });

    // Save history to DB
    if (this.conv?.id && this.tenantId) {
      try {
        await logMessage({ conversationId: this.conv.id, tenantId: this.tenantId, role: 'user', content: text });
        await logMessage({ conversationId: this.conv.id, tenantId: this.tenantId, role: 'assistant', content: reply });
        await logUsage(this.tenantId, 'ai_token', 1, { source: 'voice' });
      } catch (dbErr) {
        console.error('[voice-stream] DB log error:', dbErr);
      }
    }

    if (this.history.length > 10) {
      this.history = this.history.slice(-10);
    }

    await this.speak(reply);
  }

  cleanup() {
    if (this.playbackTimeout) {
      clearTimeout(this.playbackTimeout);
    }
    if (this.abortController) {
      this.abortController.abort();
    }
    console.log(`[voice-stream] Session cleaned up: call_control_id=${this.callControlId}`);
  }
}

export function initVoiceStream(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const pathname = url.parse(request.url).pathname;
    if (pathname === '/api/voice-stream') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    }
  });

  wss.on('connection', async (ws, request) => {
    const parsedUrl = url.parse(request.url, true);
    const { call_control_id, to, from } = parsedUrl.query;

    const toN = e164(to);
    const fromN = e164(from);

    if (!call_control_id) {
      ws.close();
      return;
    }

    const context = new CallContext(ws, call_control_id, toN, fromN);
    activeStreams.set(call_control_id, context);
    await context.initialize();

    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message.toString());
        if (data.event === 'media' && data.media?.track === 'inbound') {
          context.handleInboundAudio(data.media.payload);
        }
      } catch (err) {
        // Parse error or non-JSON frame
      }
    });

    ws.on('close', () => {
      context.cleanup();
      activeStreams.delete(call_control_id);
    });

    ws.on('error', (err) => {
      context.cleanup();
      activeStreams.delete(call_control_id);
    });
  });
}
