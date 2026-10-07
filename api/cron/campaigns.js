/**
 * /api/cron/campaigns — keeps Lola's text campaigns going (every minute).
 * Sends the next paced batch of every campaign that is "sending", only
 * inside 9am–8pm salon time. Requires CRON_SECRET (Vercel sends it).
 * A salon whose service is off (lib/service-gate.js) has its sending campaigns
 * PAUSED first (never cancelled — the owner resumes them after resubscribing).
 */
import { db } from '../lib/db.js';
import { runSender } from '../lib/marketing.js';
import { serviceAllowed } from '../lib/service-gate.js';

/** Pause the sending campaigns of salons whose service is off. Never throws. */
export async function pauseInactive(c) {
  const paused = [];
  try {
    const { data: camps } = await c.from('lola_campaigns').select('id,tenant_id').eq('status', 'sending').limit(200);
    const gate = new Map();
    for (const camp of camps || []) {
      if (!gate.has(camp.tenant_id)) {
        const { data: t } = await c.from('tenants').select('*').eq('id', camp.tenant_id).maybeSingle();
        gate.set(camp.tenant_id, t ? await serviceAllowed(t) : { ok: true });
      }
      const g = gate.get(camp.tenant_id);
      if (g.ok) continue;
      await c.from('lola_campaigns').update({ status: 'paused' }).eq('id', camp.id).eq('status', 'sending');
      paused.push({ campaign: camp.id, tenant: camp.tenant_id, reason: g.reason });
    }
  } catch (_) {}
  return paused;
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ ok: false, error: 'GET/POST only' });
  if (!process.env.CRON_SECRET) return res.status(503).json({ ok: false, error: 'CRON_SECRET is not set' });
  if ((req.headers.authorization || '') !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  const c = db();
  if (!c) return res.status(503).json({ ok: false, error: 'Database not configured' });
  try {
    const paused = await pauseInactive(c);
    const results = await runSender(c, { budgetMs: 45000 });
    return res.json({ ok: true, campaigns: results.length, sent: results.reduce((s, r) => s + (r.sent || 0), 0), results, paused });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
