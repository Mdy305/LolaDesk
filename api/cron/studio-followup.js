/**
 * /api/cron/studio-followup — MMA Studio: one next-day text to clients who tried a look but did not reserve.
 * Fired hourly by Vercel Cron (vercel.json). Requires CRON_SECRET, like every cron here.
 */
import { db } from '../lib/db.js';
import { studioFollowups } from '../lib/studio-server.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ ok: false, error: 'GET/POST only' });
  if (!process.env.CRON_SECRET) return res.status(503).json({ ok: false, error: 'CRON_SECRET is not set' });
  if ((req.headers.authorization || '') !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  const c = db();
  if (!c) return res.status(503).json({ ok: false, error: 'Database not configured' });
  try { return res.status(200).json({ ok: true, ...(await studioFollowups(c)) }); }
  catch (e) { console.error('[studio-followup]', e.message); return res.status(500).json({ ok: false, error: 'server_error' }); }
}
