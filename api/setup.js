/**
 * /api/setup — the signed-in owner's own salon setup (phone line + business texting).
 *   GET                       → { ok, telecom: setupProgress } (plain language, no ids)
 *   POST { action, ...args }  → the same engine actions Lola uses (api/lib/setup/telecom-tools.js)
 *       actions: setup_status | get_number | forward_my_number | forwarding_test |
 *                port_my_number | port_status | register_texting | verify_texting_code | texting_status
 *       (money/irreversible actions need confirmed:true, otherwise they return a preview)
 * Auth: a signed-in owner/admin/manager of THIS salon. Only that salon's data is ever touched.
 */
import { getUserFromToken, bearer } from './lib/auth.js';
import { resolveTenantAccessForUser } from './lib/tenant-access.js';
import { setupProgress } from './lib/setup/telecom.js';
import { runSetupTool, SETUP_TOOLS } from './lib/setup/telecom-tools.js';

const OWNER_ROLES = new Set(['owner', 'admin', 'manager']);
const ACTIONS = new Set(SETUP_TOOLS.map((t) => t.function.name));
// The UI may also upload a bill / transfer letter directly (base64) — never accepted from Lola's tool schema.
const UI_EXTRA = ['bill_base64', 'bill_filename', 'loa_base64', 'loa_filename'];

function body(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') { try { return JSON.parse(req.body || '{}'); } catch { return {}; } }
  return req.body;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ ok: false, say: 'Not allowed.' });
  const user = await getUserFromToken(bearer(req)).catch(() => null);
  if (!user) return res.status(401).json({ ok: false, say: 'Please sign in again.' });
  const access = await resolveTenantAccessForUser(user).catch(() => null);
  const tenant = access?.tenant;
  if (!tenant?.id) return res.status(404).json({ ok: false, say: 'I couldn’t find your salon — finish signing up first.' });
  if (!OWNER_ROLES.has(String(access.role || '').toLowerCase())) return res.status(403).json({ ok: false, say: 'Only the salon owner or a manager can change the phone setup.' });
  try {
    if (req.method === 'GET') {
      const p = await setupProgress(tenant);
      return res.status(200).json({ ok: true, telecom: p, say: p.say });
    }
    const b = body(req);
    const action = String(b.action || '').trim();
    if (!ACTIONS.has(action)) return res.status(400).json({ ok: false, say: 'I don’t know that setup step.', actions: [...ACTIONS] });
    const args = { ...b }; delete args.action;
    for (const k of Object.keys(args)) if (k.endsWith('_base64') && !UI_EXTRA.includes(k)) delete args[k];
    const r = await runSetupTool({ tenant, name: action, args, req });
    return res.status(200).json(r);
  } catch (e) {
    console.error('[api/setup]', String(e?.message || e).slice(0, 200));
    return res.status(200).json({ ok: false, say: 'Something went wrong on my side — try again in a minute.' });
  }
}
