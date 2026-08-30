/**
 * /api/cron/autopilot — Lola Autopilot hourly run
 * ════════════════════════════════════════════════════════════════════
 * Fired by Vercel Cron (see vercel.json `crons`). Requires CRON_SECRET:
 * Vercel sends `Authorization: Bearer <CRON_SECRET>` on cron GETs; we also
 * accept POST with the same header for manual runs.
 *
 * Runs the four autonomous agents (api/lib/autopilot.js) — routing-heal,
 * missed-call-recovery, rebooking, sync-self-heal — and records every run in
 * the agent_runs ledger. This is the same logic as the Command screen's
 * "Run autopilot" button (api/admin/autopilot.js): one implementation, two
 * transports.
 */

import { db } from '../lib/db.js';
import { runAutopilot, autopilotStatus } from '../lib/autopilot.js';

function authorized(req) {
  const auth = req.headers.authorization || '';
  return auth === `Bearer ${process.env.CRON_SECRET}`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ ok: false, error: 'GET/POST only' });

  if (!process.env.CRON_SECRET) {
    return res.status(503).json({ ok: false, error: 'CRON_SECRET is not set — autopilot cron is disabled' });
  }
  if (!authorized(req)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const client = db();
  if (!client) return res.status(503).json({ ok: false, error: 'Database not configured' });

  const started = Date.now();
  const result = await runAutopilot(client);
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
