/**
 * /api/telecom-health — Telnyx configuration + reachability. Delegates to
 * the ONE health gate (api/lib/health-gate.js); the reachability probe is
 * telnyxRequest, passed in. Shape unchanged: { ok, configuration, telnyx,
 * warning? , error? }.
 */
import { telnyxRequest } from './lib/telnyx-client.js';
import { telecomHealth, healthSend } from './lib/health-gate.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  return healthSend(res, await telecomHealth({ telnyxProbe: telnyxRequest }), { cors: false });
}
