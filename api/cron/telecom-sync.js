/**
 * /api/cron/telecom-sync — every 30 minutes: sync every salon's open number transfers and
 * pending business-texting (10DLC) registrations from Telnyx, in a bounded batch.
 * Completes ports (number → Lola, owner texted), creates campaigns once brands verify, and
 * assigns numbers once campaigns are approved. Webhooks do the same in real time; this
 * catches anything a webhook missed.
 * Auth: Authorization: Bearer <CRON_SECRET> (Vercel Cron GET; POST for manual runs).
 */
import { syncAll } from '../lib/setup/telecom.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ ok: false, error: 'GET/POST only' });
  if (!process.env.CRON_SECRET) return res.status(503).json({ ok: false, error: 'CRON_SECRET is not set — telecom-sync cron is disabled' });
  if ((req.headers.authorization || '') !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  if (!process.env.TELNYX_API_KEY) return res.status(200).json({ ok: true, skipped: 'TELNYX_API_KEY not set' });
  try {
    const limit = Math.min(Math.max(Number(req.query?.limit || 25), 1), 100);
    const out = await syncAll({ limit, budgetMs: 45000 });
    return res.status(200).json(out);
  } catch (e) {
    console.error('[cron/telecom-sync]', e?.message || e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
