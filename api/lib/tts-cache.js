/**
 * api/lib/tts-cache.js — Legacy in-memory audio cache (kept for compat)
 * ════════════════════════════════════════════════════════════════
 *
 * Audio caching is now handled directly in telnyx-voice.js's speakCached()
 * using Supabase Storage. This file is kept only so voice-audio.js
 * doesn't break on import — all functions return null/empty.
 */

export function putAudioKeyed(){
  return null;
}

export function getKeyedAudioUrl(){
  return null;
}

export function putAudio(){
  return null;
}

export function takeAudio(){
  return null;
}
