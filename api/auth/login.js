import { signIn } from '../lib/auth.js';
import { db, upsertTenant } from '../lib/db.js';

function slugify(s){
  return (s || 'salon').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,32);
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS') return res.status(200).end();
  if(req.method!=='POST') return res.status(405).json({ error:'POST only' });

  try{
    const b = typeof req.body==='string' ? JSON.parse(req.body||'{}') : (req.body||{});
    const { email, password } = b;
    if(!email || !password) return res.status(400).json({ error:'email and password required' });

    const sess = await signIn({ email, password });

    let tenant = null;
    const c = db();
    if(c){
      const { data } = await c.from('tenants').select('*').eq('owner_email', email).limit(1);
      tenant = (data && data[0]) || null;

      if(!tenant){
        const ownerName = sess.user?.user_metadata?.name || email.split('@')[0];
        tenant = await upsertTenant({
          slug: slugify(email.split('@')[0]) + '-' + Math.random().toString(36).slice(2,6),
          name: 'My Salon',
          owner_name: ownerName,
          owner_email: email,
          plan: 'starter',
        });
      }
    }

    return res.status(200).json({ session: sess.session, user: sess.user, tenant });
  }catch(e){
    return res.status(401).json({ error: String(e && e.message || e) });
  }
}
