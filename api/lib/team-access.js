/**
 * api/lib/team-access.js — who can sign in to a salon, and what they can do.
 * ════════════════════════════════════════════════════════════════════
 * Roles (tenant_users.role):
 *   owner    the salon owner. Everything.
 *   manager  runs the floor: calendar, clients, calls, inbox, campaigns,
 *            services. Not money, not the account, not the team.
 *   staff    a stylist or front desk: calendar, clients, calls, inbox.
 *
 * requireRole() is the one server-side check. It goes right where a route
 * resolves its salon, so a staff login can never reach billing, phone
 * numbers, the team list, settings or bulk exports — whatever the page shows.
 */
import { getUserFromToken, bearer } from './auth.js';
import { resolveTenantAccessForUser } from './tenant-access.js';

export const OWNER = ['owner', 'admin'];
export const MANAGER = ['owner', 'admin', 'manager'];
export const INVITABLE = ['staff'];

export function roleAllows(role, allowed) {
  return allowed.includes(String(role || '').toLowerCase());
}

/** The role that counts: the salon's own owner email is always the owner, whatever an old link row says. */
export function effectiveRole(access, user) {
  const email = String(user?.email || '').trim().toLowerCase();
  if (email && email === String(access?.tenant?.owner_email || '').trim().toLowerCase()) return 'owner';
  return String(access?.role || 'staff').toLowerCase();
}

export const FORBIDDEN = { ok: false, error: 'owner_only', message: 'Only the salon owner can do this. Ask them, or have them change your access in Team.' };

/**
 * → { user, tenant, role } when allowed; otherwise sends the response
 *   (401 / 404 / 403) and returns null. Use: `const a = await requireRole(req, res, OWNER); if (!a) return;`
 */
export async function requireRole(req, res, allowed = OWNER) {
  const user = await getUserFromToken(bearer(req));
  if (!user) { res.status(401).json({ ok: false, error: 'Not authenticated' }); return null; }
  const access = await resolveTenantAccessForUser(user);
  if (!access?.tenant?.id) { res.status(404).json({ ok: false, error: 'No salon found for this account' }); return null; }
  const role = effectiveRole(access, user);
  if (!roleAllows(role, allowed)) { res.status(403).json(FORBIDDEN); return null; }
  return { user, tenant: access.tenant, role };
}

/** Same check when a route already has the user (returns true/false, sends 403 on false). */
export async function assertRole(user, res, allowed = OWNER) {
  const access = user ? await resolveTenantAccessForUser(user) : null;
  if (access?.tenant?.id && roleAllows(effectiveRole(access, user), allowed)) return true;
  res.status(access?.tenant?.id ? 403 : 401).json(access?.tenant?.id ? FORBIDDEN : { ok: false, error: 'Not authenticated' });
  return false;
}
