// POST /api/auth/signup { email, password, name, salonName, plan? }
// Creates the Supabase Auth user, the tenant row, the tenant_users link,
// seeds billing_policies + booking_settings defaults, and returns a session
// token the onboarding flow uses for subsequent authenticated calls.
import { cors, jsonBody } from '../lib/cors.js';
import { db } from '../lib/db.js';

function slugify(s) {
  return String(s || '').toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 40) || 'salon-' + Math.random().toString(36).slice(2, 8);
}

async function ensureUniqueSlug(c, base) {
  let slug = base, i = 1;
  while (i < 20) {
    const { data } = await c.from('tenants').select('id').eq('slug', slug).maybeSingle();
    if (!data) return slug;
    i++;
    slug = base + '-' + i;
  }
  return base + '-' + Math.random().toString(36).slice(2, 6);
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

  const c = db();
  try {
    const { email, password, name, salonName, plan } = jsonBody(req);
    if (!email || !password) return res.status(400).json({ ok: false, error: 'missing_email_or_password' });
    if (String(password).length < 8) return res.status(400).json({ ok: false, error: 'password_too_short' });

    // 1. Create the auth user with the Supabase admin client.
    const { data: userRes, error: userErr } = await c.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { name: name || salonName || null }
    });
    if (userErr) {
      const msg = userErr.message || String(userErr);
      return res.status(400).json({ ok: false, error: msg });
    }
    const user = userRes.user;

    // 2. Create the tenant.
    const baseSlug = slugify(salonName || name || email.split('@')[0]);
    const slug = await ensureUniqueSlug(c, baseSlug);

    const { data: tenant, error: tenantErr } = await c.from('tenants').insert({
      name: salonName || name || 'My Salon',
      slug,
      plan: plan || 'trial',
      timezone: 'America/New_York',
      created_by: user.id,
      setup_step: 'name_set'
    }).select().single();
    if (tenantErr) throw tenantErr;

    // 3. Link user ↔ tenant.
    await c.from('tenant_users').insert({
      tenant_id: tenant.id,
      user_id: user.id,
      role: 'owner'
    });

    // 4. Seed default policies + booking settings.
    await Promise.all([
      c.from('billing_policies').insert({ tenant_id: tenant.id }).select(),
      c.from('booking_settings').insert({ tenant_id: tenant.id }).select()
    ]);

    // 5. Sign the user in to get a session token for the wizard's next calls.
    const { data: session, error: signInErr } = await c.auth.signInWithPassword({ email, password });
    if (signInErr) {
      // User was created but sign-in failed — client can just navigate to login.
      return res.json({ ok: true, tenant: { id: tenant.id, slug }, token: null, needs_login: true });
    }

    return res.json({
      ok: true,
      tenant: { id: tenant.id, slug, name: tenant.name },
      user: { id: user.id, email: user.email },
      token: session?.session?.access_token || null
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
