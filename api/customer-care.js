/**
 * /api/customer-care — LolaDesk's OWN support line (Lola, for the app).
 * ═══════════════════════════════════════════════════════════════════════
 *   GET  ?public=1                → { number, email, agent_id } for loladesk.com/support
 *   POST ?action=ticket&k=…       → Lola's log_support_request tool (from Telnyx)
 *   GET                           → platform admin: current state
 *   POST { phone_number?, area_code? } → platform admin: set up / refresh the line
 *                                   (reuses a free number, else buys one)
 */
import { bearer, getUserFromToken, isAdminEmail } from './lib/auth.js';
import { db } from './lib/db.js';
import { ensureMigrations } from './lib/migrate.js';
import { careState, provisionCare, publicCare, recordTicket, ticketToken, SUPPORT_EMAIL } from './lib/customer-care.js';

function body(req) {
  const b = req.body;
  if (typeof b === 'string') { try { return JSON.parse(b || '{}'); } catch (_) { return {}; } }
  return b || {};
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  const q = req.query || {};
  const c = db();

  // Public: the support page shows the number.
  if (req.method === 'GET' && (q.public === '1' || q.public === 'true')) {
    res.setHeader('Cache-Control', 'public, max-age=300');
    if (!c) return res.json({ ok: true, number: null, email: SUPPORT_EMAIL, agent_id: null });
    return res.json({ ok: true, ...(await publicCare(c)) });
  }

  // Lola's tool on a support call: "pass this to the team".
  if (req.method === 'POST' && q.action === 'ticket') {
    if (String(q.k || '') !== ticketToken()) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const b = body(req);
    const args = b.arguments || b.args || b;
    const from = /\{\{/.test(String(q.from || '')) ? null : q.from;
    const ch = /\{\{/.test(String(q.ch || '')) ? 'phone_call' : (q.ch || 'phone_call');
    const r = await recordTicket(c, { ...args, from: args.callback_number || from, channel: ch });
    return res.json({ ok: true, result: 'Passed to the LolaDesk team. Tell the caller they will hear back within one business day.', saved: r.saved, alerted: r.alerted });
  }

  const user = await getUserFromToken(bearer(req)).catch(() => null);
  if (!user) return res.status(401).json({ ok: false, error: 'Not signed in' });
  if (!isAdminEmail(user.email)) return res.status(403).json({ ok: false, error: 'Only the LolaDesk owner can set up the support line. Add your email to ADMIN_EMAILS in Vercel.' });
  if (!c) return res.status(503).json({ ok: false, error: 'Database not configured' });
  try { await ensureMigrations(); } catch (_) {}

  if (req.method === 'GET') {
    const s = await careState(c);
    return res.json({ ok: true, configured: !!(s?.number && s?.assistant_id), number: s?.number || null, assistant: s?.assistant_id ? { id: s.assistant_id, name: s.assistant_name } : null, email: SUPPORT_EMAIL, provisioned_at: s?.provisioned_at || null, telnyx: !!process.env.TELNYX_API_KEY });
  }

  const b = body(req);
  try {
    const r = await provisionCare(c, { phone_number: b.phone_number || null, area_code: b.area_code || '305', buy: b.buy !== false });
    return res.json(r);
  } catch (e) {
    console.error('[CUSTOMER-CARE]', String(e?.message || e).slice(0, 200));
    return res.status(500).json({ ok: false, error: String(e?.message || e).slice(0, 240) });
  }
}
