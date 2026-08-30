/**
 * /api/voice/session-ws — the STREAMING variant of /api/voice/session
 * ════════════════════════════════════════════════════════════════
 * Text in, Lola's reply + canonical voice OUT incrementally over a
 * WebSocket, instead of one JSON round trip. The orb hears her first
 * phrase while the rest of the reply is still being produced — reply
 * text streams phrase-by-phrase and each phrase's ElevenLabs audio is
 * sent as it finishes synthesizing, so she starts speaking in ~1s
 * instead of waiting for the whole turn.
 *
 * Same shared brain as /api/voice/session (lib/dashboard-brain.js)
 * and the same telephony-independence: no call_control_id, no calls
 * table — an empty call history changes nothing.
 *
 * Deploys as a Vercel Function at  wss://<host>/api/voice/session-ws
 * (requires Fluid compute — see vercel.json "fluid": true). The module
 * also exports initVoiceSessionWS(httpServer) for the self-hosted
 * server (index.js) using the exact same upgrade path.
 *
 * PROTOCOL (JSON text frames):
 *   client → { type:'auth', token }                       first message, required
 *   client → { type:'transcript', text, system?, messages?, max_tokens?, temperature? }
 *   client → { type:'cancel' }                            barge-in / interrupt
 *   server → { type:'ready', ok, error? }                 after auth
 *   server → { type:'state', state:'thinking'|'speaking'|'idle'|'error' }
 *   server → { type:'text', delta, index, final }         reply phrase deltas
 *   server → { type:'audio', index, text, chunk, mime, final }   base64 MP3 per phrase
 *   server → { type:'done', reply, engine:'elevenlabs'|'text' }
 *   server → { type:'error', message }
 */

import http from 'node:http';
import { WebSocketServer } from 'ws';
import { getUserFromToken } from '../lib/auth.js';
import { resolveTenantForUser } from '../lib/tenant-access.js';
import { dashboardBrainReply } from '../lib/dashboard-brain.js';
import { synthesize, isConfigured } from '../lib/elevenlabs.js';

const WS_PATH = '/api/voice/session-ws';

/* ── split a reply into breath-group phrases for incremental speech ── */
function splitPhrases(text, maxPhrases = 6, maxLen = 140){
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if(!clean) return [];
  const sentences = clean.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [clean];
  const phrases = [];
  let buf = '';
  for(const s of sentences){
    const trimmed = String(s).trim();
    if(!trimmed) continue;
    const cand = buf ? buf + ' ' + trimmed : trimmed;
    if(cand.length <= maxLen || !buf) buf = cand;
    else { phrases.push(buf); buf = trimmed; }
  }
  if(buf) phrases.push(buf);
  if(phrases.length > maxPhrases){
    const head = phrases.slice(0, maxPhrases - 1);
    head.push(phrases.slice(maxPhrases - 1).join(' ').slice(0, maxLen * 2));
    return head;
  }
  return phrases;
}

function extractReply(json){
  if(!json) return '';
  const content = json.content;
  if(Array.isArray(content)) return content.map(x => (x && (x.text || x.content)) || '').join(' ').trim();
  if(typeof content === 'string') return content.trim();
  if(typeof json.reply === 'string') return json.reply.trim();
  if(typeof json.message === 'string') return json.message.trim();
  return '';
}

function send(ws, msg){
  try { if(ws.readyState === 1) ws.send(JSON.stringify(msg)); } catch(e){}
}

