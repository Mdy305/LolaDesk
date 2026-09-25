// POST /api/tenant/billing-policies/preview
// Body: a candidate policies object.
// Returns: rough "what this would have saved you last month" figure,
// computed from cancellations + no-shows in the past 30 days.
import { cors, jsonBody } from '../../lib/cors.js';
import { bearer, getUserFromToken } from '../../lib/auth.js';
import { resolveTenantForUser } from '../../lib/tenant-access.js';
import { db } from '../../lib/db.js';

function isoDaysAgo(n) {
  const d = new Date(); d.setDate(d.getDate() - n);
  return d.toISOString();
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  try {
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'not_authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no_tenant' });

    const body = jsonBody(req) || {};
    const noShowFee = parseInt(body?.no_show?.fee_cents, 10) || 0;
    const lateFee   = parseInt(body?.late_cancel?.fee_cents, 10) || 0;
    const lateHours = parseInt(body?.late_cancel?.hours_before, 10) || 24;

    const c = db();
    const since = isoDaysAgo(30);

    // Pull last 30d appointments for this tenant.
    const { data: appts } = await c.from('appointments')
      .select('id, status, start_time, price_cents, cancelled_at')
      .eq('tenant_id', tenant.id)
      .gte('start_time', since)
      .limit(2000);

    let noShows = 0, lateCancels = 0;
    for (const a of (appts || [])) {
      const status = (a.status || '').toLowerCase();
      if (status === 'no_show' || status === 'no-show') { noShows++; continue; }
      if (status === 'cancelled' || status === 'canceled') {
        if (a.cancelled_at && a.start_time) {
          const hoursBefore = (new Date(a.start_time) - new Date(a.cancelled_at)) / 3600000;
          if (hoursBefore < lateHours) lateCancels++;
        }
      }
    }

    const recovered = noShows * noShowFee + lateCancels * lateFee;

    return res.json({
      ok: true,
      data: {
        last_month_recovered: recovered,
        savings_estimate: recovered,
        breakdown: {
          no_shows: noShows,
          no_show_recovered: noShows * noShowFee,
          late_cancels: lateCancels,
          late_cancel_recovered: lateCancels * lateFee
        },
        window_days: 30,
        currency: 'usd'
      }
    });
  } catch (e) {
    console.error('[billing-policies/preview]', e?.message);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
