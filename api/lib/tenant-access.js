import { db } from './db.js';

function normalizeRole(value, fallback='staff'){
  const role=String(value||fallback).trim().toLowerCase().replace(/[^a-z0-9_-]/g,'');
  return role||fallback;
}

export async function resolveTenantAccessForUser(user){
  const c=db();
  if(!c||!user?.id) return null;

  try{
    const { data:links }=await c
      .from('tenant_users')
      .select('tenant_id,role')
      .eq('user_id',user.id)
      .limit(1);
    const link=links?.[0];
    if(link?.tenant_id){
      const { data }=await c.from('tenants').select('*').eq('id',link.tenant_id).limit(1);
      if(data?.[0]) return {tenant:data[0],role:normalizeRole(link.role)};
    }
  }catch{}

  if(user.email){
    const { data }=await c.from('tenants').select('*').eq('owner_email',user.email).limit(1);
    if(data?.[0]) return {tenant:data[0],role:'owner'};
  }
  return null;
}

export async function resolveTenantForUser(user){
  const access=await resolveTenantAccessForUser(user);
  return access?.tenant||null;
}
