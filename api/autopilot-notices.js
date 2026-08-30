/**
 * /api/autopilot-notices — recent Lola Autopilot run summaries for the
 * owner's dashboard (the ONE floating notification).
 *
 *   GET /api/autopilot-notices  (Authorization: Bearer <access_token>)
 *     → { ok, tenant_id, runs: [{ id, agent, status, summary, ran_at }] }
 *
 * Returns agent_runs from the last 24h that this signed-in user should
 * see:
 *   · platform-wide runs (tenant_id NULL — routing-heal, sync sweeps)
 *   · tenant-agent runs for the caller's OWN salon (missed-call recovery,
 *     rebooking, sync-self-heal per salon)
 *
 * The client (lola-autopilot-announce.js) dedupes by run id in
 * localStorage and announces each NEW run through LolaNotify — so after
 * every hourly autopilot run, the owner sees "Lola recovered 3 missed
 * calls" slide in live, on whatever page they're on. Same lib as the
 * cron and the Command screen (api/lib/autopilot.js) — this endpoint
 * only READS the ledger it writes.
 */
import { bearer, getUserFromToken } from './lib/auth.js';
import { db } from './lib/db.js';
import { resolveTenantForUser } from './lib/tenant-access.js';

const WINDOW_MS = 24 * 3600 * 1000;

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  if(req.method === 'OPTIONS') return res.status(200).end();
  if(req.method !== 'GET') return res.status(405).json({ ok:false, error:'GET only' });

  try{
    const user = await getUserFromToken(bearer(req));
    if(!user) return res.status(401).json({ ok:false, error:'not authenticated' });

    const c = db();
    if(!c) return res.status(503).json({ ok:false, error:'database not configured' });

    const tenant = await resolveTenantForUser(user);
    const since = new Date(Date.now() - WINDOW_MS).toISOString();
    const { data } = await c.from('agent_runs')
      .select('id,agent,tenant_id,status,summary,ran_at')
      .gte('ran_at', since)
      .order('ran_at', { ascending:false })
      .limit(100)
      .then(r => r).catch(() => ({ data: [] }));

    const visible = (data || []).filter(r =>
      !r.tenant_id || (tenant && r.tenant_id === tenant.id)
    ).map(r => ({ id:r.id, agent:r.agent, status:r.status, summary:r.summary, ran_at:r.ran_at }));

    return res.status(200).json({ ok:true, tenant_id: tenant?.id || null, runs: visible });
  }catch(e){
    return res.status(500).json({ ok:false, error:String(e && e.message || e) });
  }
}
