/**
 * api/lib/telnyx-webhook-verify.js — Telnyx webhook signature verification.
 * Telnyx signs every webhook delivery with your account's public key
 * (TELNYX_PUBLIC_KEY) using the `telnyx-signature-ed25519` +
 * `telnyx-timestamp` headers. Shared by all Telnyx webhook receivers.
 */
import crypto from 'node:crypto';

export function rawBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  if (typeof req.body === 'string') return req.body;
  return JSON.stringify(req.body || {});
}

export function verifyTelnyxSignature(req, payload) {
  const publicKey = process.env.TELNYX_PUBLIC_KEY;
  if (!publicKey) return process.env.NODE_ENV !== 'production';

  const headers = req.headers || {};
  const signature = headers['telnyx-signature-ed25519'];
  const timestamp = headers['telnyx-timestamp'];
  if (!signature || !timestamp) return false;

  const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(ageSeconds) || ageSeconds > 300) return false;

  const message = Buffer.from(`${timestamp}|${payload}`);
  const signatureBytes = Buffer.from(String(signature), 'base64');
  const key = publicKey.includes('BEGIN PUBLIC KEY')
    ? publicKey
    : `-----BEGIN PUBLIC KEY-----\n${publicKey.match(/.{1,64}/g)?.join('\n')}\n-----END PUBLIC KEY-----`;

  try {
    return crypto.verify(null, message, key, signatureBytes);
  } catch {
    return false;
  }
}
