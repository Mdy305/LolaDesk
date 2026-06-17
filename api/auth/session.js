/**
 * GET /api/auth/session  (Authorization: Bearer <access_token>)
 * Returns { user, tenant } or 401.
 */
import { getUserFromToken, bearer } from '../lib/auth.js';
import { db } from '../lib/db.js';

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  if(req.method==='OPTIONS') return res.status(200).end();
  try{
    const token = bearer(req);
    const user = await getUserFromToken(token);
    if(!user) return res.status(401).json({ error:'not authenticated' });
    let tenant = null;
    const c = db();
    if(c){ const { data } = await c.from('tenants').select('*').eq('owner_email', user.email).limit(1); tenant = data&&data[0]||null; }
    return res.status(200).json({ user, tenant });
  }catch(e){ return res.status(401).json({ error:String(e&&e.message||e) }); }
}
