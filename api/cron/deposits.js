/**
 * /api/cron/deposits — the no-show protection sweep.
 *
 * Fired by Vercel Cron hourly (see vercel.json `crons`): reviews pending and
 * paid deposits against their bookings' outcomes — refunds in-window
 * cancellations, keeps deposits on no-shows and late cancels, flags unpaid
 * deposits at start time. Exactly-once per row via status-conditional claims
 * (see api/lib/deposits.js). Requires CRON_SECRET (Vercel sends
 * `Authorization: Bearer <CRON_SECRET>` on cron GETs; POST with the same
 * header is accepted for manual runs).
 */

import { runDepositSweep } from '../lib/deposits.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ ok: false, error: 'GET/POST only' });

  if (!process.env.CRON_SECRET) {
    return res.status(503).json({ ok: false, error: 'CRON_SECRET is not set — deposit sweep disabled' });
  }
  if ((req.headers.authorization || '') !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    const result = await runDepositSweep();
    return res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[cron/deposits]', e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
