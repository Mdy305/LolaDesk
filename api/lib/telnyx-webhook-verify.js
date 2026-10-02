/**
 * api/lib/telnyx-webhook-verify.js — Telnyx webhook signature verification.
 * Telnyx signs every webhook delivery with your account's public key
 * (TELNYX_PUBLIC_KEY) using the `telnyx-signature-ed25519` +
 * `telnyx-timestamp` headers. Shared by all Telnyx webhook receivers.
 */
import crypto from 'node:crypto';

/** The exact bytes Telnyx sent (needs `config = { api: { bodyParser: false } }` on the route). */
export async function readRawBody(req) {
  const chunks = [];
  try { if (req && typeof req[Symbol.asyncIterator] === 'function') for await (const ch of req) chunks.push(typeof ch === 'string' ? Buffer.from(ch) : ch); } catch (_) {}
  if (chunks.length) return Buffer.concat(chunks).toString('utf8');
  return rawBody(req);
}

export function rawBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  if (typeof req.body === 'string') return req.body;
  return JSON.stringify(req.body || {});
}

/**
 * Build a KeyObject from TELNYX_PUBLIC_KEY in any of the forms people paste:
 * the raw 32-byte base64 key the Telnyx portal shows, a DER/SPKI base64 key,
 * or a full PEM block.
 */
export function telnyxPublicKey(pub) {
  const v = String(pub || '').trim();
  if (!v) return null;
  if (v.includes('BEGIN PUBLIC KEY')) return crypto.createPublicKey(v);
  const bytes = Buffer.from(v.replace(/\s+/g, ''), 'base64');
  const der = bytes.length === 32 ? Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), bytes]) : bytes;
  return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
}

export function verifyTelnyxSignature(req, payload) {
  const publicKey = process.env.TELNYX_PUBLIC_KEY;
  // No key configured: accept (and say so) rather than silently dropping
  // every call event. Set TELNYX_PUBLIC_KEY to enforce signatures.
  if (!publicKey) { if (!globalThis.__lolaWarnedTelnyxKey) { globalThis.__lolaWarnedTelnyxKey = 1; console.warn('[telnyx] TELNYX_PUBLIC_KEY not set — webhook signatures are not being checked'); } return true; }

  const headers = req.headers || {};
  const signature = headers['telnyx-signature-ed25519'];
  const timestamp = headers['telnyx-timestamp'];
  if (!signature || !timestamp) return false;

  const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(ageSeconds) || ageSeconds > 300) return false;

  const message = Buffer.from(`${timestamp}|${payload}`);
  const signatureBytes = Buffer.from(String(signature), 'base64');
  try {
    return crypto.verify(null, message, telnyxPublicKey(publicKey), signatureBytes);
  } catch {
    return false;
  }
}
