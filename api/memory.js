import { bearer, getUserFromToken } from './lib/auth.js';
import { db, e164, logUsage } from './lib/db.js';
import { resolveTenantForUser } from './lib/tenant-access.js';

const ALLOWED_SCOPES = new Set(['owner','client']);
const MAX_VALUE_BYTES = 12000;

function cleanKey(value){
  return String(value || '').trim().replace(/[^a-zA-Z0-9:_-]/g, '_').slice(0, 80);
}
function cleanIdentity(scope, value){
  if(scope === 'owner') return 'owner';
  const raw = String(value || '').trim();
  if(!raw) return '';
  return raw.startsWith('web:') ? raw.slice(0, 64) : e164(raw);
}
function parseBody(req){
  if(typeof req.body === 'string') return JSON.parse(req.body || '{}');
  return req.body || {};
}
async function authenticate(req){
  const user = await getUserFromToken(bearer(req));
  if(!user) return { error: [401, 'not authenticated'] };
  const tenant = await resolveTenantForUser(user);
  if(!tenant) return { error: [404, 'no tenant found for this account'] };
  return { user, tenant };
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if(req.method === 'OPTIONS') return res.status(200).end();
  if(!['GET','PATCH','DELETE'].includes(req.method)) return res.status(405).json({ error:'method not allowed' });

  try{
    const auth = await authenticate(req);
    if(auth.error) return res.status(auth.error[0]).json({ error:auth.error[1] });
    const c = db();
    if(!c) return res.status(503).json({ error:'database not configured' });
    const tenantId = auth.tenant.id;

    if(req.method === 'GET'){
      const url = new URL(req.url, 'http://local');
      const scope = url.searchParams.get('scope') || 'all';
      const identity = url.searchParams.get('identity');
      let q = c.from('client_memories')
        .select('client_phone,key,value,created_at')
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending:false })
        .limit(500);
      if(scope === 'owner') q = q.eq('client_phone', 'owner');
      if(scope === 'client') q = q.neq('client_phone', 'owner');
      if(identity) q = q.eq('client_phone', cleanIdentity('client', identity));
      const { data, error } = await q;
      if(error) throw new Error(error.message);
      const memories = (data || []).map(row => ({
        scope: row.client_phone === 'owner' ? 'owner' : 'client',
        identity: row.client_phone,
        key: row.key,
        value: row.value,
        updated_at: row.created_at
      }));
      return res.status(200).json({ ok:true, memories, count:memories.length });
    }

    const body = parseBody(req);
    const scope = String(body.scope || 'owner').toLowerCase();
    if(!ALLOWED_SCOPES.has(scope)) return res.status(400).json({ error:'scope must be owner or client' });
    const identity = cleanIdentity(scope, body.identity);
    const key = cleanKey(body.key);
    if(!identity || !key) return res.status(400).json({ error:'identity and key are required' });

    if(req.method === 'PATCH'){
      const serialized = JSON.stringify(body.value ?? null);
      if(Buffer.byteLength(serialized, 'utf8') > MAX_VALUE_BYTES) return res.status(413).json({ error:'memory value too large' });
      const row = { tenant_id:tenantId, client_phone:identity, key, value:body.value ?? null, created_at:new Date().toISOString() };
      const { data, error } = await c.from('client_memories')
        .upsert(row, { onConflict:'tenant_id,client_phone,key' })
        .select('client_phone,key,value,created_at').maybeSingle();
      if(error) throw new Error(error.message);
      await logUsage(tenantId, 'memory_corrected', 1, { scope, identity, key }).catch(()=>{});
      return res.status(200).json({ ok:true, memory:data });
    }

    const { error } = await c.from('client_memories').delete()
      .eq('tenant_id', tenantId).eq('client_phone', identity).eq('key', key);
    if(error) throw new Error(error.message);
    await logUsage(tenantId, 'memory_deleted', 1, { scope, identity, key }).catch(()=>{});
    return res.status(200).json({ ok:true, deleted:{ scope, identity, key } });
  }catch(error){
    return res.status(500).json({ error:String(error?.message || error) });
  }
}
