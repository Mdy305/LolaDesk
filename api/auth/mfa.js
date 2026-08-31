/**
 * POST /api/auth/mfa — two-factor auth for LolaDesk owners/operators
 * ─────────────────────────────────────────────────────────────────────────────
 * Only owners/operators use the sign-in path, so enrolling here (Bearer token)
 * inherently targets exactly the people commercial hardening cares about while
 * the frictionless end-user signup is untouched.
 *
 * Actions (POST, JSON body.action):
 *   enroll   { }                      -> { ok, secret, otpauth_uri }   (requires Bearer)
 *   confirm  { code }                 -> { ok } marks the registration verified (Bearer)
 *   verify   { mfa_challenge, code }  -> { session, user, tenant, onboarding_required }
 *                                        second factor passed for a pending login
 *
 * ENV: MFA_CHALLENGE_KEY (or INTEGRATION_ENCRYPTION_KEY) for the challenge.
 */
import { bearer, getUserFromToken } from '../lib/auth.js';
import { db } from '../lib/db.js';
import { resolveTenantForUser } from '../lib/tenant-access.js';
import {
  generateSecret, validTOTP, otpauthUri,
  getRegistration, upsertRegistration, removeRegistration, readChallenge
} from '../lib/mfa.js';
import QRCode from 'qrcode';

async function requireUser(req) {
  const user = await getUserFromToken(bearer(req));
  if (!user) return null;
  return user;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const action = b.action;
    const c = db();
    if (!c) return res.status(503).json({ ok: false, error: 'Database not configured' });

    // ── ENROLL: generate a fresh shared secret + authenticator URI ──
    if (action === 'enroll') {
      const user = await requireUser(req);
      if (!user) return res.status(401).json({ ok: false, error: 'Not authenticated' });
      const secret = generateSecret();
      await upsertRegistration(user.email, { secret, verified: false }, c);
      const otpauth_uri = otpauthUri(secret, user.email || user.id);
      // QR is generated on OUR server (the qrcode package) so the TOTP secret
      // never leaves LolaDesk — the owner's authenticator scans it directly.
      let qr_data_url = null;
      try {
        qr_data_url = await QRCode.toDataURL(otpauth_uri, { width: 220, margin: 1 });
      } catch { /* manual entry (secret + otpauth URI) still works if QR fails */ }
      return res.json({
        ok: true,
        secret,
        otpauth_uri,
        qr_data_url,
        tip: 'Scan the QR (or add the secret manually) in your authenticator app, then confirm with a current code.'
      });
    }

    // ── CONFIRM: validate a live code against the secret, then activate MFA ──
    if (action === 'confirm') {
      const user = await requireUser(req);
      if (!user) return res.status(401).json({ ok: false, error: 'Not authenticated' });
      const reg = await getRegistration(user.email, c);
      if (!reg) return res.status(404).json({ ok: false, error: 'No pending enrollment' });
      if (!validTOTP(reg.secret, b.code)) return res.status(401).json({ ok: false, error: 'Invalid code' });
      await upsertRegistration(user.email, { secret: reg.secret, verified: true }, c);
      return res.json({ ok: true, mfa_enabled: true });
    }

    // ── STATUS: what does this owner currently have? (Settings panel renders state) ──
    if (action === 'status') {
      const user = await requireUser(req);
      if (!user) return res.status(401).json({ ok: false, error: 'Not authenticated' });
      const reg = await getRegistration(user.email, c);
      const enabled = !!(reg && reg.verified);
      return res.json({ ok: true, mfa_enabled: enabled, enrolled: !!reg, verified: enabled });
    }

    // ── DISABLE: turn two-factor off for this owner ──
    if (action === 'disable') {
      const user = await requireUser(req);
      if (!user) return res.status(401).json({ ok: false, error: 'Not authenticated' });
      await removeRegistration(user.email, c);
      return res.json({ ok: true, mfa_enabled: false });
    }

    // ── VERIFY: second factor for a pending login (no Bearer — identity is in the ticket) ──
    if (action === 'verify') {
      const pending = readChallenge(b.mfa_challenge);
      if (!pending || !pending.user || !pending.session) {
        return res.status(401).json({ ok: false, error: 'Challenge expired or invalid' });
      }
      const reg = await getRegistration(pending.user.email, c);
      if (!reg || !reg.verified) return res.status(401).json({ ok: false, error: 'Challenge expired or invalid' });
      if (!validTOTP(reg.secret, b.code)) {
        return res.status(401).json({ ok: false, error: 'Invalid code' });
      }

      // Re-resolve the tenant in case it changed since the challenge was issued.
      let tenant = pending.tenant || null;
      try {
        const now = await resolveTenantForUser(pending.user);
        if (now?.id) tenant = now;
      } catch { /* keep the challenge's snapshot */ }

      return res.json({
        session: pending.session,
        user: pending.user,
        tenant,
        onboarding_required: !tenant
      });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action: ' + action });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
}