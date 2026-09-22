// GET /api/stripe/metrics?range=7d|30d|90d|ytd|all
// Aggregates the payments table for the banking Overview hero card and
// the revenue.html sparkline. Reads real payments — no fake demo data.
import { cors } from '../lib/cors.js';
import { bearer, getUserFromToken } from '../lib/auth.js';
import { resolveTenantForUser } from '../lib/tenant-access.js';
import { db } from '../lib/db.js';

const RANGES = { '7d':7, '30d':30, '90d':90, 'ytd':null, 'all':null };

function cutoff(range) {
  if (range === 'ytd') return new Date(new Date().getFullYear(), 0, 1);
  if (range === 'all') return new Date(0);
  const days = RANGES[range] || 30;
  return new Date(Date.now() - days * 86400000);
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  try {
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'not_authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no_tenant' });

    const range = String(req.query?.range || '30d');
    const since = cutoff(range).toISOString();
    const previousStart = new Date(cutoff(range).getTime() - (Date.now() - cutoff(range).getTime())).toISOString();

    const c = db();

    // Current window
    const { data: curr } = await c.from('payments')
      .select('kind, amount, status, created_at')
      .eq('tenant_id', tenant.id)
      .gte('created_at', since);

    // Previous window (same length, immediately before)
    const { data: prev } = await c.from('payments')
      .select('kind, amount, status, created_at')
      .eq('tenant_id', tenant.id)
      .gte('created_at', previousStart)
      .lt('created_at', since);

    const currList = curr || [];
    const prevList = prev || [];

    const netOf = list => list
      .filter(p => p.status === 'succeeded')
      .reduce((s, p) => s + (p.kind === 'refund' ? -Number(p.amount||0) : Number(p.amount||0)), 0);

    const revenue = netOf(currList);
    const prevRevenue = netOf(prevList);
    const trend_pct = prevRevenue > 0 ? Math.round(((revenue - prevRevenue) / prevRevenue) * 100) : 0;

    const charges = currList.filter(p => p.kind === 'charge' && p.status === 'succeeded').length;
    const tips = currList.filter(p => p.kind === 'tip' && p.status === 'succeeded').reduce((s,p) => s + Number(p.amount||0), 0);
    const deposits = currList.filter(p => p.kind === 'deposit' && p.status === 'succeeded').reduce((s,p) => s + Number(p.amount||0), 0);
    const refunds = currList.filter(p => p.kind === 'refund' && p.status === 'succeeded').reduce((s,p) => s + Number(p.amount||0), 0);

    // Sparkline: daily buckets across the range. Cap at 30 points to keep the SVG clean.
    const days = range === 'all' ? 90 : (RANGES[range] || 30);
    const bucketMs = 86400000;
    const spark = [];
    for (let i = days - 1; i >= 0; i--) {
      const dayStart = new Date(Date.now() - (i+1) * bucketMs);
      const dayEnd = new Date(Date.now() - i * bucketMs);
      const inDay = currList.filter(p => {
        const t = new Date(p.created_at).getTime();
        return t >= dayStart.getTime() && t < dayEnd.getTime() && p.status === 'succeeded';
      });
      spark.push({ d: dayStart.toISOString().slice(0,10), v: netOf(inDay) });
    }
    // Keep the last ~30 buckets for readability
    const trimmed = spark.length > 30 ? spark.slice(-30) : spark;

    return res.json({
      ok: true,
      revenue, charges, tips, deposits, refunds,
      currency: 'usd',
      trend_pct,
      sparkline: trimmed
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
