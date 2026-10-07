/**
 * POST /api/auth/google/finalize
 * Authorization: Bearer <access_token>
 *
 * After a first-time Google OAuth sign-in, the user has a Supabase identity
 * but no workspace. This provisions one (tenant + owner membership + onboarding
 * row). Idempotent: if the user already maps to a tenant it is returned
 * unchanged, so a retried OAuth callback can never mint a duplicate salon.
 */
import { getUserFromToken, bearer } from '../../lib/auth.js';
import { resolveTenantForUser } from '../../lib/tenant-access.js';
import { provisionTenantForUser } from '../../lib/db.js';
import { autoAssignOwnedNumber } from '../../lib/telnyx-provision.js';

// Same hard cap as the email path: instant Telnyx wiring must never slow
// down or break workspace creation.
const AUTO_ASSIGN_CAP_MS = 6000;
function withCap(promise){
  let timer;
  const cap = new Promise(r => { timer = setTimeout(() => r({ assigned:false, reason:'timeout' }), AUTO_ASSIGN_CAP_MS); });
  // clearTimeout on either outcome so a won race doesn't hold the event loop
  return Promise.race([promise, cap]).finally(() => clearTimeout(timer));
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if(req.method === 'OPTIONS') return res.status(204).end();
  if(req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try{
    const user = await getUserFromToken(bearer(req));
    if(!user) return res.status(401).json({ error: 'not authenticated' });

    const existing = await resolveTenantForUser(user);
    if(existing?.id) return res.status(200).json({ tenant: existing, created: false });

    const tenant = await provisionTenantForUser(user, {});
    if(!tenant) return res.status(500).json({ error: 'Could not provision workspace' });

    // One free trial per salon (same rule as email sign-up); a repeat salon gets an account, no new trial, no number.
    let trial = { trial: true };
    try{
      const { db } = await import('../../lib/db.js');
      const { trialCheck, endTrial } = await import('../../lib/trial-guard.js');
      const c = db();
      if(c){
        const dup = await trialCheck(c, tenant, { excludeId: tenant.id });
        if(dup?.duplicate){ await endTrial(c, tenant, dup.reason); trial = { trial: false, reason: dup.reason }; }
      }
    }catch(_){}
    const auto = trial.trial ? await withCap(autoAssignOwnedNumber(tenant)) : null;

    return res.status(200).json({
      tenant: { ...tenant, phone_number: auto?.assigned ? auto.phoneNumber : tenant.phone_number },
      created: true,
      autoProvisioned: auto,
      trial: trial.trial,
      ...(trial.trial ? {} : { trial_used: true, message: 'Welcome back! This salon has already used its free LolaDesk trial, so your account is ready but the trial won’t restart. Pick a plan in Billing to turn Lola on.' })
    });
  }catch(e){
    return res.status(500).json({ error: String(e && e.message || e) });
  }
}
