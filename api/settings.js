/**
 * POST /api/settings  (Authorization: Bearer <access_token>)
 * { name?, location?, hours?, booking_url?, persona? }
 * Updates the AUTHENTICATED owner's own tenant only — never accepts
 * a tenant id/slug from the client, so there's no way to edit someone
 * else's salon by guessing an id. Returns { tenant } on success.
 */
import { getUserFromToken, bearer } from './lib/auth.js';
import { db, updateTenantFields } from './lib/db.js';

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  if(req.method === 'OPTIONS') return res.status(200).end();
  if(req.method !== 'POST') return res.status(405).json({ error:'POST only' });

  try{
    const user = await getUserFromToken(bearer(req));
    if(!user) return res.status(401).json({ error:'not authenticated' });

    const c = db();
    if(!c) return res.status(503).json({ error:'database not configured' });
    const { data: rows } = await c.from('tenants').select('id').eq('owner_email', user.email).limit(1);
    const tenant = rows && rows[0];
    if(!tenant) return res.status(404).json({ error:'no tenant found for this account' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body||'{}') : (req.body||{});
    // Only forward known-safe fields — updateTenantFields also allow-lists,
    // but being explicit here means a typo'd extra field in the client
    // can't silently slip through as a no-op instead of an error.
    const patch = {};
    for(const k of ['name','location','hours','booking_url','knowledge']){
      if(body[k] !== undefined) patch[k] = body[k];
    }
    if(Object.keys(patch).length === 0) return res.status(400).json({ error:'no fields to update' });

    const updated = await updateTenantFields(tenant.id, patch);
    return res.status(200).json({ ok:true, tenant: updated });
  }catch(e){
    return res.status(500).json({ error:String(e&&e.message||e) });
  }
}
