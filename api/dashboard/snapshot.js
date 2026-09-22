// GET /api/dashboard/snapshot
// Today's snapshot for dashboard.html: revenue today, upcoming bookings,
// missed calls, unread messages, at-risk payments.
import { cors } from '../lib/cors.js';
import { bearer, getUserFromToken } from '../lib/auth.js';
import { resolveTenantForUser } from '../lib/tenant-access.js';
import { db } from '../lib/db.js';

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  try {
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'not_authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no_tenant' });

    const c = db();
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();

    // Parallelize all snapshot queries.
    const [
      paymentsToday,
      bookingsUpcoming,
      callsMissed,
      threadsUnread,
      paymentsAtRisk,
      bookingsToday
    ] = await Promise.all([
      c.from('payments')
        .select('amount, kind')
        .eq('tenant_id', tenant.id)
        .eq('status', 'succeeded')
        .gte('created_at', startOfDay),
      c.from('bookings')
        .select('id, start_time, service_id, staff_id, client_id, total_amount, outcome')
        .eq('tenant_id', tenant.id)
        .gte('start_time', now.toISOString())
        .order('start_time', { ascending: true })
        .limit(10),
      c.from('calls')
        .select('id')
        .eq('tenant_id', tenant.id)
        .eq('outcome', 'missed')
        .gte('started_at', sevenDaysAgo),
      c.from('inbox_threads')
        .select('id')
        .eq('tenant_id', tenant.id)
        .eq('unread', true),
      c.from('payments')
        .select('amount')
        .eq('tenant_id', tenant.id)
        .eq('at_risk', true)
        .eq('refunded', false),
      c.from('bookings')
        .select('id, outcome')
        .eq('tenant_id', tenant.id)
        .gte('start_time', startOfDay)
        .lt('start_time', endOfDay)
    ]);

    const todayGross = (paymentsToday.data || []).reduce((sum, p) => {
      if (p.kind === 'charge' || p.kind === 'tip') return sum + Number(p.amount || 0);
      if (p.kind === 'refund') return sum - Number(p.amount || 0);
      return sum;
    }, 0);

    const atRiskTotal = (paymentsAtRisk.data || []).reduce((s, p) => s + Number(p.amount || 0), 0);

    const bookingsTodayCount = (bookingsToday.data || []).length;
    const bookingsTodayCompleted = (bookingsToday.data || []).filter(b => b.outcome === 'completed').length;

    return res.json({
      ok: true,
      snapshot: {
        revenue_today_cents: todayGross,
        bookings_today: bookingsTodayCount,
        bookings_today_completed: bookingsTodayCompleted,
        bookings_upcoming: bookingsUpcoming.data || [],
        missed_calls_7d: (callsMissed.data || []).length,
        unread_messages: (threadsUnread.data || []).length,
        at_risk_cents: atRiskTotal,
        at_risk_count: (paymentsAtRisk.data || []).length
      }
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
