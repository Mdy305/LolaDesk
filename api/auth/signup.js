/**
 * POST /api/auth/signup
 * Creates the auth user, tenant, tenant ownership link and onboarding state.
 */
import { createUser, signIn } from '../lib/auth.js';
import { upsertTenant, db } from '../lib/db.js';

function slugify(value){
  return (value || 'salon').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,40);
}

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method === 'OPTIONS') return res.status(200).end();
  if(req.method !== 'POST') return res.status(405).json({error:'POST only'});

  try{
    const body=typeof req.body==='string'?JSON.parse(req.body||'{}'):(req.body||{});
    const {email,password,name,salonName,location,hours,plan,websiteUrl,businessMode}=body;
    if(!email||!password) return res.status(400).json({error:'email and password required'});
    if(password.length<8) return res.status(400).json({error:'password must be at least 8 characters'});

    const user=await createUser({email,password,name});
    const trialEnds=new Date(Date.now()+14*24*3600*1000).toISOString();
    const slug=slugify(salonName||name||email.split('@')[0])+'-'+Math.random().toString(36).slice(2,6);
    const tenant=await upsertTenant({
      slug,
      name:salonName||'My Salon',
      owner_name:name,
      owner_email:email,
      location:location||'',
      hours:hours||'',
      plan:plan||'starter',
      website_url:websiteUrl||'',
      business_mode:businessMode||'salon',
      trial_ends_at:trialEnds
    });
    if(!tenant?.id) throw new Error('tenant creation returned no record');

    const client=db();
    if(client&&user?.id){
      const linked=await client.from('tenant_users').upsert({tenant_id:tenant.id,user_id:user.id,role:'owner'},{onConflict:'tenant_id,user_id'});
      if(linked.error) throw linked.error;

      const onboarding=await client.from('tenant_onboarding').upsert({
        tenant_id:tenant.id,
        stage:'business',
        status:'in_progress',
        progress:10,
        business:{name:tenant.name,location:tenant.location||'',website_url:tenant.website_url||'',business_mode:tenant.business_mode||'salon'},
        booking:{},
        channels:{},
        persona:{persona:tenant.persona||'warm'},
        provisioning:{}
      },{onConflict:'tenant_id'});
      if(onboarding.error&&!/tenant_onboarding/i.test(onboarding.error.message||'')) throw onboarding.error;
    }

    const session=await signIn({email,password});
    return res.status(200).json({session:session.session,user:session.user,tenant});
  }catch(error){
    const message=String(error?.message||error);
    console.error('[SIGNUP]',message);
    return res.status(/already registered|exists/i.test(message)?409:500).json({error:message});
  }
}
