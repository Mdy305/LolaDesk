/**
 * api/lib/admin-gate.js — "is this request from a LolaDesk platform admin?"
 * A real Supabase session (Bearer) whose email is in ADMIN_EMAILS. No env var → nobody is admin.
 * Used by the debug/diagnostic endpoints that must never be public.
 */
import { getUserFromToken, bearer, isAdminEmail } from './auth.js';

export async function adminUser(req) {
  try {
    const tok = bearer(req);
    if (!tok) return null;
    const u = await getUserFromToken(tok).catch(() => null);
    return u && isAdminEmail(u.email) ? u : null;
  } catch (_) { return null; }
}

/** Sends 401/403 and returns null unless the caller is an admin. */
export async function requireAdmin(req, res) {
  const tok = bearer(req);
  if (!tok) { res.status(401).json({ ok: false, error: 'not_authenticated' }); return null; }
  const u = await adminUser(req);
  if (!u) { res.status(403).json({ ok: false, error: 'admin_only' }); return null; }
  return u;
}
