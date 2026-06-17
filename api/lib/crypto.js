/**
 * api/lib/crypto.js — Encrypt OAuth tokens at rest (AES-256-GCM)
 * ════════════════════════════════════════════════════════════════
 * Square, Boulevard, and Shopify access/refresh tokens let someone
 * read and write a salon's real booking calendar and customer data.
 * They must never sit in plaintext in the database. This wraps them
 * with AES-256-GCM (authenticated encryption — tamper-evident, not
 * just obfuscated) before they're written to Supabase, and unwraps
 * them only in-memory, server-side, right before an API call.
 *
 * Uses Node's built-in `crypto` module — no new dependency.
 *
 * ENV VAR (required once any integration is connected):
 *   INTEGRATION_ENCRYPTION_KEY   32 bytes, base64-encoded
 *
 * Generate one with:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 *
 * Rotate by re-encrypting: decrypt all integrations with the old key,
 * re-encrypt with the new one, in a one-off migration script. Keep
 * the old key available during rotation.
 */

import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';

function key(){
  const b64 = process.env.INTEGRATION_ENCRYPTION_KEY;
  if(!b64) throw new Error('Missing INTEGRATION_ENCRYPTION_KEY — cannot store/read OAuth tokens securely');
  const buf = Buffer.from(b64, 'base64');
  if(buf.length !== 32) throw new Error('INTEGRATION_ENCRYPTION_KEY must decode to exactly 32 bytes');
  return buf;
}

// Returns a single string safe to store in a text column:
//   "v1:<base64 iv>:<base64 authTag>:<base64 ciphertext>"
export function encrypt(plaintext){
  if(plaintext == null) return null;
  const iv = randomBytes(12); // GCM standard IV size
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

export function decrypt(stored){
  if(stored == null) return null;
  const parts = String(stored).split(':');
  if(parts.length !== 4 || parts[0] !== 'v1'){
    // Not in our encrypted format — likely legacy plaintext from before
    // this fix shipped. Surface it as-is so callers don't crash, but
    // log loudly so you know to run the backfill/rotation script.
    console.error('[crypto] decrypt() received a value that is not v1-encrypted — treating as legacy plaintext. Run the token re-encryption migration.');
    return stored;
  }
  const [, ivB64, tagB64, ctB64] = parts;
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]);
  return plaintext.toString('utf8');
}
