// A brand-new salon signs up and is IN — no waiting on an email Supabase never delivers;
// owners stuck "unconfirmed" get in with their password; duplicates and wrong passwords are refused.
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'svc'; delete process.env.TELNYX_API_KEY; delete process.env.REQUIRE_EMAIL_CONFIRMATION;
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const users = []; let n = 0;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url)), J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  const body = init.body ? JSON.parse(init.body) : {};
  if (u.pathname === '/auth/v1/admin/users' && init.method === 'POST') {
    if (users.some((x) => x.email === body.email)) return J({ code: 422, error_code: 'email_exists', msg: 'A user with this email address has already been registered' }, 422);
    const user = { id: 'u' + (++n), email: body.email, password: body.password, email_confirmed_at: body.email_confirm ? new Date().toISOString() : null, user_metadata: body.user_metadata };
    users.push(user); return J(user);
  }
  if (u.pathname === '/auth/v1/admin/users' && (init.method || 'GET') === 'GET') return J({ users });
  if (u.pathname.startsWith('/auth/v1/admin/users/') && init.method === 'PUT') { const x = users.find((y) => y.id === decodeURIComponent(u.pathname.split('/').pop())); if (body.email_confirm) x.email_confirmed_at = new Date().toISOString(); return J(x); }
  if (u.pathname === '/auth/v1/token') {
    const x = users.find((y) => y.email === body.email);
    if (!x || x.password !== body.password) return J({ error: 'invalid_grant', error_code: 'invalid_credentials', msg: 'Invalid login credentials' }, 400);
    if (!x.email_confirmed_at) return J({ error_code: 'email_not_confirmed', msg: 'Email not confirmed' }, 400);
    return J({ access_token: 'at_' + x.id + '_' + 'z'.repeat(24), refresh_token: 'rt_' + x.id, expires_in: 3600, token_type: 'bearer', user: { id: x.id, email: x.email } });
  }
  return J({ data: [] });
};
const { T } = await import('./fake-supabase.mjs');
T.tenants = []; T.tenant_users = []; T.legal_acceptances = []; T.tenant_numbers = []; T.tenant_onboarding = []; T.subscriptions = [];
const P = new URL('../../api/', import.meta.url).href;
const run = async (mod, body, ip = '1.1.1.1') => { const h = (await import(P + mod)).default; return new Promise((resolve) => { const res = { statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(o) { resolve({ status: this.statusCode, ...o }); }, end() { resolve({ status: this.statusCode }); } }; h({ method: 'POST', headers: { 'x-forwarded-for': ip }, query: {}, body }, res); }); };

let r = await run('auth/signup.js', { email: 'Jeje@Example.com', password: 'supersecret1', name: 'jeje salon', salonName: 'jeje salon', plan: 'starter', accept_terms: true, terms_version: '2026-10-01' });
ok(r.status === 200 && r.token && r.session?.refresh_token && !r.requires_email_confirmation, 'a new salon gets a session on the spot (no email to wait for)');
ok(r.tenant?.slug && T.tenants.some((t) => t.id === r.tenant.id && t.activation_status === 'active' && t.owner_email === 'jeje@example.com'), 'its workspace is created and live: ' + r.tenant?.slug);
ok(users[0].email_confirmed_at && T.legal_acceptances?.length >= 1, 'account confirmed, and the “I agree” recorded');
const login = await run('auth/login.js', { email: 'jeje@example.com', password: 'supersecret1' });
ok(login.status === 200 && login.session?.access_token && login.tenant?.id === r.tenant.id, 'and signs in again later to the same salon');

r = await run('auth/signup.js', { email: 'jeje@example.com', password: 'supersecret1', salonName: 'jeje salon', accept_terms: true });
ok(r.status === 200 && r.existing && r.tenant.id === T.tenants[0].id && T.tenants.length === 1, 'signing up again with the same email + password just signs in (no duplicate salon)');
r = await run('auth/signup.js', { email: 'jeje@example.com', password: 'wrongpass99', salonName: 'x', accept_terms: true });
ok(r.status === 409 && r.code === 'already_registered', 'same email, wrong password → “Sign in instead”');

// Owner stuck from the old flow: unconfirmed in Supabase, pending workspace.
users.push({ id: 'stuck', email: 'stuck@salon.com', password: 'mypassword1', email_confirmed_at: null });
T.tenants.push({ id: 'tstuck', slug: 'stuck-salon', name: 'Stuck Salon', owner_email: 'stuck@salon.com', activation_status: 'pending_email' });
T.tenant_users.push({ tenant_id: 'tstuck', user_id: 'stuck', role: 'owner', status: 'active' });
r = await run('auth/login.js', { email: 'stuck@salon.com', password: 'nope-nope' });
ok(r.status === 401 && !users.find((x) => x.id === 'stuck').email_confirmed_at, 'stuck owner, wrong password → refused');
r = await run('auth/login.js', { email: 'stuck@salon.com', password: 'mypassword1' });
ok(r.status === 200 && r.session?.access_token && T.tenants.find((t) => t.id === 'tstuck').activation_status === 'active', 'stuck owner (the email never came) signs in with the right password and the salon goes live');

r = await run('auth/signup.js', { email: 'x@y.com', password: 'short', accept_terms: true });
ok(r.status === 400, 'short password refused');
r = await run('auth/signup.js', { email: 'x@y.com', password: 'longenough1' });
ok(r.status === 400 && r.code === 'terms_required', 'no “I agree” → refused');
let last; for (let i = 0; i < 8; i++) last = await run('auth/signup.js', { email: `bulk${i}@spam.com`, password: 'longenough1', salonName: 's' + i, accept_terms: true }, '9.9.9.9');
ok(last.status === 429, 'mass sign-ups from one connection are braked');

process.env.REQUIRE_EMAIL_CONFIRMATION = '1';
const { confirmationRequired } = await import(P + 'lib/auth-direct.js');
ok(confirmationRequired(), 'REQUIRE_EMAIL_CONFIRMATION=1 brings the email-link gate back (for when custom SMTP is set up)');
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
