/**
 * api/lib/tts-cache.js — Supabase Storage-backed audio cache for Telnyx <Play>
 * ════════════════════════════════════════════════════════════════
 *
 * Telnyx TeXML's <Play> verb fetches audio by URL. We synthesize Lola's
 * replies via ElevenLabs (brand voice), upload the MP3 to Supabase Storage
 * (bucket: voice-audio), and return the PUBLIC URL for <Play>.
 *
 * Telnyx fetches directly from Supabase's CDN — no Vercel instance
 * dependency, no cross-instance 404s, always available.
 *
 * GREETING CACHE: Repeated lines (greetings, re-prompts, goodbyes) are
 * cached under a stable hash key with a longer TTL. First call of the
 * window pays ElevenLabs; every call after gets instant audio at zero
 * tts_chars cost. We check if the file already exists before synthesizing.
 *
 * FALLBACK: If Supabase isn't configured or upload fails, return null
 * and the caller falls back to <Say> with Polly.Joanna-Neural.
 */

import { db } from './db.js';

const BUCKET = 'voice-audio';
const KEYED_PREFIX = 'cached/';
const ONEOFF_PREFIX = 'oneoff/';

/**
 * Upload audio to Supabase Storage and return the public URL.
 */
async function uploadAudio(path, buf){
  const c = db();
  if(!c) return null;
  try{
    const { error } = await c.storage.from(BUCKET).upload(path, buf, {
      contentType: 'audio/mpeg',
      upsert: true
    });
    if(error){
      console.error('[TTS-CACHE] upload error:', error?.message || error);
      return null;
    }
    const { data } = c.storage.from(BUCKET).getPublicUrl(path);
    return data?.publicUrl || null;
  }catch(e){
    console.error('[TTS-CACHE] upload exception:', String(e?.message || e).slice(0,200));
    return null;
  }
}

/**
 * Check if a keyed audio file already exists by trying to get its public URL.
 * Supabase returns a public URL whether or not the file exists, so we do
 * a lightweight HEAD check via fetch.
 */
async function keyedAudioExists(path){
  const c = db();
  if(!c) return false;
  try{
    const { data } = c.storage.from(BUCKET).getPublicUrl(path);
    if(!data?.publicUrl) return false;
    const r = await fetch(data.publicUrl, { method: 'HEAD', signal: AbortSignal.timeout(3000) });
    return r.ok;
  }catch{
    return false;
  }
}

/**
 * Synthesize + cache a repeated line (greeting, re-prompt, etc.)
 * Returns a public Supabase URL or null (caller falls back to <Say>).
 *
 * @param key   — stable hash of voice+register+text
 * @param buf   — MP3 bytes from ElevenLabs
 * @returns     — public URL string or null
 */
export async function putAudioKeyed(key, buf){
  const path = `${KEYED_PREFIX}${key}.mp3`;
  return uploadAudio(path, buf);
}

/**
 * Check if a keyed audio file exists and return its public URL.
 */
export async function getKeyedAudioUrl(key){
  const path = `${KEYED_PREFIX}${key}.mp3`;
  const c = db();
  if(!c) return null;
  try{
    const { data } = c.storage.from(BUCKET).getPublicUrl(path);
    if(!data?.publicUrl) return null;
    // HEAD check — only return if file actually exists
    const r = await fetch(data.publicUrl, { method: 'HEAD', signal: AbortSignal.timeout(3000) });
    return r.ok ? data.publicUrl : null;
  }catch{
    return null;
  }
}

/**
 * Upload a one-off audio clip (unique LLM reply). Returns public URL.
 */
export async function putAudio(buf){
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const path = `${ONEOFF_PREFIX}${id}.mp3`;
  return uploadAudio(path, buf);
}

/**
 * Legacy in-memory compat — no longer used but kept so voice-audio.js
 * doesn't crash if imported by old code. Returns null (always).
 */
export function takeAudio(){
  return null;
}
