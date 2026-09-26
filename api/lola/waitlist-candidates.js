// GET /api/lola/waitlist-candidates?date=YYYY-MM-DD&start_time=HH:MM&stylist=&limit=5
// Returns ranked candidates without sending anything. Used by the calendar
// to preview who WOULD get texted before the owner hits "Ask Lola to fill".
export default async function handler(req, res) {
  let cors, bearer, getUserFromToken, resolveTenantForUser, dbFn;
  try {
    ({ cors } = await import('../lib/cors.js'));
    ({ bearer, getUserFromToken } = await import('../lib/auth.js'));
    ({ resolveTenantForUser } = await import('../lib/tenant-access.js'));
    ({ db: dbFn } = await import('../lib/db.js'));
  } catch (e) { return res.status(500).json({ ok: false, error: 'import_failed', message: String(e?.message || e) }); }

  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  try {
    if (cors && cors(req, res)) return;
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'not_authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no_tenant' });

    const q = req.query || {};
    const startTime = String(q.start_time || '').slice(0, 5);
    const stylist = String(q.stylist || '').slice(0, 200);
    const limit = Math.min(parseInt(q.limit || '5', 10) || 5, 20);

    const c = dbFn();
    let out = [];
    try {
      const { data } = await c.from('booking_waitlist')
        .select('id, client_id, client_name, phone, service, stylist_hint, preferred_time, created_at, status')
        .eq('tenant_id', tenant.id)
        .in('status', ['open', 'active', null])
        .order('created_at', { ascending: true })
        .limit(30);
      out = (data || []).map(w => ({
        source: 'waitlist',
        id: w.client_id || w.id,
        name: w.client_name || 'Client',
        phone_masked: mask(w.phone),
        service: w.service || '',
        preferred_time: w.preferred_time || null,
        stylist_hint: w.stylist_hint || null,
        fit_score: score(w, { startTime, stylist })
      })).sort((a, b) => b.fit_score - a.fit_score).slice(0, limit);
    } catch (_) { out = []; }

    return res.json({ ok: true, data: { candidates: out, count: out.length } });
  } catch (e) {
    console.error('[waitlist-candidates]', e?.message);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
function score(w, gap) {
  let s = 50;
  if (w.preferred_time && gap.startTime) {
    const [ph, pm] = String(w.preferred_time).split(':').map(n => parseInt(n, 10));
    const [gh, gm] = gap.startTime.split(':').map(n => parseInt(n, 10));
    if (Number.isFinite(ph) && Number.isFinite(gh)) {
      const delta = Math.abs((ph * 60 + (pm || 0)) - (gh * 60 + (gm || 0)));
      s += Math.max(0, 40 - Math.floor(delta / 15) * 6);
    }
  }
  if (w.stylist_hint && gap.stylist && String(w.stylist_hint).toLowerCase() === String(gap.stylist).toLowerCase()) s += 20;
  return s;
}
function mask(p) { const d = String(p || '').replace(/\D/g, ''); return d.length >= 4 ? `···${d.slice(-4)}` : '···'; }
