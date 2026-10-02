/**
 * api/lib/auth-direct.js — new salons get in instantly, without depending on Supabase's mailer.
 * ════════════════════════════════════════════════════════════════════════════════════════
 * Why: sign-up used to create an UNCONFIRMED account and wait for Supabase's confirmation email.
 * Supabase's built-in mailer only delivers to the project's own team addresses (and a few emails
 * an hour) unless a custom SMTP server is configured — so a real new salon never got the link and
 * could never sign in. Now the account is created confirmed (service-role Auth API), the owner
 * gets a session on the spot, and anyone already stuck "unconfirmed" is let in on their next
 * sign-in with the right password.
 *
 *   REQUIRE_EMAIL_CONFIRMATION=1   restores the old email-link gate (only once custom SMTP is set
 *                                  up in Supabase → Authentication → Emails → SMTP).
 *
 * Plain REST against Supabase Auth (GoTrue) with the service key: no SDK quirks, easy to test.
 */
const base = () => String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const key = () => process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const H = () => ({ apikey: key(), Authorization: 'Bearer ' + key(), 'Content-Type': 'application/json' });

export const confirmationRequired = () => process.env.REQUIRE_EMAIL_CONFIRMATION === '1';

async function call(path, { method = 'GET', body, timeoutMs = 9000 } = {}) {
  if (!base() || !key()) { const e = new Error('Auth not configured'); e.status = 500; throw e; }
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(base() + '/auth/v1' + path, { method, headers: H(), body: body ? JSON.stringify(body) : undefined, signal: ac.signal });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error(j.msg || j.message || j.error_description || j.error || `Auth error ${r.status}`);
      e.status = r.status; e.code = j.error_code || j.code || null; throw e;
    }
    return j;
  } finally { clearTimeout(t); }
}

const already = (e) => e && (Number(e.status) === 422 || /already (been )?registered|already exists|email_exists|user_already_exists/i.test(String(e.message) + ' ' + String(e.code)));

/** Create a confirmed user. Throws {code:'already_registered'} when the email exists. */
export async function createConfirmedUser({ email, password, name, meta = {} }) {
  try {
    const u = await call('/admin/users', { method: 'POST', body: { email, password, email_confirm: true, user_metadata: { name, ...meta } } });
    return u.user || u;
  } catch (e) {
    if (already(e)) { const x = new Error('already registered'); x.code = 'already_registered'; throw x; }
    throw e;
  }
}

/** Email + password → { user, session } (same shape the SDK returns). Throws on a wrong password. */
export async function passwordSignIn({ email, password }) {
  const r = await fetch(base() + '/auth/v1/token?grant_type=password', { method: 'POST', headers: H(), body: JSON.stringify({ email, password }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.msg || j.error_description || j.message || 'Invalid login credentials'); e.status = r.status; e.code = j.error_code || j.error || null; throw e; }
  const session = { access_token: j.access_token, refresh_token: j.refresh_token, expires_in: j.expires_in, expires_at: j.expires_at, token_type: j.token_type || 'bearer', user: j.user };
  return { user: j.user, session };
}

export async function findUserByEmail(email) {
  const want = String(email || '').trim().toLowerCase();
  for (let page = 1; page <= 20; page++) {
    const j = await call(`/admin/users?page=${page}&per_page=1000`);
    const users = j.users || [];
    const hit = users.find((u) => String(u.email || '').toLowerCase() === want);
    if (hit) return hit;
    if (users.length < 1000) return null;
  }
  return null;
}

/** An owner stuck "unconfirmed" (the email never came): confirm them. The caller then re-checks the password. */
export async function confirmIfPending(email) {
  const u = await findUserByEmail(email);
  if (!u) return false;
  if (u.email_confirmed_at || u.confirmed_at) return true;
  await call('/admin/users/' + encodeURIComponent(u.id), { method: 'PUT', body: { email_confirm: true } });
  return true;
}

/** Sign in; if the only problem is "email not confirmed" (and the gate is off), confirm and retry once. */
export async function signInLettingStuckOwnersIn({ email, password }) {
  try { return await passwordSignIn({ email, password }); }
  catch (e) {
    if (confirmationRequired() || !/not confirmed|email_not_confirmed/i.test(String(e.message) + ' ' + String(e.code))) throw e;
    if (!(await confirmIfPending(email))) throw e;
    return passwordSignIn({ email, password });
  }
}

// A cheap brake on mass sign-ups from one address (instance-local, like voice-guard).
const hits = new Map();
export function allowSignup(ip, { perHour = 6 } = {}) {
  try {
    const now = Date.now(), k = String(ip || 'unknown');
    const list = (hits.get(k) || []).filter((t) => now - t < 3600e3);
    if (list.length >= perHour) { hits.set(k, list); return false; }
    list.push(now); hits.set(k, list);
    if (hits.size > 5000) for (const [a, v] of hits) if (!v.length || now - v[v.length - 1] > 3600e3) hits.delete(a);
    return true;
  } catch (_) { return true; }
}
