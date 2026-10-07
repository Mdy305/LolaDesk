/**
 * /api/auth/reset — forgot password, end to end.
 *   POST { action:'request', email }        → emails a reset link (always ok:true,
 *                                             never reveals whether an account exists)
 *   POST { action:'update', password }       Authorization: Bearer <recovery token>
 *                                           → sets the new password, returns the email
 * The reset link lands on /reset, which carries the recovery token.
 */
import { admin, getUserFromToken, bearer, signIn } from '../lib/auth.js';

const hits = new Map();   // per-IP limiter (best effort, per instance)
function limited(ip, max = 6, windowMs = 15 * 60e3) {
  const now = Date.now(), h = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  h.push(now); hits.set(ip, h); return h.length > max;
}
// The session behind the Bearer must come from the emailed recovery link (Supabase marks it in the
// JWT's amr claim: method 'recovery' / 'otp'), and recently. An ordinary signed-in session — e.g. a
// stolen or left-open one — can't silently change the password without the current password.
const RECOVERY_METHODS = new Set(['recovery', 'otp', 'magiclink']);
export function jwtClaims(token) {
  try { const p = String(token || '').split('.')[1]; return p ? JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) : null; } catch (_) { return null; }
}
export function isRecoverySession(token, now = Date.now()) {
  const c = jwtClaims(token);
  const amr = Array.isArray(c?.amr) ? c.amr : [];
  return amr.some((m) => {
    const method = typeof m === 'string' ? m : m?.method;
    if (!RECOVERY_METHODS.has(String(method || '').toLowerCase())) return false;
    const ts = Number(typeof m === 'object' ? m?.timestamp : 0) || Number(c?.iat || 0);
    return ts > 0 && now / 1000 - ts < 2 * 3600;   // recovery links are short-lived; allow 2h of slack
  });
}
function appUrl() { return String(process.env.APP_URL || 'https://www.loladesk.com').replace(/\/$/, ''); }

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'ip';
  const a = admin();
  if (!a) return res.status(503).json({ ok: false, error: 'Sign-in is not configured on this address.' });

  if (b.action === 'request') {
    const email = String(b.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ ok: false, error: 'Enter the email you sign in with.' });
    if (limited(ip + ':' + email)) return res.status(429).json({ ok: false, error: 'Too many requests. Try again in a few minutes.' });
    try { await a.auth.resetPasswordForEmail(email, { redirectTo: appUrl() + '/reset' }); } catch (_) {}
    return res.status(200).json({ ok: true });
  }

  if (b.action === 'update') {
    if (limited(ip + ':update', 10)) return res.status(429).json({ ok: false, error: 'Too many requests. Try again in a few minutes.' });
    const token = bearer(req);
    const user = await getUserFromToken(token);
    if (!user) return res.status(401).json({ ok: false, error: 'This reset link has expired. Ask for a new one.' });
    const password = String(b.password || '');
    if (password.length < 8) return res.status(400).json({ ok: false, error: 'Use at least 8 characters.' });
    if (!isRecoverySession(token)) {
      // Not a recovery-link session: only with the current password.
      const current = String(b.current_password || '');
      let okCurrent = false;
      if (current && user.email) { try { const r = await signIn({ email: user.email, password: current }); okCurrent = !!(r && (r.session || r.user || r.access_token)); } catch (_) { okCurrent = false; } }
      if (!okCurrent) return res.status(403).json({ ok: false, error: 'Use the reset link from your email (or enter your current password) to change it.' });
    }
    const { error } = await a.auth.admin.updateUserById(user.id, { password });
    if (error) return res.status(400).json({ ok: false, error: error.message });
    return res.status(200).json({ ok: true, email: user.email });
  }
  return res.status(400).json({ ok: false, error: 'Unknown action' });
}
