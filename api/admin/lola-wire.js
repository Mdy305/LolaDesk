/**
 * /api/admin/lola-wire — Lola's Telnyx assistant, wired by LolaDesk (admin)
 *   GET  → what's miswired (tool URLs, dynamic-variables webhook) and every salon line
 *   POST → fix it all: re-point tools to /api/lola-tools?tool=…, reconnect the
 *          dynamic-variables webhook, re-attach every salon number.
 * Same as an admin saying "Lola, run a check". Admin-gated (ADMIN_EMAILS).
 */
import { getUserFromToken, bearer, isAdminEmail } from '../lib/auth.js';
import { db } from '../lib/db.js';
import { wireAssistant } from '../lib/assistant-wiring.js';
import { wireTenantNumbers } from '../lib/tenant-wiring.js';
import { wireAccount } from '../lib/telnyx-account.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ ok: false, error: 'GET or POST' });
  const user = await getUserFromToken(bearer(req)).catch(() => null);
  if (!user) return res.status(401).json({ ok: false, error: 'not authenticated' });
  if (!isAdminEmail(user.email)) return res.status(403).json({ ok: false, error: 'platform admins only' });
  const heal = req.method === 'POST';
  const account = db() ? await wireAccount(db(), { heal }).catch(e => ({ ok: false, error: String(e?.message || e) })) : null;
  const assistant = await wireAssistant({ heal }).catch(e => ({ ok: false, error: String(e?.message || e) }));
  const c = db();
  const salons = c ? await wireTenantNumbers(c, { heal }).catch(e => ({ ok: false, error: String(e?.message || e) })) : { ok: false, error: 'database not configured' };
  return res.status(200).json({ ok: !!(account?.ok && assistant.ok && salons.ok), healed: heal, account, assistant, salons });
}
