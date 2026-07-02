/**
 * api/lib/tts-cache.js — In-memory audio cache for /api/voice-audio
 * ════════════════════════════════════════════════════════════════
 * Telnyx TeXML's <Play> verb fetches audio by URL — it can't receive
 * raw bytes inline like <Say> text. So the flow is:
 *
 *   1. telnyx-voice.js generates Lola's reply text
 *   2. it synthesizes the audio via ElevenLabs RIGHT THEN (server-side)
 *   3. it stores the MP3 bytes here under a short random id
 *   4. it returns TeXML <Play>https://.../api/voice-audio?id=XYZ</Play>
 *   5. Telnyx immediately fetches that URL — we serve the cached bytes
 *
 * This is a single Vercel serverless instance's memory, which is fine
 * because Telnyx fetches the URL within ~1-2s of receiving the TeXML
 * (same warm invocation in practice, and we set a generous TTL as a
 * safety net for cold starts / retries). Entries are deleted after
 * being served once, or after TTL_MS, whichever comes first.
 *
 * NOTE: Vercel serverless functions can run as multiple instances.
 * If you see occasional 404s on /api/voice-audio under load, that's
 * a request landing on a different instance than the one that cached
 * the audio — the fallback in telnyx-voice.js (falling back to <Say>)
 * covers that case gracefully. For guaranteed cross-instance delivery
 * at scale, swap this for a tiny Supabase Storage upload instead of
 * in-memory — see the comment at the bottom of this file.
 */

const TTL_MS = 60_000; // 1 minute is generous; Telnyx fetches within seconds
const store = new Map(); // id -> { buf, expires }

/* ── Keyed reply cache ──────────────────────────────────────────
   Lola says certain lines constantly: the per-tenant greeting on
   EVERY inbound call, the "are you still there?" re-prompt, the
   goodbye, and the deterministic skill replies. Re-synthesizing
   those through ElevenLabs on every call is pure waste twice over:
   it adds ~1-2s of first-ring latency (the caller hears silence)
   and it burns tts_chars — which is margin — on identical text.

   So repeated lines are cached under a stable key (voice + text)
   with a longer TTL and are NOT consumed on read. First call of the
   day pays the synthesis; every call after answers instantly and
   costs zero ElevenLabs characters. Same single-instance caveat as
   the id store above; the <Say> fallback covers instance misses. */
const KEYED_TTL_MS = 15 * 60_000;
const keyed = new Map(); // key -> { id, expires }

export function getKeyedAudioId(key){
  const entry = keyed.get(key);
  if(!entry) return null;
  if(entry.expires < Date.now() || !store.has(entry.id)){ keyed.delete(key); return null; }
  return entry.id;
}

export function putAudioKeyed(key, buf){
  cleanup();
  const id = 'k' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  store.set(id, { buf, expires: Date.now() + KEYED_TTL_MS });
  keyed.set(key, { id, expires: Date.now() + KEYED_TTL_MS });
  return id;
}

function cleanup(){
  const now = Date.now();
  for(const [id, entry] of store){
    if(entry.expires < now) store.delete(id);
  }
  for(const [key, entry] of keyed){
    if(entry.expires < now || !store.has(entry.id)) keyed.delete(key);
  }
}

export function putAudio(buf){
  cleanup();
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  store.set(id, { buf, expires: Date.now() + TTL_MS });
  return id;
}

export function takeAudio(id){
  const entry = store.get(id);
  if(!entry) return null;
  // Don't delete on first read — Telnyx (and some debugging tools) can
  // issue a HEAD or retry. Let TTL expiry do the cleanup instead.
  if(entry.expires < Date.now()){ store.delete(id); return null; }
  return entry.buf;
}

/**
 * SCALING NOTE: if you outgrow single-instance memory (high concurrent
 * call volume across many Vercel instances), replace putAudio/takeAudio
 * with a Supabase Storage bucket:
 *
 *   await supabase.storage.from('voice-audio').upload(`${id}.mp3`, buf, { contentType: 'audio/mpeg' });
 *   const { data } = supabase.storage.from('voice-audio').getPublicUrl(`${id}.mp3`);
 *   // use data.publicUrl directly in <Play>, and cron-delete old files hourly
 *
 * That removes the single-instance assumption entirely. Not needed yet.
 */
