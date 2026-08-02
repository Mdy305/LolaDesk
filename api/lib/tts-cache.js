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
 * cached under a stable hash key. First call pays ElevenLabs; every call
 * after gets instant audio at zero cost.
 *
 * FALLBACK: If Supabase isn't configured or upload fails, return null
 * and the caller falls back to <Say> with Polly.Joanna-Neural.
 */

import { db } from './db.js';

const BUCKET = 'voice-audio';
const KEYED_PREFIX = 'cached/';

function publicUrlFor(path){
  const c = db();
  if(!c) return null;
  try{
    const { data } = c.storage.from(BUCKET).getPublicUrl(path);
    return data?.publicUrl || null;
  }catch{
    return null;
  }
}

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
    return publicUrlFor(path);
  }catch(e){
    console.error('[TTS-CACHE] upload exception:', String(e?.message || e).slice(0,200));
    return null;
  }
}

/**
 * Check if a keyed audio file already exists.
 * Uses a fetch HEAD with a manual timeout (AbortSignal.timeout may not
 * be available in older Node.js runtimes).
 */
async function getKeyedAudioUrl(key){
  const path = `${KEYED_PREFIX}${key}.mp3`;
  const url = publicUrlFor(path);
  if(!url) return null;
  try{
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const r = await fetch(url, { method: 'HEAD', signal: controller.signal });
    clearTimeout(timer);
    return r.ok ? url : null;
  }catch{
    return null;
  }
}

/**
 * Synthesize + cache a repeated line (greeting, re-prompt, etc.)
 * Returns a public Supabase URL or null (caller falls back to <Say>).
 */
export async function putAudioKeyed(key, buf){
  const path = `${KEYED_PREFIX}${key}.mp3`;
  return uploadAudio(path, buf);
}

/**
 * Upload a one-off audio clip (unique LLM reply). Returns public URL.
 */
export async function putAudio(buf){
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const path = `oneoff/${id}.mp3`;
  return uploadAudio(path, buf);
}

/**
 * Legacy compat — no longer used but kept for voice-audio.js.
 * Returns null (always).
 */
export function takeAudio(){
  return null;
}

// Re-export getKeyedAudioUrl as the async version
export { getKeyedAudioUrl };
