import { getUserFromToken, bearer } from './lib/auth.js';
import { db } from './lib/db.js';
import { resolveTenantForUser } from './lib/tenant-access.js';

function body(req){
  if(!req.body) return {};
  if(typeof req.body === 'string') return JSON.parse(req.body || '{}');
  return req.body;
}

function cleanObject(value){
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

async function context(req){
  const user = await getUserFromToken(bearer(req));
  if(!user) throw Object.assign(new Error('Not authenticated'), { status:401 });
  const tenant = await resolveTenantForUser(user);
  if(!tenant?.id) throw Object.assign(new Error('No tenant mapped to this account'), { status:404 });
  const client = db();
  if(!client) throw Object.assign(new Error('Database not configured'), { status:503 });
  return { user, tenant, client };
}

async function getState(client, tenant){
  const { data, error } = await client.from('tenant_onboarding').select('*').eq('tenant_id', tenant.id).maybeSingle();
  if(error) throw error;
  if(data) return data;
  const initial = {
    tenant_id: tenant.id,
    stage:'business', status:'in_progress', progress:10,
    business:{ name:tenant.name, location:tenant.location, website_url:tenant.website_url },
    booking:{ booking_url:tenant.booking_url }, channels:{}, persona:{ persona:tenant.persona || 'warm' }, provisioning:{}
  };
  const created = await client.from('tenant_onboarding').insert(initial).select().single();
  if(created.error) throw created.error;
  return created.data;
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, PATCH, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  if(req.method === 'OPTIONS') return res.status(204).end();
  if(!['GET','PATCH','POST'].includes(req.method)) return res.status(405).json({ ok:false, error:'Method Not Allowed' });

  try{
    const { tenant, client } = await context(req);
    if(req.method === 'GET') return res.status(200).json({ ok:true, tenant_id:tenant.id, onboarding:await getState(client, tenant) });

    const input = body(req);
    const current = await getState(client, tenant);
    const progress = Math.max(0, Math.min(100, Number(input.progress ?? current.progress ?? 10)));
    const status = input.status || (progress >= 100 ? 'complete' : current.status || 'in_progress');
    const patch = {
      stage: input.stage || current.stage,
      status,
      progress,
      business: { ...cleanObject(current.business), ...cleanObject(input.business) },
      channels: { ...cleanObject(current.channels), ...cleanObject(input.channels) },
      booking: { ...cleanObject(current.booking), ...cleanObject(input.booking) },
      persona: { ...cleanObject(current.persona), ...cleanObject(input.persona) },
      provisioning: { ...cleanObject(current.provisioning), ...cleanObject(input.provisioning) },
      last_error: input.last_error ?? current.last_error,
      completed_at: status === 'complete' ? (current.completed_at || new Date().toISOString()) : null,
      updated_at: new Date().toISOString()
    };

    const result = await client.from('tenant_onboarding').update(patch).eq('tenant_id', tenant.id).select().single();
    if(result.error) throw result.error;

    const tenantPatch = {};
    if(input.business?.name) tenantPatch.name = input.business.name;
    if(input.business?.location != null) tenantPatch.location = input.business.location;
    if(input.business?.website_url != null) tenantPatch.website_url = input.business.website_url;
    if(input.booking?.booking_url != null) tenantPatch.booking_url = input.booking.booking_url;
    if(input.persona?.persona) tenantPatch.persona = input.persona.persona;
    if(Object.keys(tenantPatch).length) await client.from('tenants').update(tenantPatch).eq('id', tenant.id);

    return res.status(200).json({ ok:true, tenant_id:tenant.id, onboarding:result.data });
  }catch(error){
    return res.status(error?.status || 500).json({ ok:false, error:String(error?.message || error) });
  }
}
