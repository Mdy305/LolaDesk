// api/onboarding/step1.js — Who you are (identity)
// Canonical, auth-gated identity step. Replaces the old step1 that used a
// mismatched schema (business_name/primary_phone/industry) and no auth.
import { getUserFromToken, bearer } from '../lib/auth.js';
import { db } from '../lib/db.js';
import { resolveTenantForUser } from '../lib/tenant-access.js';
import { journey } from '../lib/onboarding-engine.js';

function str(v, max){ return String(v ?? '').trim().slice(0, max); }

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
    const name = str(input.name || input.businessName || tenant.name, 160);
    const location = str(input.location ?? tenant.location, 240);
    const hours = str(input.hours ?? tenant.hours, 200);
    const websiteUrl = str(input.websiteUrl || input.website_url || tenant.website_url, 1000);
    const businessMode = str(input.businessMode || input.business_mode || input.industry || tenant.business_mode || 'salon', 40);

    if(!name) return res.status(400).json({ ok:false, error:'A business name is required — that is all Lola needs to start.' });

    const tenantPatch = { name, location, hours, business_mode: businessMode };
    if(websiteUrl) tenantPatch.website_url = websiteUrl;
    await client.from('tenants').update(tenantPatch).eq('id', tenant.id);

    await client.from('tenant_onboarding').update({
      stage: 'business',
      status: 'in_progress',
      progress: 20,
      business: { name, location, website_url: websiteUrl, business_mode: businessMode },
      last_error: null,
      updated_at: new Date().toISOString()
    }).eq('tenant_id', tenant.id);

    const j = await journey(client, { ...tenant, ...tenantPatch });
    return res.status(200).json({ ok:true, tenant_id:tenant.id, ...j });
  }catch(error){
    return res.status(error?.status || 500).json({ ok:false, error:String(error?.message || error) });
  }
}