async function handleTranscript(ws, state, payload){
  const text = String(payload?.text || '').trim();
  if(!text){ send(ws, { type:'error', message:'A message is required' }); return; }
  if(state.busy){ send(ws, { type:'error', message:'busy — wait for the current turn to finish' }); return; }
  state.busy = true;
  state.controller = new AbortController();
  send(ws, { type:'state', state:'thinking' });
  try{
    const extra = Array.isArray(payload.messages) ? payload.messages : [];
    const out = await dashboardBrainReply({
      tenant: state.tenant,
      body: {
        messages: [{ role:'user', content:text }, ...extra],
        system: payload.system,
        channel: 'dashboard_voice',
        max_tokens: payload.max_tokens,
        temperature: payload.temperature
      }
    });
    const reply = extractReply(out.json);
    if(!reply && out.status >= 400){
      send(ws, { type:'error', message: (out.json && (out.json.error?.message || out.json.error)) || 'Lola brain unavailable' });
      return;
    }
    if(!reply){
      send(ws, { type:'done', reply:'', engine:'text' });
      return;
    }

    const voiceOn = isConfigured();
    const phrases = splitPhrases(reply);
    let engine = 'text';

    if(!voiceOn){
      // Voice unavailable → stream the reply as text only, never a fake voice.
      phrases.forEach((p, i) => send(ws, { type:'text', delta:p, index:i, final:i === phrases.length - 1 }));
      send(ws, { type:'done', reply, engine:'text' });
      return;
    }

    send(ws, { type:'state', state:'speaking' });
    for(let i = 0; i < phrases.length; i++){
      if(state.controller.signal.aborted) break;
      const phrase = phrases[i];
      const final = i === phrases.length - 1;
      send(ws, { type:'text', delta:phrase, index:i, final });
      try{
        const audio = await synthesize(phrase, {
          modelId: process.env.ELEVENLABS_MODEL || 'eleven_turbo_v2_5',
          outputFormat: 'mp3_44100_128',
          signal: state.controller.signal
        });
        if(audio && audio.length){
          engine = 'elevenlabs';
          send(ws, { type:'audio', index:i, text:phrase, chunk:audio.toString('base64'), mime:'audio/mpeg', final });
        }
      }catch(e){
        if(e?.name === 'AbortError') break;
        console.error('[voice-session-ws] phrase synthesis failed — continuing as text:', String(e?.message || e).slice(0,120));
      }
    }
    if(!state.controller.signal.aborted) send(ws, { type:'done', reply, engine });
  }catch(e){
    if(e?.name === 'AbortError'){ send(ws, { type:'state', state:'idle' }); }
    else{ console.error('[voice-session-ws]', e); send(ws, { type:'error', message:String(e?.message || e) }); }
  }finally{
    state.busy = false;
    state.controller = null;
  }
}

async function authenticate(ws, state, token){
  if(!token){
    send(ws, { type:'ready', ok:false, error:'A token is required' });
    setTimeout(() => { try{ ws.close(4001, 'unauthorized'); }catch(e){} }, 50);
    return;
  }
  try{
    const user = await getUserFromToken(token);
    const tenant = user ? await resolveTenantForUser(user) : null;
    if(!tenant?.id){
      send(ws, { type:'ready', ok:false, error:'Not authenticated' });
      setTimeout(() => { try{ ws.close(4001, 'unauthorized'); }catch(e){} }, 50);
      return;
    }
    state.tenant = tenant;
    state.authed = true;
    send(ws, { type:'ready', ok:true });
  }catch(e){
    send(ws, { type:'ready', ok:false, error:String(e?.message || e) });
    setTimeout(() => { try{ ws.close(4001, 'unauthorized'); }catch(e){} }, 50);
  }
}

function onConnection(ws){
  const state = { authed:false, tenant:null, busy:false, controller:null };
  const ping = setInterval(() => { try{ ws.ping(); }catch(e){} }, 30000);

  ws.on('message', (data) => {
    let msg = null;
    try{ msg = JSON.parse(String(data)); }catch(e){ return; }
    if(!msg || typeof msg !== 'object') return;

    if(msg.type === 'auth'){
      authenticate(ws, state, String(msg.token || ''));
      return;
    }
    if(!state.authed){
      send(ws, { type:'error', message:'Authenticate first ({ type:"auth", token })' });
      return;
    }
    if(msg.type === 'transcript'){ handleTranscript(ws, state, msg); return; }
    if(msg.type === 'cancel'){
      try{ state.controller && state.controller.abort('cancelled'); }catch(e){}
      send(ws, { type:'state', state:'idle' });
      return;
    }
    send(ws, { type:'error', message:'Unknown message type: ' + msg.type });
  });

  ws.on('close', () => { clearInterval(ping); try{ state.controller && state.controller.abort('closed'); }catch(e){} });
  ws.on('error', () => { clearInterval(ping); try{ state.controller && state.controller.abort('error'); }catch(e){} });
}

const wss = new WebSocketServer({ noServer: true });
wss.on('connection', onConnection);

function handleUpgrade(req, socket, head){
  let pathname = '';
  try{ pathname = new URL(req.url, 'http://x').pathname; }catch(e){}
  if(pathname !== WS_PATH){ socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
}

// Vercel Function: the default export is the http server Vercel mounts at
// /api/voice/session-ws (Fluid compute required for WebSockets).
const server = http.createServer();
server.on('upgrade', handleUpgrade);

// Self-hosted mount (index.js): attach the same upgrade handling to the
// app's own http server without hijacking other paths.
export function initVoiceSessionWS(httpServer){
  if(httpServer) httpServer.on('upgrade', handleUpgrade);
}

export { handleUpgrade, splitPhrases };
export default server;
