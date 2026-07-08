/**
 * /api/admin — the platform owner's control plane
 * ════════════════════════════════════════════════════════════════
 * For YOU (the LolaDesk operator), not for salons. Hard-gated:
 * the session's email must appear in the ADMIN_EMAILS env var
 * (comma-separated, case-insensitive). No env var set → nobody is
 * admin → 403 for everyone. Tenant owners can never reach this.
 *
 *   GET  /api/admin            → platform metrics + tenant roster
 *   POST /api/admin {action:'suspend'|'activate', tenant_id}
 *
 * Suspend flips billing_status only — data is never touched, and
 * one 'activate' restores everything (same churn-pause philosophy
 * as the rest of the platform).
 */
import { bearer, getUserFromToken } from './lib/auth.js';
import { db } from './lib/db.js';

function isAdmin(email){
  const list = String(process.env.ADMIN_EMAILS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return !!email && list.includes(String(email).toLowerCase());
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if(req.method === 'OPTIONS') return res.status(200).end();

  const user = await getUserFromToken(bearer(req));
  if(!user) return res.status(401).json({ ok:false, error:'Not signed in' });
  if(!isAdmin(user.email)) return res.status(403).json({ ok:false, error:'Not authorized' });

  const c = db();
  if(!c) return res.status(503).json({ ok:false, error:'Database not configured' });

  if(req.method === 'GET'){
    const midnight = new Date(); midnight.setHours(0,0,0,0);
    const [tenants, msgsToday, callsToday, bookingsToday] = await Promise.all([
      c.from('tenants')
        .select('id,slug,name,owner_email,plan,billing_status,phone_number,business_mode,created_at')
        .order('created_at', { ascending:false }).limit(500)
        .then(r => r.data || []),
      c.from('messages').select('id', { count:'exact' }).gte('created_at', midnight.toISOString()).limit(1)
        .then(r => r.count ?? 0).catch(()=>0),
      c.from('calls').select('id', { count:'exact' }).gte('created_at', midnight.toISOString()).limit(1)
        .then(r => r.count ?? 0).catch(()=>0),
      c.from('bookings').select('id', { count:'exact' }).gte('created_at', midnight.toISOString()).limit(1)
        .then(r => r.count ?? 0).catch(()=>0)
    ]);
    const byPlan = {}, byStatus = {};
    for(const t of tenants){
      byPlan[t.plan || 'none'] = (byPlan[t.plan || 'none'] || 0) + 1;
      byStatus[t.billing_status || 'trial'] = (byStatus[t.billing_status || 'trial'] || 0) + 1;
    }
    return res.status(200).json({ ok:true,
      metrics: { tenants: tenants.length, by_plan: byPlan, by_status: byStatus,
                 messages_today: msgsToday, calls_today: callsToday, bookings_today: bookingsToday },
      tenants });
  }

  if(req.method === 'POST'){
    const body = typeof req.body === 'string' ? JSON.parse(req.body||'{}') : (req.body||{});
    const { action, tenant_id } = body;
    if(!tenant_id || !['suspend','activate'].includes(action))
      return res.status(400).json({ ok:false, error:'action must be suspend|activate with tenant_id' });
    const { data, error } = await c.from('tenants')
      .update({ billing_status: action === 'suspend' ? 'suspended' : 'active' })
      .eq('id', tenant_id).select('id,slug,name,billing_status').maybeSingle();
    if(error || !data) return res.status(404).json({ ok:false, error:'tenant not found' });
    return res.status(200).json({ ok:true, tenant: data });
  }

  return res.status(405).json({ ok:false });
}
