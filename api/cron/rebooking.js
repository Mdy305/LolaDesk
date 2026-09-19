/**
 * /api/cron/rebooking — the auto-rebooking sweep.
 *
 * Fired by Vercel Cron hourly (see vercel.json `crons`): advances offers
 * whose proposed slot filled (next open day, one re-text per advance),
 * marks offers booked when the client rebooks the same service, and expires
 * offers whose window closed with one gentle nudge. Exactly-once per row via
 * status-conditional claims (see api/lib/rebooking.js). Requires CRON_SECRET
 * (Vercel sends `Authorization: Bearer <CRON_SECRET>` on cron GETs; POST with
 * the same header is accepted for manual runs).
 */

import { runRebookingSweep } from '../lib/rebooking.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ ok: false, error: 'GET/POST only' });

  if (!process.env.CRON_SECRET) {
    return res.status(503).json({ ok: false, error: 'CRON_SECRET is not set — rebooking sweep disabled' });
  }
  if ((req.headers.authorization || '') !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    const result = await runRebookingSweep();
    return res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[cron/rebooking]', e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
