/**
 * POST /api/auth/signup
 * { email, password, name, salonName, location, hours, plan, websiteUrl }
 * Creates the auth user + a tenant + starts a 14-day trial.
 * Returns { session, tenant }.
 */
import { createUser } from '../lib/auth.js';
import { provisionTenantForUser, db } from '../lib/db.js';
import { TERMS_VERSION, acceptanceFrom, recordAcceptance } from '../lib/legal.js';
import { confirmationRequired, createConfirmedUser, signInLettingStuckOwnersIn, allowSignup } from '../lib/auth-direct.js';
import { resolveTenantForUser } from '../lib/tenant-access.js';

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
    // Clickwrap: no account without an affirmative "I agree" to the Terms,
    // Privacy Policy, AUP, Messaging Terms and DPA — recorded with version,
    // time, IP and browser so it can be proven later.
    if(b.accept_terms !== true) return res.status(400).json({ error:'Please agree to the Terms of Service and Privacy Policy to continue.', code:'terms_required' });
    const acceptance = acceptanceFrom(req, { email, version: b.terms_version });

    // ── Instant sign-up (default): the salon is in right away — see lib/auth-direct.js for why. ──
    if(!confirmationRequired()){
      const ip = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
      if(!allowSignup(ip)) return res.status(429).json({ error: 'Too many sign-ups from this connection — try again in an hour.', code: 'rate_limited' });
      const cleanEmail = String(email).trim().toLowerCase();
      let user = null, existing = false;
      try{
        user = await withBudget(createConfirmedUser({ email: cleanEmail, password, name, meta: { terms_version: acceptance.terms_version, terms_accepted_at: acceptance.accepted_at, terms_accepted_ip: acceptance.ip } }), 'create-user');
      }catch(e){
        if(e?.code !== 'already_registered') throw e;
        existing = true;
      }
      // Sign in now (an existing owner who re-did sign-up with their password just gets in).
      let sess;
      try{ sess = await withBudget(signInLettingStuckOwnersIn({ email: cleanEmail, password }), 'sign-in'); }
      catch(e){
        if(existing) return res.status(409).json({ error: 'This email already has a LolaDesk account. Sign in instead (or reset your password).', code: 'already_registered' });
        throw e;
      }
      user = sess.user || user;
      let tenant = existing ? await resolveTenantForUser(user).catch(() => null) : null;
      if(!tenant){
        tenant = await withBudget(provisionTenantForUser(user, { name, salonName, location, hours, plan, websiteUrl, businessMode, activationStatus: 'active' }), 'workspace');
        if(!tenant) return res.status(500).json({ error: 'Could not create workspace' });
      }
      // A workspace left "pending email" by the old flow goes live now.
      try{ const { activateTenant } = await import('../lib/db.js'); if(tenant.activation_status === 'pending_email') await activateTenant(db(), tenant); }catch(_){}
      await recordAcceptance(db(), { ...acceptance, user_id: user.id, tenant_id: tenant.id });
      // Lola's number from the numbers LolaDesk already owns, if one is free (never blocks sign-up).
      let autoProvisioned = null;
      if(!tenant.phone_number){
        try{
          const { autoAssignOwnedNumber } = await import('../lib/telnyx-provision.js');
          autoProvisioned = await Promise.race([autoAssignOwnedNumber(tenant), new Promise(r => setTimeout(() => r(null), 6000))]);
        }catch(_){ autoProvisioned = null; }
      }
      return res.status(200).json({
        ok: true, existing,
        token: sess.session?.access_token || '',
        session: sess.session,
        user: { id: user.id, email: user.email },
        tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name },
        autoProvisioned: autoProvisioned && autoProvisioned.assigned ? { assigned: true, phoneNumber: autoProvisioned.phoneNumber } : null
      });
    }

    const user = await withBudget(createUser({ email, password, name, meta: { terms_version: acceptance.terms_version, terms_accepted_at: acceptance.accepted_at, terms_accepted_ip: acceptance.ip } }), 'create-user');
    // Supabase answers a sign-up for an email that is ALREADY registered with
    // a fake user (no identities) and no error. Creating a workspace for it
    // made duplicate salons and told the owner to "check email" that never came.
    if(Array.isArray(user?.identities) && user.identities.length === 0){
      return res.status(409).json({ error: 'This email already has a LolaDesk account. Sign in instead.', code: 'already_registered' });
    }
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
    await recordAcceptance(db(), { ...acceptance, user_id: user.id, tenant_id: tenant.id });

    return res.status(200).json({
      ok: true,
      requires_email_confirmation: true,
      // Truthful signal from Supabase: confirmation_sent_at is set the moment
      // the mailer dispatches the link, so the page can tell "on its way in
      // 5 minutes — check spam" from "resend". Never a session at signup: the
      // pending tenant only becomes live on the owner's first confirmed login.
      email_dispatched: !!(user.confirmation_sent_at),
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
