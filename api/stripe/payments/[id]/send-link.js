// POST /api/stripe/payments/:id/send-link
// Texts the client the payment link that already exists for this payment, from
// the salon's own number (api/lib/sms.js sendSms). Owner/manager, signed in; the
// salon comes from the session, never from the request.
//
// Where the existing link lives (first hit wins):
//   1. payments.metadata.payment_link_url | link_url | url
//   2. pos_transactions.payment_link_url (Checkout → "Send payment link")
//   3. the booking's deposit Payment Link (deposits.stripe_payment_intent_id = plink_…)
// No link → an honest 409; this endpoint never invents a new charge.

const OWNERISH = ['owner', 'admin', 'manager', 'front_desk', 'frontdesk'];
const urlOk = (u) => typeof u === 'string' && /^https:\/\/\S+$/.test(u);

export function sendFailureMessage(result, clientPhoneOk = true) {
  const reason = String(result?.reason || '');
  if (!clientPhoneOk) return { status: 400, error: 'The client’s phone number on file doesn’t look right. Fix it on their profile and try again.' };
  if (reason === 'no_salon_number') return { status: 409, error: 'Your salon doesn’t have a texting number yet, so the link couldn’t be texted. Set one up in Settings.' };
  if (reason === 'opted_out') return { status: 409, error: 'This client has opted out of texts (they replied STOP), so the link wasn’t sent.' };
  if (reason === 'no_recipient') return { status: 400, error: 'There’s no phone number on file for this client. Add one to their profile, then send the link.' };
  // The client's number is valid, so a "bad number" here is the salon's sending line.
  if (reason === 'bad_number') return { status: 409, error: 'Your salon’s texting number isn’t set up correctly, so the link couldn’t be texted. Check it in Settings.' };
  return { status: 502, error: 'Texting didn’t go through just now — nothing is wrong with the client’s number. Please try again in a minute.' };
}

async function existingLink(c, tenantId, pay) {
  const meta = (pay && pay.metadata) || {};
  for (const k of ['payment_link_url', 'link_url', 'url']) if (urlOk(meta[k])) return meta[k];
  if (pay.stripe_id) {
    try {
      const { data } = await c.from('pos_transactions').select('payment_link_url').eq('tenant_id', tenantId).eq('stripe_id', pay.stripe_id).maybeSingle();
      if (urlOk(data?.payment_link_url)) return data.payment_link_url;
    } catch (_) {}
  }
  if (pay.booking_id) {
    try {
      const { data } = await c.from('deposits').select('stripe_payment_intent_id,status').eq('tenant_id', tenantId).eq('booking_id', pay.booking_id).limit(5);
      const plink = (data || []).map((d) => d.stripe_payment_intent_id).find((x) => /^plink_/.test(String(x || '')));
      if (plink && process.env.STRIPE_SECRET_KEY) {
        const r = await fetch('https://api.stripe.com/v1/payment_links/' + encodeURIComponent(plink), { headers: { Authorization: 'Bearer ' + process.env.STRIPE_SECRET_KEY } });
        const j = await r.json().catch(() => ({}));
        if (r.ok && j.active !== false && urlOk(j.url)) return j.url;
      }
    } catch (_) {}
  }
  return null;
}

const mask = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length >= 4 ? '•••' + d.slice(-4) : 'the client'; };

export default async function handler(req, res) {
  let cors, bearer, getUserFromToken, resolveTenantAccessForUser, db, e164, sendSms;
  try {
    ({ cors } = await import('../../../lib/cors.js'));
    ({ bearer, getUserFromToken } = await import('../../../lib/auth.js'));
    ({ resolveTenantAccessForUser } = await import('../../../lib/tenant-access.js'));
    ({ db, e164 } = await import('../../../lib/db.js'));
    ({ sendSms } = await import('../../../lib/sms.js'));
  } catch (e) { return res.status(500).json({ ok: false, error: 'import_failed' }); }

  if (cors && cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  try {
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'not_authenticated' });
    const access = await resolveTenantAccessForUser(user);
    const tenant = access?.tenant;
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no_tenant' });
    if (access.role && !OWNERISH.includes(String(access.role).toLowerCase())) return res.status(403).json({ ok: false, error: 'Only the salon’s owner or front desk can send payment links.' });
    const c = db();
    if (!c) return res.status(503).json({ ok: false, error: 'database_not_configured' });

    const id = String(req.query?.id || '').trim();
    if (!id) return res.status(400).json({ ok: false, error: 'bad_id' });
    let { data: pay } = await c.from('payments').select('*').eq('tenant_id', tenant.id).eq('id', id).maybeSingle();
    if (!pay) ({ data: pay } = await c.from('payments').select('*').eq('tenant_id', tenant.id).eq('stripe_id', id).maybeSingle());
    if (!pay) return res.status(404).json({ ok: false, error: 'Payment not found.' });
    if (String(pay.status || '').toLowerCase() === 'succeeded' && !pay.at_risk) return res.status(409).json({ ok: false, error: 'This payment is already paid — no link needed.' });

    const link = await existingLink(c, tenant.id, pay);
    if (!link) return res.status(409).json({ ok: false, error: 'There’s no payment link for this charge to resend. Send a new one from Checkout.' });

    let phone = pay.client_phone || '', first = String(pay.client_name || '').split(/\s+/)[0] || '';
    if ((!phone || !first) && pay.client_id) {
      const { data: cl } = await c.from('clients').select('*').eq('tenant_id', tenant.id).eq('id', pay.client_id).maybeSingle();
      if (cl) { phone = phone || cl.phone || cl.phone_number || ''; first = first || cl.first_name || String(cl.name || '').split(/\s+/)[0] || ''; }
    }
    if (!phone) return res.status(400).json({ ok: false, error: 'There’s no phone number on file for this client. Add one to their profile, then send the link.' });

    const amount = Number(pay.amount) > 0 ? ` for $${(Number(pay.amount) / 100).toFixed(2)}` : '';
    const text = `Hi${first ? ' ' + first : ''}, here’s your payment link from ${tenant.name || 'the salon'}${amount}: ${link}`;
    const out = await sendSms({ tenant, tenantId: tenant.id, to: phone, text });
    if (!out || out.skipped || out.failed) {
      const f = sendFailureMessage(out, /^\+\d{7,15}$/.test(String(e164(phone) || '')));
      return res.status(f.status).json({ ok: false, error: f.error, reason: out?.reason || null });
    }
    try {
      await c.from('payments').update({ metadata: { ...(pay.metadata || {}), link_sent_at: new Date().toISOString() } }).eq('id', pay.id).eq('tenant_id', tenant.id);
    } catch (_) {}
    return res.json({ ok: true, sent_to: mask(phone), link });
  } catch (e) {
    console.error('[send-link]', e?.message || e);
    return res.status(500).json({ ok: false, error: 'Couldn’t send the payment link just now. Please try again.' });
  }
}
