/**
 * /api/operator-health — signed-in operator readiness score. Delegates to
 * the ONE health gate (api/lib/health-gate.js); this file is transport
 * only (auth preamble + OPTIONS). Shape unchanged: { ok, tenant, score,
 * status, telemetry, channels, integrations, config, checked_at }.
 */
import { operatorHealth, healthTenant, healthSend } from './lib/health-gate.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  const { tenant, error } = await healthTenant(req);
  if (error) return healthSend(res, { ok: false, error: error.message, __status: error.__status }, { cors: false });
  return healthSend(res, await operatorHealth(tenant), { cors: false });
}
