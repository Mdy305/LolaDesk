import { db } from './db.js';

function normalizeRole(value, fallback='staff'){
  const role=String(value||fallback).trim().toLowerCase().replace(/[^a-z0-9_-]/g,'');
  return role||fallback;
}

// Several tenants can point at one login (duplicate sign-ups). Always pick the
// same one: the live salon (has a Lola number, active) first, then the oldest.
function rankTenants(rows){
  const score=t=>(t.phone_number?4:0)+(String(t.activation_status||'active')==='active'?2:0)+(String(t.subscription_status||'')==='active'?1:0);
  return (rows||[]).slice().sort((a,b)=>score(b)-score(a) || String(a.created_at||'').localeCompare(String(b.created_at||'')));
}

export async function resolveTenantAccessForUser(user){
  const c=db();
  if(!c||!user?.id) return null;

  try{
    const { data:links }=await c
      .from('tenant_users')
      .select('tenant_id,role')
      .eq('user_id',user.id)
      .limit(25);
    const ids=[...new Set((links||[]).map(l=>l.tenant_id).filter(Boolean))];
    if(ids.length){
      const { data }=await c.from('tenants').select('*').in('id',ids);
      const pick=rankTenants(data)[0];
      if(pick){
        const link=(links||[]).find(l=>l.tenant_id===pick.id);
        return {tenant:pick,role:normalizeRole(link?.role)};
      }
    }
  }catch{}

  if(user.email){
    // Case-insensitive but EXACT: LIKE wildcards (% _) and backslashes in the email are escaped, and
    // every hit is re-checked in code — "a_b@x.com" or "%@x.com" can never match another salon's owner.
    const email=String(user.email).trim().toLowerCase();
    if(!email) return null;
    const pattern=email.replace(/[\\%_]/g,(m)=>'\\'+m);
    const { data }=await c.from('tenants').select('*').ilike('owner_email',pattern).limit(25);
    let exact=(data||[]).filter(t=>String(t.owner_email||'').trim().toLowerCase()===email);
    if(!exact.length){
      const raw=String(user.email).trim();
      const { data:eq }=await c.from('tenants').select('*').in('owner_email',[...new Set([email,raw])]).limit(25);
      exact=(eq||[]).filter(t=>String(t.owner_email||'').trim().toLowerCase()===email);
    }
    const pick=rankTenants(exact)[0];
    if(pick) return {tenant:pick,role:'owner'};
  }
  return null;
}

export async function resolveTenantForUser(user){
  const access=await resolveTenantAccessForUser(user);
  return access?.tenant||null;
}
