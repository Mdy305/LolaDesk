/**
 * api/lib/voice-session-token.js — short-lived signed voice-session tokens
 * ════════════════════════════════════════════════════════════════════
 * The browser cannot set WebSocket Authorization headers and must never see
 * TELNYX_API_KEY. Instead /api/voice-session mints a short-lived HMAC blob
 * that ties one owner user + one tenant to a conversation, and the relay
 * validates that blob before it opens the upstream Telnyx socket.
 *
 * Format: userId.tenantId.expiresAt.nonce.sig
 *   — sig = HMAC-SHA256(SECRET, "userId.tenantId.expiresAt.nonce")
 *
 * Pure & dependency-free so it's unit-testable.
 */
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

// No built-in default: a well-known fallback would let anyone mint a voice session for any
// salon. Without LOLA_VOICE_SECRET, tokens can't be issued (voice-session.js answers 503
// relay_secret_missing) and nothing verifies.
export function secret() {
  return String(process.env.LOLA_VOICE_SECRET || '').trim();
}
export function hasVoiceSecret() { return !!secret(); }

export function issueVoiceToken({ userId, tenantId, ttlMs = 5 * 60 * 1000, now = Date.now() }) {
  if (!userId || !tenantId) throw new Error('userId and tenantId are required');
  if (!secret()) throw new Error('LOLA_VOICE_SECRET is not configured');
  const expiresAt = now + ttlMs;
  const nonce = randomBytes(8).toString('hex');
  const base = [userId, tenantId, expiresAt, nonce].join('.');
  const sig = createHmac('sha256', secret()).update(base).digest('hex');
  return `${base}.${sig}`;
}

/**
 * Verify a token. Returns { userId, tenantId } or null (expired/tampered/malformed).
 */
export function verifyVoiceToken(token, { now = Date.now() } = {}) {
  if (!token || !secret()) return null;
  const parts = String(token).split('.');
  if (parts.length !== 5) return null;
  const [userId, tenantId, expiresAt, nonce, sig] = parts;
  if (!userId || !tenantId || !nonce || !sig) return null;
  const base = [userId, tenantId, expiresAt, nonce].join('.');
  const expected = createHmac('sha256', secret()).update(base).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (Number(expiresAt) < now) return null; // expired
  return { userId, tenantId };
}