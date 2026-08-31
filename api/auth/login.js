import { signIn } from '../lib/auth.js';
import { db } from '../lib/db.js';
import { resolveTenantForUser } from '../lib/tenant-access.js';
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
