import { signIn } from '../lib/auth.js';
import { db, activateTenant } from '../lib/db.js';
import { resolveTenantForUser } from '../lib/tenant-access.js';
import { autoAssignOwnedNumber } from '../lib/telnyx-provision.js';
import { mfaRequiredFor, createChallenge, CHALLENGE_TTL_MS } from '../lib/mfa.js';

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
      tenant = await resolveTenantForUser(sess.user);
      if(!tenant){
        const { data } = await c.from('tenants').select('*').eq('owner_email', email).limit(1);
        tenant = (data && data[0]) || null;
      }
    }

    // Email verification → activation. signIn() already guarantees this owner
    // confirmed their email (Supabase blocks sign-in for unconfirmed users), so a
    // pending_email tenant created at signup can be flipped active here and, if it
    // has no number yet, auto-wired from the owned pool — the "Live in 60"
    // promise, now gated on a real human instead of any random address. Best-effort
    // so a provisioning hiccup never fails a successful login.
    if(c && tenant?.id){
      try{
        const act = await activateTenant(c, tenant);
        if(act && act.activated && !tenant.phone_number){
          const auto = await autoAssignOwnedNumber(tenant);
          if(auto?.assigned && auto.phoneNumber) tenant = { ...tenant, phone_number: auto.phoneNumber };
        }
      }catch(ae){ /* never block a successful login */ }
    }

    // Commercial hardening: if this owner has a verified second factor, do NOT
    // hand back a working session yet — return a challenge to be exchanged via
    // /api/auth/mfa {action:'verify', code} for the session. Owners who have not
    // enrolled sign in exactly as before (end-user signup is untouched).
    if(await mfaRequiredFor(sess.user.email, c)){
      const mfa_challenge = createChallenge({
        session: sess.session,
        user: sess.user,
        tenant: tenant || null,
        onboarding_required: !tenant
      });
      return res.status(200).json({
        ok: true,
        mfa_required: true,
        mfa_challenge,
        user: sess.user,
        expires_in_ms: CHALLENGE_TTL_MS
      });
    }

    return res.status(200).json({
      session: sess.session,
      user: sess.user,
      tenant: tenant || null,
      onboarding_required: !tenant
    });
  }catch(e){
    return res.status(401).json({ error: String(e && e.message || e) });
  }
}
