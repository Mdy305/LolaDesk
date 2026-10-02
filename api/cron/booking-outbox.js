/**
 * /api/cron/booking-outbox — every minute: commit LolaDesk bookings to each salon's own
 * booking platform (retries with backoff; the owner is texted if the platform refuses).
 * Requires CRON_SECRET (Vercel sends `Authorization: Bearer <CRON_SECRET>`).
 */
import { processOutbox } from '../lib/booking-outbox.js';
import { db } from '../lib/db.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ ok: false });
  if (!process.env.CRON_SECRET) return res.status(503).json({ ok: false, error: 'CRON_SECRET is not set — background booking sync disabled' });
  if ((req.headers.authorization || '') !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  try { const r = await processOutbox(db(), { limit: 50 }); delete r.results; return res.json(r); }
  catch (e) { return res.status(500).json({ ok: false, error: String(e?.message || e) }); }
}
