/**
 * /api/cron/release-numbers — daily (suggested schedule "41 6 * * *").
 * Bearer CRON_SECRET (Vercel Cron sends it; POST with the same header for manual runs).
 *
 *   1. accrueMonthly  — this month's line costs (cost_number_month / cost_esim_month, in
 *                       cents) and add-on rent (extra lines, eSIMs) — once per month, idempotent.
 *   2. runReleaseNumbers — salons off > 30 days: lines back to the pool (ported numbers
 *                       parked); 7 days before, one heads-up to the owner.
 * ?dry=1 reports what would be released without touching anything.
 */
import { db } from '../lib/db.js';
import { accrueMonthly } from '../lib/rent.js';
import { runReleaseNumbers } from '../lib/release-numbers.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ ok: false, error: 'GET/POST only' });
  if (!process.env.CRON_SECRET) return res.status(503).json({ ok: false, error: 'CRON_SECRET is not set' });
  if ((req.headers?.authorization || '') !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  const c = db();
  if (!c) return res.status(503).json({ ok: false, error: 'Database not configured' });
  try {
    const dry = /^(1|true)$/i.test(String(req.query?.dry || ''));
    const env = dry ? { ...process.env, RELEASE_NUMBERS_DRY_RUN: '1' } : process.env;
    const accrual = dry ? null : await accrueMonthly(c).catch((e) => ({ error: String(e?.message || e) }));
    const release = await runReleaseNumbers(c, { env });
    return res.json({ ok: true, accrual, release });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
