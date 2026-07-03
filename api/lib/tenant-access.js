import { db } from './db.js';

export async function resolveTenantForUser(user){
  const c = db();
  if(!c || !user?.id) return null;

  try{
    const { data: links } = await c
      .from('tenant_users')
      .select('tenant_id')
      .eq('user_id', user.id)
      .limit(1);
    const tenantId = links?.[0]?.tenant_id;
    if(tenantId){
      const { data } = await c.from('tenants').select('*').eq('id', tenantId).limit(1);
      if(data?.[0]) return data[0];
    }
  }catch{}

  if(user.email){
    const { data } = await c.from('tenants').select('*').eq('owner_email', user.email).limit(1);
    if(data?.[0]) return data[0];
  }
  return null;
}

