// POST /api/lola/ask { question }
// The owner-facing "ask Lola anything" endpoint used by the dashboard dock
// (Drop C) and any other in-app chat. Lola's brain answers business
// questions using the owner's OWN tenant scope (from their auth token).
//
// Not for external callers — this one uses standard bearer auth, not the
// tool-secret Telnyx uses.
import { cors, jsonBody } from '../lib/cors.js';
import { bearer, getUserFromToken } from '../lib/auth.js';
import { resolveTenantForUser } from '../lib/tenant-access.js';
import { db } from '../lib/db.js';
import { chatText } from '../lib/telnyx-inference.js';

const SYSTEM = `You are Lola — the front-desk AI for a salon owner's LolaDesk workspace.
You have the owner's business data below in context. Answer their questions clearly and briefly.
When they ask for numbers, be exact. When they ask for suggestions, be specific.
Keep replies to 2-3 sentences unless they ask for detail. No preamble.
If a question needs data you don't have in context, say so and offer what you do have.`;

async function buildContext(c, tenant) {
  const today = new Date();
  const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString();
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();

  const [payments, bookings, calls, threads] = await Promise.all([
    c.from('payments').select('amount, kind, status, created_at').eq('tenant_id', tenant.id).gte('created_at', sevenDaysAgo),
    c.from('bookings').select('id, start_time, outcome, total_amount, service_id, staff_id').eq('tenant_id', tenant.id).gte('start_time', sevenDaysAgo),
    c.from('calls').select('id, outcome, started_at, duration_sec').eq('tenant_id', tenant.id).gte('started_at', sevenDaysAgo),
    c.from('inbox_threads').select('id, unread').eq('tenant_id', tenant.id).eq('unread', true)
  ]);

  const rev7d = (payments.data || []).reduce((s, p) => {
    if (p.status !== 'succeeded') return s;
    if (p.kind === 'charge' || p.kind === 'tip') return s + Number(p.amount || 0);
    if (p.kind === 'refund') return s - Number(p.amount || 0);
    return s;
  }, 0);
  const revToday = (payments.data || []).reduce((s, p) => {
    if (p.status !== 'succeeded' || p.created_at < startOfDay) return s;
    if (p.kind === 'charge' || p.kind === 'tip') return s + Number(p.amount || 0);
    return s;
  }, 0);
  const bkToday = (bookings.data || []).filter(b => b.start_time >= startOfDay);
  const bk7 = bookings.data || [];
  const noShows = bk7.filter(b => b.outcome === 'no_show').length;
  const missedCalls = (calls.data || []).filter(c => c.outcome === 'missed').length;
  const unread = (threads.data || []).length;

  return `BUSINESS: ${tenant.name}
TIMEZONE: ${tenant.timezone || 'America/New_York'}
TODAY: ${today.toDateString()}

METRICS (last 7 days unless noted)
- Revenue today: $${(revToday / 100).toFixed(2)}
- Revenue last 7d: $${(rev7d / 100).toFixed(2)}
- Bookings today: ${bkToday.length}
- Bookings last 7d: ${bk7.length}
- No-shows last 7d: ${noShows}
- Missed calls last 7d: ${missedCalls}
- Unread SMS threads: ${unread}`;
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  try {
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'not_authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no_tenant' });

    const { question } = jsonBody(req);
    if (!question) return res.status(400).json({ ok: false, error: 'missing_question' });

    const c = db();
    const context = await buildContext(c, tenant);

    const answer = await chatText({
      system: SYSTEM,
      user: `CONTEXT:\n${context}\n\nOWNER QUESTION: ${question}`,
      max_tokens: 400,
      temperature: 0.3
    });

    return res.json({ ok: true, answer: answer.trim() });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
