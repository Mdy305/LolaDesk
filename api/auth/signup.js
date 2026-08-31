/**
 * POST /api/auth/signup
 * { email, password, name, salonName, location, hours, plan, websiteUrl }
 * Creates the auth user + a tenant + starts a 14-day trial.
 * Returns { session, tenant }.
 */
import { createUser } from '../lib/auth.js';
import { provisionTenantForUser } from '../lib/db.js';

// Auto-assignment must never slow down or break signup. Cap it at 6s (the
// parallel Telnyx links usually finish in ~2s, but cold starts need margin);
// on timeout the tenant simply keeps no number and can wire one in the wizard.
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
    // Create the workspace immediately so the confirmation link has a tenant to
    // activate, but leave it PENDING — no session, no live number — until the
    // owner confirms their email. That closes the open-signup surface: a random
    // address can't log in or burn a Telnyx number. Activation + number
    // auto-assign happen on the owner's first confirmed login (/api/auth/login).
    const tenant = await withBudget(provisionTenantForUser(user, {
      name, salonName, location, hours, plan, websiteUrl, businessMode,
      activationStatus: 'pending_email'
    }), 'workspace');
    if(!tenant) return res.status(500).json({ error: 'Could not create workspace' });

    return res.status(200).json({
      ok: true,
      requires_email_confirmation: true,
      email,
      detail: `We emailed a confirmation link to ${email} — click it to activate your salon, then sign in.`,
      tenant: { slug: tenant.slug }
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
