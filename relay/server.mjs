/**
 * LolaDesk live-voice relay — runs on Railway (or any always-on Node host).
 * ════════════════════════════════════════════════════════════════════════
 * Browser (dashboard orb) ⇄ this relay ⇄ Telnyx AI Assistant conversation socket.
 * Vercel functions can't hold a WebSocket open, so this tiny service does it:
 *   • the browser never sees TELNYX_API_KEY;
 *   • every connection needs a 5-minute session token minted by LolaDesk
 *     (/api/voice-session) and signed with LOLA_VOICE_SECRET (same value in Vercel and here);
 *   • the assistant is ALWAYS Lola (TELNYX_LOLA_BRAIN_ID) — a browser can't pick another one;
 *   • only the frame types a voice conversation needs are forwarded.
 *
 *   GET  /health                         → {"ok":true,...}  (Railway health check)
 *   WSS  /api/voice-relay?token=…        → the conversation  (also accepted at /)
 *
 * Env: TELNYX_API_KEY, LOLA_VOICE_SECRET, TELNYX_LOLA_BRAIN_ID (or TELNYX_ASSISTANT_ID), PORT (Railway sets it).
 */
import http from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 8080);
const KEY = () => String(process.env.TELNYX_API_KEY || '').trim();
const SECRET = () => String(process.env.LOLA_VOICE_SECRET || '').trim();
const ASSISTANT = () => String(process.env.TELNYX_LOLA_BRAIN_ID || process.env.TELNYX_ASSISTANT_ID || '').replace(/\s+/g, '');
const MAX_FRAME = 512 * 1024;
const MAX_SESSION_MS = 30 * 60 * 1000;

export function verifyToken(token, now = Date.now()) {
  const s = SECRET();
  if (!s || !token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 5) return null;
  const [userId, tenantId, expiresAt, nonce, sig] = parts;
  if (!userId || !tenantId || !nonce || !sig) return null;
  const want = createHmac('sha256', s).update([userId, tenantId, expiresAt, nonce].join('.')).digest('hex');
  const a = Buffer.from(sig), b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (!(Number(expiresAt) > now)) return null;
  return { userId, tenantId };
}

const ALLOWED = new Set(['session.update', 'input_audio_buffer.append', 'input_audio_buffer.commit', 'input_audio_buffer.clear', 'response.cancel', 'conversation.item.create']);
// The browser may only send the salon's facts — never new instructions, tools or another assistant.
function cleanSessionUpdate(frame) {
  const dv = frame?.session?.assistant?.dynamic_variables;
  if (!dv || typeof dv !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(dv)) if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = typeof v === 'string' ? v.slice(0, 4000) : v;
  return { type: 'session.update', session: { assistant: { dynamic_variables: out } } };
}

const server = http.createServer((req, res) => {
  const ready = !!(KEY() && SECRET() && ASSISTANT());
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ ok: ready, service: 'loladesk-voice-relay', telnyx_key: !!KEY(), secret: !!SECRET(), assistant: !!ASSISTANT() }));
  }
  res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"ok":false}');
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://relay.local');
  if (!['/', '/api/voice-relay'].includes(url.pathname)) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, url));
});

wss.on('connection', (client, url) => {
  const sess = verifyToken(url.searchParams.get('token'));
  if (!sess) { client.close(4401, 'unauthorized'); return; }
  if (!KEY() || !ASSISTANT()) { client.close(4403, 'relay not configured'); return; }
  const upstream = new WebSocket(`${process.env.TELNYX_WS_BASE || 'wss://api.telnyx.com'}/v2/ai/assistants/${encodeURIComponent(ASSISTANT())}/conversation?input_sample_rate=16000`, { headers: { Authorization: `Bearer ${KEY()}` } });
  const queue = []; let open = false, closed = false;
  const stop = setTimeout(() => { try { client.close(1000, 'session_max_duration'); } catch (_) {} }, MAX_SESSION_MS);
  const end = () => { closed = true; clearTimeout(stop); try { upstream.close(); } catch (_) {} };
  upstream.on('open', () => { open = true; while (queue.length) { try { upstream.send(queue.shift()); } catch (_) {} } });
  upstream.on('message', (data, isBinary) => {
    if (closed || client.readyState !== WebSocket.OPEN) return;
    if (!isBinary) { try { const f = JSON.parse(String(data)); if (f?.type === 'error') console.warn('[relay] telnyx error', f?.error?.code, f?.error?.message, 'tenant', sess.tenantId); } catch (_) {} }
    client.send(data, { binary: isBinary });
  });
  upstream.on('close', (code, reason) => { if (!closed && client.readyState === WebSocket.OPEN) client.close(code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1011, String(reason || 'upstream closed').slice(0, 100)); });
  upstream.on('error', (e) => { console.error('[relay] upstream error', e?.message || e); try { client.close(1011, 'upstream error'); } catch (_) {} });
  client.on('message', (data) => {
    let frame; try { frame = JSON.parse(String(data)); } catch (_) { return; }
    if (!ALLOWED.has(frame?.type)) return;
    let out = data;
    if (frame.type === 'session.update') { const c = cleanSessionUpdate(frame); if (!c) return; out = JSON.stringify(c); }
    if (open) { try { upstream.send(out); } catch (_) {} } else if (queue.length < 200) queue.push(out);
  });
  client.on('close', end);
  client.on('error', end);
  console.log('[relay] session for tenant', sess.tenantId);
});

if (process.env.RELAY_NO_LISTEN !== '1') server.listen(PORT, () => console.log(`[relay] LolaDesk voice relay on :${PORT}`));
export { server };
