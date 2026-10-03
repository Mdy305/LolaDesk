/**
 * /api/cron/fill-plans — hourly. Runs every salon's 30-day fill plan:
 * sends each planned campaign on its day (10am–8pm salon time, skipped if the
 * days it targets already filled up) and rebuilds each plan weekly so the next
 * 30 days are always covered. See lib/fill-plan.js.
 */
import { db } from '../lib/db.js';
import { runFillPlans } from '../lib/fill-plan.js';

export default async function handler(req, res) {
  // The marketing tables heal themselves (no manual SQL run needed).
  try { const { ensureMigrations } = await import('../lib/migrate.js'); await ensureMigrations(); } catch (_) {}
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ ok: false, error: 'GET/POST only' });
  if (!process.env.CRON_SECRET) return res.status(503).json({ ok: false, error: 'CRON_SECRET is not set' });
  if ((req.headers.authorization || '') !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  const c = db();
  if (!c) return res.status(503).json({ ok: false, error: 'Database not configured' });
  try {
    const probe = await c.from('lola_fill_plans').select('id').limit(1);
    if (probe.error) return res.status(503).json({ ok: false, error: 'Run sql/revenue-engine.sql in Supabase first.' });
    return res.json({ ok: true, ...(await runFillPlans(c, { budgetMs: 50000 })) });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
