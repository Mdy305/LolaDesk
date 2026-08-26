/**
 * /api/cron/booking-reminders — the booking reminder cron.
 *
 * Fired by Vercel Cron hourly (see vercel.json `crons`): texts every client
 * whose confirmed appointment starts ~24h from now, once per appointment
 * time, gated per salon by booking_settings.reminder_sms. Requires
 * CRON_SECRET (Vercel sends `Authorization: Bearer <CRON_SECRET>` on cron
 * GETs; POST with the same header is accepted for manual runs).
 */

import { runReminders } from '../lib/booking-reminders.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ ok: false, error: 'GET/POST only' });

  if (!process.env.CRON_SECRET) {
    return res.status(503).json({ ok: false, error: 'CRON_SECRET is not set — booking reminders disabled' });
  }
  if ((req.headers.authorization || '') !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    const result = await runReminders();
    return res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[cron/booking-reminders]', e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
