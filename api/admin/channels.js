/**
 * /api/admin/channels — every salon's Instagram / Messenger / WhatsApp, for the operator.
 * Gated by ADMIN_EMAILS (isAdminEmail), like every /api/admin endpoint.
 *   GET  → { tenants:[{ tenant, instagram, messenger, whatsapp, whatsapp_request }],
 *            waba:{ wabas, numbers, unmatched }, templates, pending_whatsapp, meta_setup }
 *   POST { action:'sync_whatsapp' [, tenant_id] }   match WABA numbers → salons, templates, messaging profile
 *        { action:'sync_templates' }                 refresh Meta's template verdicts
 *        { action:'check_messenger' }                Page tokens + subscriptions health
 *        { action:'resolve_request', tenant_id }     close a WhatsApp request by hand
 */
import { bearer, getUserFromToken, isAdminEmail } from '../lib/auth.js';
import { db } from '../lib/db.js';
import { appUrl } from '../lib/telnyx-client.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ ok: false, error: 'GET/POST only' });
  const user = await getUserFromToken(bearer(req)).catch(() => null);
  if (!user) return res.status(401).json({ ok: false, error: 'Not signed in' });
  if (!isAdminEmail(user.email)) return res.status(403).json({ ok: false, error: 'Not authorized' });
  const c = db();
  if (!c) return res.status(503).json({ ok: false, error: 'Database not configured' });
  try { const { ensureMigrations } = await import('../lib/migrate.js'); await ensureMigrations(); } catch (_) {}
  const wa = await import('../lib/whatsapp-setup.js');

  if (req.method === 'POST') {
    let body = {};
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); } catch (_) {}
    try {
      if (body.action === 'sync_whatsapp') return res.status(200).json({ ok: true, result: await wa.syncWhatsApp(c, { tenantId: body.tenant_id || null, force: true }) });
      if (body.action === 'sync_templates') return res.status(200).json({ ok: true, result: await wa.syncTemplateStatuses(c) });
      if (body.action === 'check_messenger') { const fb = await import('../lib/messenger-dm.js'); return res.status(200).json({ ok: true, result: await fb.checkMessengerPages(c) }); }
      if (body.action === 'resolve_request' && body.tenant_id) {
        await c.from('tenant_channels').update({ status: 'done', updated_at: new Date().toISOString() }).eq('channel', 'whatsapp_request').eq('account_id', String(body.tenant_id));
        return res.status(200).json({ ok: true });
      }
      return res.status(400).json({ ok: false, error: 'action must be sync_whatsapp | sync_templates | check_messenger | resolve_request' });
    } catch (e) { return res.status(500).json({ ok: false, error: String(e?.message || e).slice(0, 300) }); }
  }

  const [{ data: tenants }, { data: rows }, { data: templates }] = await Promise.all([
    c.from('tenants').select('id,name,slug,phone_number').limit(2000).then((r) => r, () => ({ data: [] })),
    c.from('tenant_channels').select('tenant_id,channel,account_id,username,status,expires_at,updated_at,created_at,last_error,meta').limit(5000).then((r) => r, () => ({ data: [] })),
    c.from('whatsapp_templates').select('*').limit(5000).then((r) => r, () => ({ data: [] })),
  ]);
  const by = new Map();
  for (const t of tenants || []) by.set(String(t.id), { tenant: { id: t.id, name: t.name, slug: t.slug, phone_number: t.phone_number || null }, instagram: [], messenger: [], messenger_pending: null, whatsapp: [], whatsapp_request: null });
  for (const r of rows || []) {
    const e = by.get(String(r.tenant_id)); if (!e) continue;
    const base = { account_id: r.account_id, name: r.username || null, status: r.status, expires_at: r.expires_at || null, updated_at: r.updated_at || null, last_error: r.last_error || null };
    if (r.channel === 'instagram') e.instagram.push(base);
    else if (r.channel === 'messenger') e.messenger.push({ ...base, page_id: r.account_id, subscribed: !!(r.meta && r.meta.subscribed), checked_at: r.meta && r.meta.checked_at || null });
    else if (r.channel === 'messenger_pending') e.messenger_pending = { pages: (r.meta && r.meta.pages) || [], expires_at: r.expires_at };
    else if (r.channel === 'whatsapp') e.whatsapp.push({ ...base, phone_number: r.account_id, ...(r.meta || {}), templates: (templates || []).filter((t) => r.meta && t.waba_id === r.meta.waba_id).map((t) => ({ name: t.name, status: t.status, reason: t.reason || null, id: t.telnyx_template_id || null })) });
    else if (r.channel === 'whatsapp_request') e.whatsapp_request = { status: r.status, phone_number: r.meta && r.meta.phone_number || null, requested_at: r.meta && r.meta.requested_at || r.created_at || null, portal_step: r.status === 'pending' ? wa.portalStep(r.meta && r.meta.phone_number || 'the salon’s number') : null };
  }
  let waba = null;
  if (process.env.TELNYX_API_KEY && String(req.query?.live || '') === '1') {
    try { const live = await wa.wabaNumbers(); const map = await wa.salonNumberMap(c); waba = { wabas: live.wabas, numbers: wa.matchNumbers(live.numbers, map) }; } catch (e) { waba = { error: String(e?.message || e).slice(0, 200) }; }
  }
  const list = [...by.values()];
  return res.status(200).json({
    ok: true,
    tenants: list,
    pending_whatsapp: list.filter((x) => x.whatsapp_request && x.whatsapp_request.status === 'pending').map((x) => ({ tenant: x.tenant, ...x.whatsapp_request })),
    templates: templates || [],
    waba,
    meta_setup: {
      instagram_webhook: appUrl() + '/api/instagram', messenger_webhook: appUrl() + '/api/messenger',
      instagram_redirect_uri: appUrl() + '/api/instagram', messenger_redirect_uri: appUrl() + '/api/messenger',
      verify_token_set: !!(process.env.META_VERIFY_TOKEN || process.env.INSTAGRAM_VERIFY_TOKEN),
      app_configured: !!((process.env.FACEBOOK_APP_ID || process.env.INSTAGRAM_APP_ID) && (process.env.FACEBOOK_APP_SECRET || process.env.INSTAGRAM_APP_SECRET)),
      encryption_key_set: !!process.env.INTEGRATION_ENCRYPTION_KEY,
      whatsapp_webhook: appUrl() + '/api/webhooks/whatsapp'
    }
  });
}
