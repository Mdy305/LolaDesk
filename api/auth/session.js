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
    if(!tenant){
      tenant = {
        id: 'demo-tenant-id',
        slug: 'mma',
        name: 'MMΛ Salon',
        owner_name: 'Meddy',
        owner_email: 'meddy@mmasalon.com',
        phone_number: '+19294568227',
        plan: 'pro',
        services: [
          {name: 'Balayage', price: 395, duration: '2h30'},
          {name: 'Extensions', price: 800, duration: 'consult'},
          {name: 'Hair Botox', price: 325, duration: '2h'},
          {name: 'Keratin', price: 450, duration: '2h30'},
          {name: 'Cut & Gloss', price: 225, duration: '1h15'},
          {name: 'Blowout', price: 95, duration: '1h'}
        ],
        team: [
          {name: 'Meddy', role: 'Owner · Master Colorist'},
          {name: 'Michelle', role: 'Senior Stylist'},
          {name: 'Alice', role: 'Senior Stylist'},
          {name: 'Samantha', role: 'Stylist'}
        ]
      };
    }
    return res.status(200).json({ user, tenant });
  }catch(e){ return res.status(401).json({ error:String(e&&e.message||e) }); }
}
