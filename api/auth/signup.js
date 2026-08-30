/**
 * POST /api/auth/signup
 * { email, password, name, salonName, location, hours, plan, websiteUrl }
 * Creates the auth user + a tenant + starts a 14-day trial.
 * Returns { session, tenant }.
 */
import { createUser, signIn } from '../lib/auth.js';
import { provisionTenantForUser } from '../lib/db.js';
import { autoAssignOwnedNumber } from '../lib/telnyx-provision.js';

// Auto-assignment must never slow down or break signup. Cap it at 6s (the
// parallel Telnyx links usually finish in ~2s, but cold starts need margin);
// on timeout the tenant simply keeps no number and can wire one in the wizard.
const AUTO_ASSIGN_CAP_MS = 6000;
function withCap(promise){
  let timer;
  const cap = new Promise(r => { timer = setTimeout(() => r({ assigned:false, reason:'timeout' }), AUTO_ASSIGN_CAP_MS); });
  // clearTimeout on either outcome so a won race doesn't hold the event loop
  return Promise.race([promise, cap]).finally(() => clearTimeout(timer));
}

// Signup must never burn the serverless invocation budget on a hanging
// upstream (e.g. Supabase Auth). Each critical step is time-bound; if it
// can't finish in time the promise rejects with a recognizable error instead
// of the whole handler stalling to FUNCTION_INVOCATION_TIMEOUT. This makes
// the failure fast and loud — it does not fabricate a success.
export const AUTH_TIMEOUT_CODE = 'SIGNUP_AUTH_TIMEOUT';
export const SIGNUP_STEP_BUDGET_MS = 10000;
export function withBudget(promise, label){
  let timer;
  const cap = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error('Signup step timed out: ' + label);
      e.code = AUTH_TIMEOUT_CODE;
      reject(e);
    }, SIGNUP_STEP_BUDGET_MS);
  });
  return Promise.race([promise, cap]).finally(() => clearTimeout(timer));
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

    const user = await withBudget(createUser({ email, password, name }), 'create-user');
    const tenant = await withBudget(provisionTenantForUser(user, {
      name, salonName, location, hours, plan, websiteUrl, businessMode
    }), 'workspace');
    if(!tenant) return res.status(500).json({ error: 'Could not create workspace' });

    const sess = await withBudget(signIn({ email, password }), 'sign-in');

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
    if(e?.code === AUTH_TIMEOUT_CODE){
      // The auth provider (Supabase Auth) isn't responding. Fail fast and
      // loud instead of stalling to the serverless timeout — the owner can
      // see this on the dashboard as a 503, not a frozen 60s page.
      return res.status(503).json({
        ok:false, code:'auth_unavailable',
        error: "We couldn't reach the sign-in service. Please try again in a moment.",
        detail: String(e.message || e)
      });
    }
    const msg = String(e&&e.message||e);
    const code = /already registered|exists/i.test(msg) ? 409 : 500;
    return res.status(code).json({ error: msg });
  }
}
