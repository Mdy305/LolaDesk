/**
 * /api/cron/campaigns — keeps Lola's text campaigns going (every minute).
 * Sends the next paced batch of every campaign that is "sending", only
 * inside 9am–8pm salon time. Requires CRON_SECRET (Vercel sends it).
 */
import { db } from '../lib/db.js';
import { runSender } from '../lib/marketing.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ ok: false, error: 'GET/POST only' });
  if (!process.env.CRON_SECRET) return res.status(503).json({ ok: false, error: 'CRON_SECRET is not set' });
  if ((req.headers.authorization || '') !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  const c = db();
  if (!c) return res.status(503).json({ ok: false, error: 'Database not configured' });
  try {
    const results = await runSender(c, { budgetMs: 45000 });
    return res.json({ ok: true, campaigns: results.length, sent: results.reduce((s, r) => s + (r.sent || 0), 0), results });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
