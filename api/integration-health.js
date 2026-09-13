/**
 * /api/integration-health — per-tenant provider status board. Delegates to
 * the ONE health gate (api/lib/health-gate.js); this file is transport
 * only (auth preamble + OPTIONS). Shape unchanged: { ok, tenant, score,
 * healthy, total, blockers, integrations, checked_at }.
 */
import { integrationProviderHealth, healthTenant, healthSend } from './lib/health-gate.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET only' });
  const { tenant, error } = await healthTenant(req);
  if (error) return healthSend(res, { ok: false, error: error.message, __status: error.__status }, { cors: false });
  return healthSend(res, await integrationProviderHealth(tenant), { cors: false });
}
