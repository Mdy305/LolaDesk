/**
 * /api/auth/reset — forgot password, end to end.
 *   POST { action:'request', email }        → emails a reset link (always ok:true,
 *                                             never reveals whether an account exists)
 *   POST { action:'update', password }       Authorization: Bearer <recovery token>
 *                                           → sets the new password, returns the email
 * The reset link lands on /reset, which carries the recovery token.
 */
import { admin, getUserFromToken, bearer } from '../lib/auth.js';

const hits = new Map();   // per-IP limiter (best effort, per instance)
function limited(ip, max = 6, windowMs = 15 * 60e3) {
  const now = Date.now(), h = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  h.push(now); hits.set(ip, h); return h.length > max;
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
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'This reset link has expired. Ask for a new one.' });
    const password = String(b.password || '');
    if (password.length < 8) return res.status(400).json({ ok: false, error: 'Use at least 8 characters.' });
    const { error } = await a.auth.admin.updateUserById(user.id, { password });
    if (error) return res.status(400).json({ ok: false, error: error.message });
    return res.status(200).json({ ok: true, email: user.email });
  }
  return res.status(400).json({ ok: false, error: 'Unknown action' });
}
