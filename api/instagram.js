/**
 * /api/instagram — each salon's Instagram DMs, answered by Lola.
 *   GET  ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…   Meta webhook check
 *   POST (signed by Meta)                                           a DM arrived → Lola answers
 *   GET  ?action=status            (owner)  connected? which account
 *   GET  ?action=connect           (owner)  → { url } to Instagram's sign-in
 *   GET  ?code&state (redirect URI = /api/instagram) Instagram sends the owner back here
 *   POST ?action=disconnect        (owner)
 */
import { getUserFromToken, bearer } from './lib/auth.js';
import { resolveTenantForUser } from './lib/tenant-access.js';
import { db } from './lib/db.js';
import { igConfigured, authUrl, readState, connectInstagram, channelFor, disconnect, verifySignature, handleInstagramEvent } from './lib/instagram-dm.js';

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

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const query = { ...(req.query || {}), ...q(req) };
  const c = db();

  // Meta's one-time webhook verification.
  if (req.method === 'GET' && query['hub.mode'] === 'subscribe') {
    if (process.env.INSTAGRAM_VERIFY_TOKEN && query['hub.verify_token'] === process.env.INSTAGRAM_VERIFY_TOKEN) return res.status(200).send ? res.status(200).send(String(query['hub.challenge'] || '')) : res.status(200).end(String(query['hub.challenge'] || ''));
    return res.status(403).json({ ok: false });
  }

  // Instagram returns the owner here after they approve.
  if (req.method === 'GET' && (query.action === 'callback' || ((query.code || query.error) && query.state))) {
    const back = (s) => { res.statusCode = 302; res.setHeader('Location', '/settings?instagram=' + s); return res.end(); };
    if (query.error || !query.code) return back('cancelled');
    const tenantId = readState(query.state);
    if (!tenantId || !c) return back('expired');
    try { await connectInstagram(c, tenantId, query.code); return back('connected'); }
    catch (e) { console.warn('[instagram] connect', String(e?.message || e).slice(0, 200)); return back(e?.code === 'taken' ? 'taken' : 'failed'); }
  }

  // A DM.
  if (req.method === 'POST' && !query.action) {
    const raw = await readRaw(req);
    if (!verifySignature(raw, req.headers['x-hub-signature-256'])) return res.status(401).json({ ok: false, error: 'bad signature' });
    let event; try { event = JSON.parse(raw); } catch (_) { return res.status(200).json({ ok: false }); }
    try { const out = c ? await handleInstagramEvent(c, event) : []; return res.status(200).json({ ok: true, handled: out.length }); }
    catch (e) { console.error('[instagram]', String(e?.message || e).slice(0, 200)); return res.status(200).json({ ok: false }); }
  }

  // Owner actions.
  const user = await getUserFromToken(bearer(req)).catch(() => null);
  if (!user) return res.status(401).json({ ok: false, error: 'not signed in' });
  const tenant = await resolveTenantForUser(user).catch(() => null);
  if (!tenant || !c) return res.status(404).json({ ok: false, error: 'no salon for this account' });
  if (query.action === 'connect') {
    if (!igConfigured()) return res.status(200).json({ ok: false, error: 'not_configured', say: 'Instagram isn’t switched on for LolaDesk yet — the LolaDesk team is finishing Meta’s approval.' });
    return res.status(200).json({ ok: true, url: authUrl(tenant.id) });
  }
  if (query.action === 'disconnect' && req.method === 'POST') return res.status(200).json(await disconnect(c, tenant.id));
  const ch = await channelFor(c, tenant.id);
  return res.status(200).json({ ok: true, available: igConfigured(), connected: !!(ch && ch.status === 'active'), username: ch?.username || null });
}
