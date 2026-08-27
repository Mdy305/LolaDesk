/**
 * POST /api/auth/signup
 * { email, password, name, salonName, location, hours, plan, websiteUrl }
 * Creates the auth user + a tenant + starts a 14-day trial.
 * Returns { session, tenant }.
 */
import { createUser, signIn } from '../lib/auth.js';
import { provisionTenantForUser } from '../lib/db.js';
import { autoAssignOwnedNumber } from '../lib/telnyx-provision.js';

// Auto-assignment must never slow down or break signup. Cap it at 4s; on
// timeout the tenant simply keeps no number and can wire one in the wizard.
const AUTO_ASSIGN_CAP_MS = 4000;
function withCap(promise){
  return Promise.race([
    promise,
    new Promise(r => setTimeout(() => r({ assigned:false, reason:'timeout' }), AUTO_ASSIGN_CAP_MS))
  ]);
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS') return res.status(200).end();
  if(req.method!=='POST') return res.status(405).json({ error:'POST only' });
  try{
    const b = typeof req.body==='string'?JSON.parse(req.body||'{}'):(req.body||{});
    const { email, password, name, salonName, location, hours, plan, websiteUrl, businessMode } = b;
    if(!email || !password) return res.status(400).json({ error:'email and password required' });
    if(password.length < 8) return res.status(400).json({ error:'password must be at least 8 characters' });

    const user = await createUser({ email, password, name });
    const tenant = await provisionTenantForUser(user, {
      name, salonName, location, hours, plan, websiteUrl, businessMode
    });
    if(!tenant) return res.status(500).json({ error: 'Could not create workspace' });

    const sess = await signIn({ email, password });

    // Instant Telnyx wiring: give this fresh tenant a live number from the
    // owned pool (voice + SMS + LolaBrain + routing row) with zero friction.
    // Best-effort only — the wizard remains the manual path.
    const auto = await withCap(autoAssignOwnedNumber(tenant));

    return res.status(200).json({
      session: sess.session, user: sess.user,
      tenant: { ...tenant, phone_number: auto?.assigned ? auto.phoneNumber : tenant.phone_number },
      autoProvisioned: auto
    });
  }catch(e){
    const msg = String(e&&e.message||e);
    const code = /already registered|exists/i.test(msg) ? 409 : 500;
    return res.status(code).json({ error: msg });
  }
}
