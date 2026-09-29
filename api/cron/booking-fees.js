/**
 * /api/cron/booking-fees — daily. Records a fee for every appointment Lola
 * booked (any path), settles appointments that happened (cancelled/no-show
 * → nothing owed), and — only with BOOKING_FEES_LIVE=1 — adds them to each
 * paying salon's next LolaDesk invoice. See lib/booking-fees.js.
 */
import { db } from '../lib/db.js';
import { runBookingFees } from '../lib/booking-fees.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ ok: false, error: 'GET/POST only' });
  if (!process.env.CRON_SECRET) return res.status(503).json({ ok: false, error: 'CRON_SECRET is not set' });
  if ((req.headers.authorization || '') !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  const c = db();
  if (!c) return res.status(503).json({ ok: false, error: 'Database not configured' });
  try {
    const probe = await c.from('booking_fees').select('id').limit(1);
    if (probe.error) return res.status(503).json({ ok: false, error: 'Run sql/revenue-engine.sql in Supabase first.' });
    return res.json({ ok: true, ...(await runBookingFees(c)) });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
