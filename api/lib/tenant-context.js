import { bearer, getUserFromToken } from './auth.js';
import { resolveTenantForUser } from './tenant-access.js';
import { db, getTenantByPhone, getTenantBySlug } from './db.js';

export async function authenticatedTenant(req){
  const token=bearer(req);
  if(!token) return null;
  const user=await getUserFromToken(token);
  if(!user) return null;
  return (await resolveTenantForUser(user)) || null;
}

export async function publicTenant(req, body={}){
  const c=db();
  if(body.tenant_id && c){
    const {data}=await c.from('tenants').select('*').eq('id',body.tenant_id).maybeSingle();
    if(data) return data;
  }
  const slug=body.tenant || req.query?.tenant || req.query?.slug;
  if(slug) return getTenantBySlug(slug);
  const phone=body.to || req.query?.to || req.headers['x-lola-number'] || '';
  if(phone) return getTenantByPhone(phone);
  return null;
}

export async function tenantForRequest(req, body={}){
  if(req.__publicBooking === true) return publicTenant(req,body);
  return authenticatedTenant(req);
}
