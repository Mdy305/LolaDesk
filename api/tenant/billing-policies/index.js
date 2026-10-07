// GET/POST /api/tenant/billing-policies
//
// The salon's deposit / no-show / late-cancel / tip policy. Storage is ONE place:
// booking_settings.metadata.deposits (api/lib/salon-policies.js) — the same
// object Settings → Booking rules, Lola and the deposits job use. This endpoint
// maps to and from it and keeps its long-standing response shape
// ({ deposits, no_show, late_cancel, tips, auto_charge }) for other readers.
//
// For readers that still query the legacy billing_policies table (widget/book via
// lib/policies.js, cron/no-show-scan), a POST also writes a best-effort mirror row.
import { readSalonPolicies, writeSalonPolicies, policiesFromMetadata } from '../../lib/salon-policies.js';

// Kept for callers/tests: save just the deposit part (Banking → Policies field names).
export async function mirrorDeposits(c, tenantId, d) {
  return writeSalonPolicies(c, tenantId, { deposits: d || {} });
}

async function mirrorLegacyRow(c, tenantId, policies, userId) {
  try {
    const row = {
      tenant_id: tenantId, policies, updated_at: new Date().toISOString(), updated_by: userId || null,
      deposits: { ...policies.deposits }, no_show: { ...policies.no_show }, late_cancel: { ...policies.late_cancel },
      tips: { ...policies.tips }, auto_charge: { ...policies.auto_charge },
    };
    let r = await c.from('billing_policies').upsert(row, { onConflict: 'tenant_id' });
    if (r && r.error) {
      const { deposits, no_show, late_cancel, tips, auto_charge, ...core } = row;
      r = await c.from('billing_policies').upsert(core, { onConflict: 'tenant_id' });
    }
  } catch (_) { /* the mirror never blocks the real save */ }
}

export default async function handler(req, res) {
  let cors, jsonBody, bearer, getUserFromToken, resolveTenantAccessForUser, dbFn;
  try {
    ({ cors, jsonBody } = await import('../../lib/cors.js'));
    ({ bearer, getUserFromToken } = await import('../../lib/auth.js'));
    ({ resolveTenantAccessForUser } = await import('../../lib/tenant-access.js'));
    ({ db: dbFn } = await import('../../lib/db.js'));
  } catch (e) { return res.status(500).json({ ok: false, error: 'import_failed', message: String(e?.message || e) }); }

  try {
    if (cors && cors(req, res)) return;
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'not_authenticated' });
    const access = await resolveTenantAccessForUser(user);
    const tenant = access?.tenant;
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no_tenant' });

    const c = dbFn();
    if (!c) return res.status(503).json({ ok: false, error: 'database_not_configured' });
    if (req.method === 'GET') return res.json({ ok: true, data: await readSalonPolicies(c, tenant.id) });
    if (req.method === 'POST') {
      if (access.role && !['owner', 'admin', 'manager'].includes(String(access.role).toLowerCase())) return res.status(403).json({ ok: false, error: 'Only the owner or a manager can change payment policies.' });
      const body = (jsonBody ? jsonBody(req) : null) || {};
      const stored = await writeSalonPolicies(c, tenant.id, body);
      const policies = policiesFromMetadata(stored);
      await mirrorLegacyRow(c, tenant.id, policies, user.id);
      return res.json({ ok: true, data: policies });
    }
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  } catch (e) { return res.status(500).json({ ok: false, error: String(e?.message || e) }); }
}
