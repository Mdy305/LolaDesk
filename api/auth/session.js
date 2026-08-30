/**
 * GET /api/auth/session  (Authorization: Bearer <access_token>)
 * Returns authenticated user, tenant and tenant membership role.
 */
import { getUserFromToken, bearer } from '../lib/auth.js';
import { resolveTenantAccessForUser } from '../lib/tenant-access.js';

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  if(req.method==='OPTIONS') return res.status(200).end();
  try{
    const token=bearer(req);
    const user=await getUserFromToken(token);
    if(!user) return res.status(401).json({error:'not authenticated'});
    const access=await resolveTenantAccessForUser(user);
    return res.status(200).json({
      user,
      tenant:access?.tenant||null,
      role:access?.role||null,
      onboarding_required:!access?.tenant
    });
  }catch(e){return res.status(401).json({error:String(e&&e.message||e)});}
}
