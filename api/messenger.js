/**
 * /api/messenger — each salon's Facebook Messenger, answered by Lola.
 *   GET  ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…   Meta webhook check
 *   POST (signed by Meta, object 'page')                            a message arrived → Lola answers
 *   GET  ?code&state  (redirect URI = /api/messenger)               Facebook sends the owner back here
 *   GET  ?action=status            (owner)  connected? which Page? Pages waiting to be picked?
 *   GET  ?action=connect           (owner)  → { url } to Facebook's sign-in
 *   POST ?action=choose {page_id}  (owner)  pick the salon's Page when they manage several
 *   POST ?action=disconnect        (owner)
 */
import { getUserFromToken, bearer } from './lib/auth.js';
import { resolveTenantForUser } from './lib/tenant-access.js';
import { db } from './lib/db.js';
import { fbConfigured, verifyToken, authUrl, readState, connectMessengerFromCode, channelFor, pendingPages, choosePage, disconnect, verifySignature, handleMessengerEvent } from './lib/messenger-dm.js';

export const config = { api: { bodyParser: false } };

async function readRaw(req) {
  const chunks = [];
  try { for await (const ch of req) chunks.push(typeof ch === 'string' ? Buffer.from(ch) : ch); } catch (_) {}
  if (chunks.length) return Buffer.concat(chunks).toString('utf8');
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  return req.body ? JSON.stringify(req.body) : '';
}
const q = (req) => { try { return Object.fromEntries(new URL(req.url, 'http://x').searchParams); } catch (_) { return req.query || {}; } };
const send = (res, code, text) => (res.status(code).send ? res.status(code).send(text) : res.status(code).end(text));

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const query = { ...(req.query || {}), ...q(req) };
  const c = db();

  // Meta's one-time webhook verification.
  if (req.method === 'GET' && query['hub.mode'] === 'subscribe') {
    if (verifyToken() && query['hub.verify_token'] === verifyToken()) return send(res, 200, String(query['hub.challenge'] || ''));
    return res.status(403).json({ ok: false });
  }

  // Facebook returns the owner here after they approve.
  if (req.method === 'GET' && (query.action === 'callback' || ((query.code || query.error) && query.state))) {
    const back = (s) => { res.statusCode = 302; res.setHeader('Location', '/settings?messenger=' + s); return res.end(); };
    if (query.error || !query.code) return back('cancelled');
    const tenantId = readState(query.state);
    if (!tenantId || !c) return back('expired');
    try {
      const r = await connectMessengerFromCode(c, tenantId, query.code);
      if (r.ok && r.choose) return back('choose');
      if (r.ok) return back('connected');
      return back(r.reason === 'taken' ? 'taken' : r.reason === 'no_pages' ? 'nopage' : 'failed');
    } catch (e) { console.warn('[messenger] connect', String(e?.message || e).slice(0, 200)); return back('failed'); }
  }

  // A message.
  if (req.method === 'POST' && !query.action) {
    const raw = await readRaw(req);
    if (!verifySignature(raw, req.headers['x-hub-signature-256'])) return res.status(401).json({ ok: false, error: 'bad signature' });
    let event; try { event = JSON.parse(raw); } catch (_) { return res.status(200).json({ ok: false }); }
    try { const out = c ? await handleMessengerEvent(c, event) : []; return res.status(200).json({ ok: true, handled: out.length }); }
    catch (e) { console.error('[messenger]', String(e?.message || e).slice(0, 200)); return res.status(200).json({ ok: false }); }
  }

  // Owner actions.
  const user = await getUserFromToken(bearer(req)).catch(() => null);
  if (!user) return res.status(401).json({ ok: false, error: 'not signed in' });
  const tenant = await resolveTenantForUser(user).catch(() => null);
  if (!tenant || !c) return res.status(404).json({ ok: false, error: 'no salon for this account' });
  let body = {};
  if (req.method === 'POST') { try { const raw = await readRaw(req); body = raw ? JSON.parse(raw) : {}; } catch (_) { body = typeof req.body === 'object' && req.body ? req.body : {}; } }

  if (query.action === 'connect') {
    if (!fbConfigured()) return res.status(200).json({ ok: false, error: 'not_configured', say: 'Facebook Messenger isn’t switched on for LolaDesk yet — the LolaDesk team is finishing Meta’s approval.' });
    return res.status(200).json({ ok: true, url: authUrl(tenant.id) });
  }
  if (query.action === 'choose' && req.method === 'POST') {
    const r = await choosePage(c, tenant.id, { pageId: body.page_id || query.page_id, pageName: body.page_name || null });
    return res.status(200).json({ ok: !!r.ok, say: r.say, name: r.name || null, pages: r.pages || undefined });
  }
  if (query.action === 'disconnect' && req.method === 'POST') { await disconnect(c, tenant.id); return res.status(200).json({ ok: true, say: 'Facebook Messenger is disconnected. Lola no longer answers your Page’s messages.' }); }
  const ch = await channelFor(c, tenant.id);
  const pages = await pendingPages(c, tenant.id);
  return res.status(200).json({ ok: true, available: fbConfigured(), connected: !!(ch && ch.status === 'active'), needs_reconnect: !!(ch && ch.status === 'needs_reconnect'), page: ch && ch.status === 'active' ? (ch.username || 'your Page') : null, choose: pages.map((p) => ({ id: p.id, name: p.name })) });
}
