/**
 * /api/cron/sync-connections — daily reconciliation of tenant_numbers vs Telnyx
 * ════════════════════════════════════════════════════════════════════════
 * Fired by Vercel Cron (see vercel.json `crons`). Requires CRON_SECRET:
 * Vercel sends `Authorization: Bearer <CRON_SECRET>` on cron GETs; we also
 * accept POST with the same header for manual runs.
 *
 * Every run fetches Telnyx's LIVE per-number attachments and writes them
 * back into tenant_numbers.connection_id, so the routing table never drifts
 * from what Telnyx actually reports — the operator panel stops showing
 * stale 'mismatch' rows even if nobody clicks "Sync from Telnyx".
 *
 * This is the same logic as the admin panel's sync action (shared
 * lib/connection-sync.js) — one implementation, two transports.
 */

import { db } from '../lib/db.js';
import { syncTenantConnections } from '../lib/connection-sync.js';

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
    return res.status(503).json({ ok: false, error: 'CRON_SECRET is not set — sync-connections cron is disabled' });
  }
  if (!authorized(req)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const client = db();
  if (!client) return res.status(503).json({ ok: false, error: 'Database not configured' });

  const started = Date.now();
  const result = await syncTenantConnections(client);
  return res.status(result.ok ? 200 : 502).json({
    ok: result.ok,
    error: result.ok ? null : result.error,
    updated: result.updated,
    unchanged_count: (result.unchanged || []).length,
    not_found_on_telnyx: result.not_found_on_telnyx || [],
    connection_names: result.connection_names || {},
    duration_ms: Date.now() - started,
    generated_at: new Date().toISOString()
  });
}
