/**
 * /api/execution-health — CRM/execution table coverage. Delegates to the
 * ONE health gate (api/lib/health-gate.js), which derives the table list
 * from the single REQUIRED_TABLES manifest instead of its own drifted copy.
 * Shape unchanged: { ok, failed, results, execution_route, crm_route }.
 */
import { executionHealth, healthSend } from './lib/health-gate.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  return healthSend(res, await executionHealth(), { cors: false });
}
