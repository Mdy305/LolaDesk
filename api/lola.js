/**
 * /api/lola — proxy used by dashboard front-end Voice Control
 * ════════════════════════════════════════════════════════════════
 * This handles the web UI voice orb commands. It supports tool
 * calling by defining Lola's core skills as OpenAI tools. If Lola
 * decides to execute a skill, it is safely routed through the
 * Supabase Orchestrator in a multi-turn agentic loop.
 *
 * The brain itself lives in lib/dashboard-brain.js and is shared with
 * /api/voice/session (the direct, telephony-independent voice session
 * the orb uses) — one brain, every channel.
 */

import { getUserFromToken, bearer } from './lib/auth.js';
import { resolveTenantForUser } from './lib/tenant-access.js';
import { dashboardBrainReply } from './lib/dashboard-brain.js';

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if(req.method === 'OPTIONS') return res.status(200).end();
  if(req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try{
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});

    // Owner-scoped: dashboard voice control may only act on the authenticated
    // owner's own tenant. The client-supplied x-tenant-id is ignored — it
    // previously let anyone act on any salon just by passing a slug.
    let tenant = null;
    try{
      const user = await getUserFromToken(bearer(req));
      if(user) tenant = await resolveTenantForUser(user);
    }catch{}
    if (!tenant?.id) return res.status(401).json({ error: 'Not authenticated' });

    const out = await dashboardBrainReply({ tenant, body });
    return res.status(out.status).json(out.json);
  }catch(e){
    return res.status(500).json({ type:'error', error:{ type:'server_error', message: String(e) } });
  }
}
