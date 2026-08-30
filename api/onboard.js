// api/onboard.js — legacy public onboarding (create tenant + analyze website)
// Now routed through lib/onboarding-engine.js so there is exactly ONE
// website-analysis implementation. Keeps the original public contract
// ({ ok, tenant, knowledge, analysisError, message }) and adds lola_says
// so callers get Lola's opening line immediately after discovery.
import { upsertTenant, db } from './lib/db.js';
import { discoverWebsite, applyDiscovery, previewGreeting } from './lib/onboarding-engine.js';

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method === 'OPTIONS') return res.status(200).end();
  if(req.method !== 'POST') return res.status(405).json({ ok:false, error:'POST only' });
  try{
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { name, websiteUrl, businessMode } = body;
    if(!name) return res.status(400).json({ ok:false, error:'name required' });
    const slug = body.slug || name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
    const tenant = await upsertTenant({ ...body, slug });

    let knowledge = null, analysisError = null, usedLlm = false, lola_says = null;
    if(websiteUrl && tenant?.id){
      try{
        const discovery = await discoverWebsite({ websiteUrl, businessMode, name });
        const applied = await applyDiscovery(db(), tenant, discovery.knowledge);
        knowledge = discovery.knowledge;
        usedLlm = discovery.usedLlm;

        // Reflect the just-drafted menu in the greeting.
        const client = db();
        let fresh = tenant;
        if(client){
          const { data } = await client.from('tenants').select('*').eq('id', tenant.id).maybeSingle();
          if(data) fresh = data;
        }
        lola_says = previewGreeting({ ...fresh, services: applied.services.length ? applied.services : fresh.services });
      }catch(e){
        analysisError = String(e?.message || e);
      }
    }

    return res.status(200).json({
      ok: true,
      tenant: tenant ? { id: tenant.id, slug: tenant.slug, name: tenant.name } : null,
      knowledge,
      analysisError,
      usedLlm,
      lola_says,
      message: knowledge
        ? `Lola now knows ${name}.`
        : `Tenant created. ${analysisError ? 'Analysis failed: ' + analysisError : 'No website provided.'}`
    });
  }catch(e){
    return res.status(500).json({ ok:false, error:String(e) });
  }
}
