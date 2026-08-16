/**
 * GET /api/settings  (Authorization: Bearer <access_token>) → { tenant }
 * POST /api/settings (Authorization: Bearer <access_token>) → { tenant }
 * { name?, owner_name?, location?, hours?, booking_url?, website_url?, knowledge? }
 * Updates the AUTHENTICATED owner's own tenant only — never accepts
 * a tenant id/slug from the client, so there's no way to edit someone
 * else's salon by guessing an id. Returns { tenant } on success.
 */
import { getUserFromToken, bearer } from './lib/auth.js';
import { db, updateTenantFields } from './lib/db.js';
import { resolveTenantForUser } from './lib/tenant-access.js';

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  if(req.method === 'OPTIONS') return res.status(200).end();

  try{
    const user = await getUserFromToken(bearer(req));
    if(!user) return res.status(401).json({ error:'not authenticated' });

    const c = db();
    if(!c) return res.status(503).json({ error:'database not configured' });
    const tenant = await resolveTenantForUser(user);
    if(!tenant) return res.status(404).json({ error:'no tenant found for this account' });

    // GET — the Settings page loads with this (it used to 405 and render blank).
    if(req.method === 'GET'){
      // Never expose the operator PIN hash back to the browser.
      const { operator_pin_hash, ...safe } = tenant;
      return res.status(200).json({ ok:true, tenant: safe, settings: {} });
    }

    if(req.method !== 'POST') return res.status(405).json({ error:'POST only' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body||'{}') : (req.body||{});
    // Only forward known-safe fields — updateTenantFields also allow-lists,
    // but being explicit here means a typo'd extra field in the client
    // can't silently slip through as a no-op instead of an error.
    const patch = {};
    for(const k of ['name','owner_name','location','hours','booking_url','website_url','voice_id','knowledge']){
      if(body[k] !== undefined) patch[k] = body[k];
    }
    if(Object.keys(patch).length === 0) return res.status(400).json({ error:'no fields to update' });

    const updated = await updateTenantFields(tenant.id, patch);
    return res.status(200).json({ ok:true, tenant: updated });
  }catch(e){
    return res.status(500).json({ error:String(e&&e.message||e) });
  }
}
