// POST /api/tenant/billing-policies/preview
function isoDaysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString(); }
export default async function handler(req, res) {
  let cors, jsonBody, bearer, getUserFromToken, resolveTenantForUser, dbFn;
  try {
    ({ cors, jsonBody } = await import('../../lib/cors.js'));
    ({ bearer, getUserFromToken } = await import('../../lib/auth.js'));
    ({ resolveTenantForUser } = await import('../../lib/tenant-access.js'));
    ({ db: dbFn } = await import('../../lib/db.js'));
  } catch (e) { return res.status(500).json({ ok: false, error: 'import_failed', message: String(e?.message || e) }); }

  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  try {
    if (cors && cors(req, res)) return;
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'not_authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no_tenant' });

    const body = (jsonBody ? jsonBody(req) : null) || {};
    const noShowFee = parseInt(body?.no_show?.fee_cents, 10) || 0;
    const lateFee   = parseInt(body?.late_cancel?.fee_cents, 10) || 0;
    const lateHours = parseInt(body?.late_cancel?.hours_before, 10) || 24;

    let appts = [];
    try {
      const { data } = await dbFn().from('appointments')
        .select('id, status, start_time, price_cents, cancelled_at')
        .eq('tenant_id', tenant.id)
        .gte('start_time', isoDaysAgo(30))
        .limit(2000);
      appts = data || [];
    } catch (_) { appts = []; }

    let noShows = 0, lateCancels = 0;
    for (const a of appts) {
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
        last_month_recovered: recovered, savings_estimate: recovered,
        breakdown: { no_shows: noShows, no_show_recovered: noShows * noShowFee, late_cancels: lateCancels, late_cancel_recovered: lateCancels * lateFee },
        window_days: 30, currency: 'usd'
      }
    });
  } catch (e) { return res.status(500).json({ ok: false, error: String(e?.message || e) }); }
}
