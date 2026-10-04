/**
 * /api/cron/conversation-reports — every 5 minutes: each finished conversation of Lola's Telnyx
 * assistant (the salon's website widget, assistant phone calls) lands on that salon's Calls screen
 * with transcript + summary, and is emailed to the salon. Exactly once per conversation.
 * Auth: Authorization: Bearer <CRON_SECRET> (Vercel Cron GET; POST for manual runs).
 */
import { collectTelnyxConversations } from '../lib/conversation-report.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ ok: false, error: 'GET/POST only' });
  if (!process.env.CRON_SECRET) return res.status(503).json({ ok: false, error: 'CRON_SECRET is not set — conversation-reports cron is disabled' });
  if ((req.headers.authorization || '') !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  if (!process.env.TELNYX_API_KEY) return res.status(200).json({ ok: true, skipped: 'TELNYX_API_KEY not set' });
  try {
    return res.status(200).json(await collectTelnyxConversations({ budgetMs: 45000 }));
  } catch (e) {
    console.error('[cron/conversation-reports]', e?.message || e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
