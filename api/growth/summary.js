// GET /api/growth/summary — rollup of growth KPIs across gap-fill, rebooking, reviews, referrals.
export default async function handler(req, res) {
  let cors, bearer, getUserFromToken, resolveTenantForUser, dbFn;
  try {
    ({ cors } = await import('./lib/cors.js'));
    ({ bearer, getUserFromToken } = await import('./lib/auth.js'));
    ({ resolveTenantForUser } = await import('./lib/tenant-access.js'));
    ({ db: dbFn } = await import('./lib/db.js'));
  } catch (e) { return res.status(500).json({ ok:false, error:'import_failed', message:String(e?.message||e) }); }
  if (req.method !== 'GET') return res.status(405).json({ ok:false, error:'method_not_allowed' });
  try {
    if (cors && cors(req, res)) return;
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok:false, error:'not_authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok:false, error:'no_tenant' });

    const c = dbFn();
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const [gaps, waitlist, rebook, reviews, referrals, revenue, pol] = await Promise.all([
      c.from('fill_gap_attempts').select('id', { count: 'exact', head: true }).eq('tenant_id', tenant.id).eq('outcome', 'booked').gte('created_at', since).catch(() => ({ count: 0 })),
      c.from('clients').select('id', { count: 'exact', head: true }).eq('tenant_id', tenant.id).eq('on_waitlist', true).catch(() => ({ count: 0 })),
      c.from('appointments').select('id', { count: 'exact', head: true }).eq('tenant_id', tenant.id).eq('source', 'winback').gte('created_at', since).catch(() => ({ count: 0 })),
      c.from('reviews').select('id', { count: 'exact', head: true }).eq('tenant_id', tenant.id).gte('created_at', since).catch(() => ({ count: 0 })),
      c.from('referrals').select('id', { count: 'exact', head: true }).eq('tenant_id', tenant.id).gte('created_at', since).catch(() => ({ count: 0 })),
      c.from('pos_transactions').select('total_cents').eq('tenant_id', tenant.id).eq('status', 'succeeded').gte('created_at', since).catch(() => ({ data: [] })),
      c.from('billing_policies').select('*').eq('tenant_id', tenant.id).maybeSingle().catch(() => ({ data: null })),
    ]);
    const revenue_cents = (revenue.data || []).reduce((a, r) => a + (r.total_cents || 0), 0);
    return res.json({ ok:true, data: {
      filled_gaps_month: gaps.count || 0,
      waitlist_size: waitlist.count || 0,
      rebook_winbacks_month: rebook.count || 0,
      due_winbacks: null,
      new_reviews_month: reviews.count || 0,
      referrals_month: referrals.count || 0,
      revenue_month_cents: revenue_cents,
      referral_program_on: !!pol.data?.referral?.enabled,
      review_auto_on: !!pol.data?.review_auto?.enabled,
      deposits_on: !!pol.data?.deposit?.enabled,
    }});
  } catch (e) { console.error('[growth/summary]', e?.message); return res.status(500).json({ ok:false, error:String(e?.message||e) }); }
}
