/**
 * /api/channels — the signed-in owner's messaging channels, in plain words.
 *   GET                       → { instagram, messenger, whatsapp } for THIS salon only
 *   POST { action, ... }      → the same actions Lola can do by voice:
 *        connect_instagram | connect_facebook   → { ui:{ open:'oauth', url } }
 *        choose_facebook_page { page_id | page_name }
 *        disconnect { channel, confirmed }       (confirmed:true required; the button click is the confirmation)
 *        turn_on_whatsapp | whatsapp_status | channels_status
 */
import { getUserFromToken, bearer } from './lib/auth.js';
import { resolveTenantForUser } from './lib/tenant-access.js';
import { runSetupTool, channelsStatus } from './lib/setup/channel-tools.js';
import { db } from './lib/db.js';

const ACTIONS = { connect_instagram: 'connect_instagram', connect_facebook: 'connect_facebook', connect_messenger: 'connect_facebook', choose_facebook_page: 'choose_facebook_page', choose_page: 'choose_facebook_page', disconnect: 'disconnect_channel', disconnect_channel: 'disconnect_channel', turn_on_whatsapp: 'turn_on_whatsapp', whatsapp_status: 'whatsapp_status', channels_status: 'channels_status' };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ ok: false, error: 'GET/POST only' });
  const user = await getUserFromToken(bearer(req)).catch(() => null);
  if (!user) return res.status(401).json({ ok: false, error: 'Not signed in' });
  const tenant = await resolveTenantForUser(user).catch(() => null);
  if (!tenant?.id) return res.status(404).json({ ok: false, error: 'No salon for this account' });
  const c = db();
  if (!c) return res.status(503).json({ ok: false, error: 'Not available right now' });

  if (req.method === 'GET') {
    try { const s = await channelsStatus(c, tenant); return res.status(200).json({ ok: true, ...s }); }
    catch (_) { return res.status(200).json({ ok: false, error: 'Couldn’t check your channels right now.' }); }
  }
  let body = {};
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); } catch (_) { body = {}; }
  const name = ACTIONS[String(body.action || '')];
  if (!name) return res.status(400).json({ ok: false, error: 'Unknown action' });
  const args = { ...body }; delete args.action;
  if (name === 'disconnect_channel') args.confirmed = body.confirmed === true;
  const out = await runSetupTool({ tenant, name, args, req });
  return res.status(200).json(out);
}
