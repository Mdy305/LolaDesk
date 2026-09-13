/**
 * /api/telecom-health — Telnyx configuration + reachability. Delegates to
 * the ONE health gate (api/lib/health-gate.js), which probes through
 * telnyx-client directly. Shape unchanged: { ok, configuration, telnyx,
 * warning?, error? }.
 */
import { telecomHealth, healthSend } from './lib/health-gate.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  return healthSend(res, await telecomHealth());
}
