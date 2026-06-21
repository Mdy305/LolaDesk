/**
 * /api/lib/redis.js — DistributedContextStore
 * ════════════════════════════════════════════════════════════════
 * LolaDesk handles high-volume WhatsApp traffic. Vercel functions are
 * stateless, so we use Redis (via Upstash or standard) to store the
 * `WhatsAppSessionState` with a strict 3600s TTL.
 *
 * ENV VARS:
 *   REDIS_URL
 */

import { Redis } from '@upstash/redis';

// Only initialize if the URL is provided. 
// For local dev without Redis, we fallback to a simple in-memory map.
const redis = process.env.REDIS_URL 
  ? new Redis({
      url: process.env.REDIS_URL,
      token: process.env.REDIS_TOKEN || 'local'
    })
  : null;

const localFallback = new Map();

export async function getSessionState(phone_number){
  const key = `session:${phone_number}`;
  if(redis){
    return await redis.get(key) || [];
  }
  return localFallback.get(key) || [];
}

export async function appendSessionState(phone_number, role, content){
  const key = `session:${phone_number}`;
  let history = [];
  
  if(redis){
    history = (await redis.get(key)) || [];
    history.push({ role, content, timestamp: Date.now() });
    // Keep 3600s TTL per Project Whisper spec
    await redis.set(key, history, { ex: 3600 });
  } else {
    history = localFallback.get(key) || [];
    history.push({ role, content, timestamp: Date.now() });
    localFallback.set(key, history);
    // Rough local GC
    setTimeout(() => localFallback.delete(key), 3600 * 1000);
  }
  
  return history;
}

export async function clearSessionState(phone_number){
  const key = `session:${phone_number}`;
  if(redis) await redis.del(key);
  else localFallback.delete(key);
}
