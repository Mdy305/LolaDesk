import { bearer, getUserFromToken } from './auth.js';
import { resolveTenantForUser } from './tenant-access.js';
import { db, getTenantByPhoneStrict } from './db.js';

export async function authenticatedTenant(req){
  const token=bearer(req);
  if(!token) return null;
  const user=await getUserFromToken(token);
  if(!user) return null;
  return (await resolveTenantForUser(user)) || null;
}

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A public visitor (booking widget, website, Google profile link) names the
// salon by slug or id. An unknown name is "not found" — never the demo salon,
// so a typo can't put a real client's booking on the wrong calendar.
export async function publicTenant(req, body={}){
  const c=db();
  if(!c) return null;
  if(body.tenant_id && UUID.test(String(body.tenant_id))){
    const {data}=await c.from('tenants').select('*').eq('id',body.tenant_id).maybeSingle();
    if(data) return data;
  }
  const slug=String(body.tenant || req.query?.tenant || req.query?.slug || '').trim().slice(0,120);
  if(slug){
    const {data}=await c.from('tenants').select('*').eq('slug',slug).maybeSingle();
    if(data) return data;
    // Slugs are case-insensitive on links people type ("MMA-Salon" = "mma-salon").
    // ilike with LIKE wildcards escaped, so "_" / "%" can't match other salons;
    // more than one hit is ambiguous → not found, never a guess.
    if(/^[\w.-]+$/.test(slug)){
      const pattern=slug.replace(/[\\%_]/g,(m)=>'\\'+m);
      const {data:ci}=await c.from('tenants').select('*').ilike('slug',pattern).limit(2);
      const hits=(ci||[]).filter(t=>String(t.slug||'').toLowerCase()===slug.toLowerCase());
      if(hits.length===1) return hits[0];
    }
    if(UUID.test(slug)){
      const {data:byId}=await c.from('tenants').select('*').eq('id',slug).maybeSingle();
      if(byId) return byId;
    }
    return null;
  }
  const phone=body.to || req.query?.to || req.headers?.['x-lola-number'] || '';
  if(phone) return getTenantByPhoneStrict(phone);
  return null;
}

export async function tenantForRequest(req, body={}){
  if(req.__publicBooking === true) return publicTenant(req,body);
  return authenticatedTenant(req);
}
