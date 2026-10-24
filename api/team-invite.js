/**
 * /api/team-invite — let the owner give their team a sign-in.
 * ════════════════════════════════════════════════════════════════════
 *   GET                         → { members:[{ user_id, email, role, you }] }
 *   POST   { email, role, name, phone? }
 *                               → invites (or re-sends to) one person
 *   DELETE ?user_id=…           → removes their access to this salon
 *
 * Owner only (lib/team-access.js). The person gets an email (and a text if
 * a phone is given) with a one-time link to set their password; signing in
 * lands them in this salon with their role. An email that already belongs
 * to another salon is refused rather than silently moved.
 */
import { admin } from './lib/auth.js';
import { db } from './lib/db.js';
import { findUserByEmail, createConfirmedUser } from './lib/auth-direct.js';
import { requireRole, OWNER, INVITABLE } from './lib/team-access.js';
import { sendSms } from './lib/sms.js';
import crypto from 'node:crypto';

const appUrl = () => String(process.env.APP_URL || 'https://www.loladesk.com').replace(/\/+$/, '');
const esc = (s) => String(s || '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const ROLE_WORD = { staff: 'Team member', manager: 'Manager', owner: 'Owner', admin: 'Owner' };

export async function setPasswordLink(a, email) {
  const { data, error } = await a.auth.admin.generateLink({ type: 'recovery', email, options: { redirectTo: appUrl() + '/reset' } });
  if (error) throw error;
  return data?.properties?.action_link || data?.action_link || '';
}

async function members(c, a, tenant, me) {
  const { data } = await c.from('tenant_users').select('user_id,role,created_at').eq('tenant_id', tenant.id).limit(100);
  const rows = await Promise.all((data || []).map(async (r) => {
    let email = '';
    try { const u = await a.auth.admin.getUserById(r.user_id); email = u?.data?.user?.email || ''; } catch (_) {}
    const owner = email && email.toLowerCase() === String(tenant.owner_email || '').toLowerCase();
    const role = owner ? 'owner' : String(r.role || 'staff');
    return { user_id: r.user_id, email, role, role_label: ROLE_WORD[role] || 'Team member', you: r.user_id === me.id, since: r.created_at };
  }));
  return rows.sort((x, y) => (x.role === 'owner' ? -1 : y.role === 'owner' ? 1 : String(x.email).localeCompare(String(y.email))));
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const ok = await requireRole(req, res, OWNER);
  if (!ok) return;
  const { user, tenant } = ok;
  const c = db(), a = admin();
  if (!c || !a) return res.status(503).json({ ok: false, error: 'Sign-in is not configured.' });

  try {
    if (req.method === 'GET') return res.json({ ok: true, members: await members(c, a, tenant, user) });

    if (req.method === 'DELETE') {
      const id = String(req.query?.user_id || '').trim();
      if (!id) return res.status(400).json({ ok: false, error: 'Who should lose access?' });
      if (id === user.id) return res.status(400).json({ ok: false, error: "You can't remove yourself." });
      const list = await members(c, a, tenant, user);
      const m = list.find((x) => x.user_id === id);
      if (!m) return res.status(404).json({ ok: false, error: 'That person doesn’t have access.' });
      if (m.role === 'owner') return res.status(400).json({ ok: false, error: 'The owner keeps access.' });
      await c.from('tenant_users').delete().eq('tenant_id', tenant.id).eq('user_id', id);
      return res.json({ ok: true, members: await members(c, a, tenant, user) });
    }

    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const email = String(b.email || '').trim().toLowerCase();
    const role = INVITABLE.includes(String(b.role || '').toLowerCase()) ? String(b.role).toLowerCase() : 'staff';
    const name = String(b.name || '').trim().slice(0, 80);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ ok: false, error: 'Enter their email.' });
    if (email === String(tenant.owner_email || '').toLowerCase()) return res.status(400).json({ ok: false, error: 'That’s the owner’s own email.' });

    // Find or create their sign-in (confirmed, random password they will replace).
    let person = await findUserByEmail(email).catch(() => null);
    if (!person) {
      person = await createConfirmedUser({ email, password: crypto.randomBytes(24).toString('base64url') + 'A1!', name, meta: { invited_to: tenant.id } });
    }
    // One salon per sign-in: never quietly pull someone out of another salon.
    const { data: elsewhere } = await c.from('tenant_users').select('tenant_id').eq('user_id', person.id).neq('tenant_id', tenant.id).limit(1);
    const { data: owns } = await c.from('tenants').select('id').ilike('owner_email', email.replace(/[\\%_]/g, (m) => '\\' + m)).neq('id', tenant.id).limit(1);
    if ((elsewhere || []).length || (owns || []).length) {
      return res.status(409).json({ ok: false, error: 'This email already signs in to another LolaDesk salon. Use a different email for them.' });
    }
    const up = await c.from('tenant_users').upsert({ tenant_id: tenant.id, user_id: person.id, role }, { onConflict: 'tenant_id,user_id' });
    if (up.error) throw up.error;

    // The link to set their password, by email and (optionally) text.
    const link = await setPasswordLink(a, email);
    const salon = tenant.name || 'your salon';
    const who = name ? name.split(' ')[0] : '';
    let emailed = false, texted = false;
    try {
      const { SendEmail } = await import('./lib/lola-integrations.js');
      const r = await Promise.race([
        SendEmail({
          to: email,
          subject: `You're invited to ${salon} on LolaDesk`,
          html: `<p>Hi${who ? ' ' + esc(who) : ''},</p><p>${esc(salon)} added you to LolaDesk, where Lola answers the phone and books clients. Set your password to sign in:</p><p><a href="${esc(link)}">Set my password</a></p><p>The link works once. If it expires, ask ${esc(salon)} to send it again.</p>`,
          textContent: `${salon} added you to LolaDesk. Set your password to sign in: ${link}`,
          from: process.env.EMAIL_FROM || process.env.SENDGRID_FROM || 'lola@loladesk.com',
        }),
        new Promise((r2) => setTimeout(() => r2(null), 5000)),
      ]);
      emailed = !!(r && (r.success === true || r.sent === true || r.id || r.messageId));
    } catch (_) {}
    const phone = String(b.phone || '').replace(/[^\d+]/g, '');
    if (phone.length >= 10) {
      try { const r = await sendSms({ tenant, to: phone, body: `${salon} added you to LolaDesk. Set your password: ${link}` }); texted = !!(r && !r.skipped && !r.error); } catch (_) {}
    }
    return res.json({
      ok: true, emailed, texted,
      // If neither went out, the owner can hand the link over themselves.
      link: emailed || texted ? undefined : link,
      members: await members(c, a, tenant, user),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
