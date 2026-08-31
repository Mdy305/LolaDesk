/**
 * api/lib/mfa.js — Two-factor authentication (TOTP) for LolaDesk owners/operators
 * ═══════════════════════════════════════════════════════════════════════════
 * Commercial-readiness hardening: owner/admin sign-in (the /api/auth/login path,
 * which is used exclusively by salon owners/operators — end-users never sign in)
 * can additionally require a time-based one-time code from an authenticator app.
 *
 * Why TOTP instead of Telnyx Verify:
 *   - Zero new provisioning: no Telnyx Verify Profile, no per-SMS credit burn,
 *     works even if the account's SMS credits are exhausted.
 *   - Stateless-safe: Vercel serverless functions share no in-memory state, so
 *     the "password verified, waiting for the second factor" step carries the
 *     pending session inside an authenticated envelope (AES-256-GCM) rather than
 *     a server-side ticket.
 *   - Pure node:crypto — no new dependency, fully testable headless.
 *
 * Only owners/operators who voluntarily enroll are gated, so the frictionless
 * signup path and any owner who has not set up MFA still sign in unchanged.
 * A separate migration (20260831_mfa_totp.sql) creates the mfa_registrations table.
 *
 * ENV: MFA_CHALLENGE_KEY (or falls back to INTEGRATION_ENCRYPTION_KEY) for the
 *      stateless challenge envelope. SUPA via db() for registration storage.
 */

import { createHmac, createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { db } from './db.js';

export const TABLE = 'mfa_registrations';
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
export const CHALLENGE_TTL_MS = 5 * 60 * 1000; // second-factor challenge lives 5 minutes

// ── RFC 4648 base32 (for the TOTP shared secret / otpauth URI) ──────────────
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const B32_REV = Object.fromEntries([...B32].map((c, i) => [c, i]));

function base32Encode(buf) {
  let acc = 0, nbits = 0, out = '';
  for (const byte of buf) {
    acc = (acc << 8) | byte; nbits += 8;
    while (nbits >= 5) { out += B32[(acc >> (nbits - 5)) & 31]; nbits -= 5; }
    acc &= (1 << nbits) - 1;
  }
  if (nbits > 0) out += B32[(acc << (5 - nbits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let acc = 0, nbits = 0;
  const out = [];
  for (const ch of clean) {
    if (!(ch in B32_REV)) continue;
    acc = (acc << 5) | B32_REV[ch]; nbits += 5;
    while (nbits >= 8) { out.push((acc >> (nbits - 8)) & 0xff); nbits -= 8; }
    acc &= (1 << nbits) - 1;
  }
  return Buffer.from(out);
}

// ── TOTP core (RFC 6238, HMAC-SHA1) ─────────────────────────────────────────
function hotp(secretBase32, counter) {
  const key = base32Decode(secretBase32);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', key).update(buf).digest();
  const off = h[h.length - 1] & 0x0f;
  const code = (((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3]) % 1000000;
  return String(code).padStart(TOTP_DIGITS, '0');
}

export function totp(secretBase32, atMs = Date.now()) {
  return hotp(secretBase32, Math.floor(atMs / 1000 / TOTP_STEP_SECONDS));
}

export function generateSecret(bytes = 20) {
  return base32Encode(randomBytes(bytes));
}

export function validTOTP(secretBase32, code, atMs = Date.now(), window = 1) {
  const c = String(code == null ? '' : code);
  if (!/^\d{6}$/.test(c)) return false;
  for (let w = -window; w <= window; w++) {
    if (hotp(secretBase32, Math.floor(atMs / 1000 / TOTP_STEP_SECONDS) + w) === c) return true;
  }
  return false;
}

export function otpauthUri(secret, account) {
  const label = String(account || 'owner').replace(/[^a-z0-9._@-]/gi, '_');
  return `otpauth://totp/LolaDesk:${label}?secret=${secret}&issuer=LolaDesk`
    + `&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
}

// ── Registration store ───────────────────────────────────────────────────────
export async function getRegistration(userEmail, client) {
  const c = client || db();
  if (!c) return null;
  const { data } = await c.from(TABLE)
    .select('*')
    .eq('user_identifier', String(userEmail || '').trim().toLowerCase())
    .maybeSingle();
  return data || null;
}

export async function upsertRegistration(userEmail, { secret, verified = false }, client) {
  const c = client || db();
  if (!c) throw new Error('Auth not configured');
  const id = String(userEmail || '').trim().toLowerCase();
  const { error } = await c.from(TABLE).upsert(
    { user_identifier: id, secret, verified, verified_at: verified ? new Date().toISOString() : null },
    { onConflict: 'user_identifier' }
  );
  if (error) throw new Error(error.message);
}

// Does this owner already have a verified second factor? (the login gate)
export async function mfaRequiredFor(userEmail, client) {
  const reg = await getRegistration(userEmail, client);
  return !!(reg && reg.verified);
}

// ── Stateless challenge envelope (AES-256-GCM) ───────────────────────────────
// Carries the "password correct, awaiting code" pending session so a Vercel
// serverless function can verify the second factor on a later, stateless call.
function challengeKey() {
  const k = process.env.MFA_CHALLENGE_KEY || process.env.INTEGRATION_ENCRYPTION_KEY;
  if (!k) throw new Error('MFA challenge key not configured (set MFA_CHALLENGE_KEY or INTEGRATION_ENCRYPTION_KEY)');
  return scryptSync(String(k), 'loladesk-mfa', 32);
}

export function createChallenge(payload = {}, ttlMs = CHALLENGE_TTL_MS) {
  const key = challengeKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plain = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlMs }));
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64url');
}

export function readChallenge(ticket) {
  let buf;
  try { buf = Buffer.from(String(ticket || ''), 'base64url'); } catch { return null; }
  if (!buf || buf.length < 12 + 16 + 16) return null;
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  try {
    const d = createDecipheriv('aes-256-gcm', challengeKey(), iv);
    d.setAuthTag(tag);
    const payload = JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null; // tampered, wrong key, or malformed — treat as invalid
  }
}