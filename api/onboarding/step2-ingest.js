// api/onboarding/step2-ingest.js — The magic: Lola reads your website
// The reveal moment. The owner pastes a URL, Lola reads it with the LLM
// (falls back to a heuristic when inference is down), drafts their service
// menu and brand voice, and hands back her actual opening line.
import { getUserFromToken, bearer } from '../lib/auth.js';
import { db } from '../lib/db.js';
import { resolveTenantForUser } from '../lib/tenant-access.js';
import {
  safePublicUrl, discoverWebsite, applyDiscovery,
  previewGreeting, journey
} from '../lib/onboarding-engine.js';

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  if(req.method === 'OPTIONS') return res.status(204).end();
  if(req.method !== 'POST') return res.status(405).json({ ok:false, error:'POST only' });

  try{
    const user = await getUserFromToken(bearer(req));
    if(!user) return res.status(401).json({ ok:false, error:'Not authenticated' });
    const tenant = await resolveTenantForUser(user);
    if(!tenant?.id) return res.status(404).json({ ok:false, error:'No tenant mapped to this account' });
    const client = db();
    if(!client) return res.status(503).json({ ok:false, error:'Database not configured' });

    const input = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const websiteUrl = safePublicUrl(input.websiteUrl || input.website_url || tenant.website_url || '');
    if(!websiteUrl) return res.status(400).json({ ok:false, error:'A website URL is required — that is all Lola needs to learn your business.' });

    const discovery = await discoverWebsite({ websiteUrl, businessMode: tenant.business_mode || 'salon', name: tenant.name });
    const applied = await applyDiscovery(client, tenant, discovery.knowledge);

    // Refresh so the greeting below reflects the just-drafted menu.
    const { data: fresh } = await client.from('tenants').select('*').eq('id', tenant.id).maybeSingle();
    const t = fresh || tenant;

    await client.from('tenant_onboarding').update({
      stage: 'discovery',
      status: 'in_progress',
      progress: 50,
      business: {
        website_url: websiteUrl,
        discovered: {
          title: discovery.website.title,
          services_found: applied.services.length,
          used_llm: discovery.usedLlm
        }
      },
      last_error: null,
      updated_at: new Date().toISOString()
    }).eq('tenant_id', tenant.id);

    const j = await journey(client, t);
    return res.status(200).json({
      ok: true,
      tenant_id: tenant.id,
      lola_says: previewGreeting(t),
      learned: {
        services: applied.services,
        services_count: applied.services.length,
        tone: discovery.knowledge.tone || null,
        positioning: discovery.knowledge.positioning || null,
        audience: discovery.knowledge.audience || null,
        summary: discovery.knowledge.summary || null,
        usp: discovery.knowledge.usp || null,
        opportunities: Array.isArray(discovery.knowledge.opportunities) ? discovery.knowledge.opportunities : [],
        hours: discovery.knowledge.hours || null,
        used_llm: discovery.usedLlm
      },
      ...j
    });
  }catch(error){
    return res.status(error?.status || 500).json({ ok:false, error:String(error?.message || error) });
  }
}
