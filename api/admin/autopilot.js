/**
 * /api/admin/autopilot — operator control plane for Lola Autopilot
 * ════════════════════════════════════════════════════════════════════
 * Gated by the same ADMIN_EMAILS allow-list as /api/admin and
 * /api/admin/numbers (via lib/auth.js isAdminEmail).
 *
 *   GET  /api/admin/autopilot            → status (latest ledger run per
 *                                          agent, platform counts)
 *   POST /api/admin/autopilot            → { action: 'run', agents?: [...] }
 *                                          runs the agents NOW (default all
 *                                          four) and returns the fresh run
 *                                          report. Optional 'agents' narrows
 *                                          the run to specific agent ids.
 *
 * Same lib (api/lib/autopilot.js) as the hourly cron — one implementation,
 * two transports.
 */
import { bearer, getUserFromToken, isAdminEmail } from '../lib/auth.js';
import { db } from '../lib/db.js';
import { runAutopilot, autopilotStatus, AUTOPILOT_AGENTS, AUTOPILOT_AGENT_ORDER } from '../lib/autopilot.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const user = await getUserFromToken(bearer(req));
  if (!user) return res.status(401).json({ ok: false, error: 'Not signed in' });
  if (!isAdminEmail(user.email)) return res.status(403).json({ ok: false, error: 'Not authorized' });

  const client = db();
  if (!client) return res.status(503).json({ ok: false, error: 'Database not configured' });

  if (req.method === 'GET') {
    const status = await autopilotStatus(client);
    return res.status(200).json({ ok: true, ...status });
  }

  if (req.method === 'POST') {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const action = String(body.action || 'run').trim();
    if (action !== 'run') return res.status(400).json({ ok: false, error: "action must be 'run'", supported_agents: AUTOPILOT_AGENT_ORDER });

    let agents = null;
    if (body.agents !== undefined) {
      agents = Array.isArray(body.agents) ? body.agents : String(body.agents).split(',');
      const unknown = agents.filter(a => !AUTOPILOT_AGENTS[a]);
      if (unknown.length) return res.status(400).json({ ok: false, error: `unknown agent(s): ${unknown.join(', ')}`, supported_agents: AUTOPILOT_AGENT_ORDER });
    }

    const started = Date.now();
    const result = await runAutopilot(client, { agents });
    const status = await autopilotStatus(client);
    return res.status(result.ok ? 200 : 502).json({
      ok: result.ok,
      error: result.ok ? null : result.error,
      runs: result.runs,
      status: status.ok ? status.last_runs : null,
      paused_tenants: status.paused_tenants ?? null,
      duration_ms: Date.now() - started,
      generated_at: new Date().toISOString()
    });
  }

  return res.status(405).json({ ok: false, error: 'Method not allowed' });
}
