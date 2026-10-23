/**
 * /api/insights — the Business page: the salon's Square sales, analyzed by LolaBrain (owner/manager only).
 *   GET                                   → { connection, sync, insights, take }
 *   POST { action:'sync' }                → read Square now (a slice; the 15-minute cron finishes the rest)
 *   POST { action:'preview', key }        → who a move would text
 *   POST { action:'launch', key, message? } → the move becomes a campaign (paced, opt-out line, tracked in Square money)
 */
import { bearer, getUserFromToken } from './lib/auth.js';
import { resolveTenantForUser } from './lib/tenant-access.js';
import { db } from './lib/db.js';

const TAKE_TTL = 12 * 3600e3;

async function connection(c, tenantId) {
  const { data } = await c.from('integrations').select('id,status,metadata,updated_at').eq('tenant_id', tenantId).eq('provider', 'square').maybeSingle().then((x) => x, () => ({ data: null }));
  if (!data) return { connected: false, status: 'not_connected' };
  const missing = Array.isArray(data.metadata?.missing_scopes) ? data.metadata.missing_scopes : [];
  return { connected: data.status === 'connected', status: data.status, needs_reconnect: data.status !== 'connected' || missing.includes('PAYMENTS_READ') || missing.includes('ORDERS_READ'),
    location: data.metadata?.location_name || null, business: data.metadata?.business_name || null };
}

/** Lola's take: a short, plain analysis written by LolaBrain from the numbers (cached 12h; never invents numbers). */
export async function lolaTake(c, tenant, r, { llm = null, now = Date.now(), refresh = false } = {}) {
  const sd = await import('./lib/square-data.js');
  const fallback = sd.sayInsights(r, 'overview') + (r.moves?.[1] ? ' ' + r.moves.slice(1, 3).map((m) => m.why).join(' ') : '');
  if (!r?.ok) return { text: fallback, by: 'rules' };
  const key = 'square_take:' + tenant.id;
  const basis = `${r.as_of}|${r.revenue.this_month}|${r.moves.length}|${(r.campaigns || []).length}`;
  if (!refresh) {
    try { const { data } = await c.from('platform_settings').select('value').eq('key', key).maybeSingle(); const v = data?.value; if (v?.text && v.basis === basis && now - Date.parse(v.at) < TAKE_TTL) return { text: v.text, by: 'lola', at: v.at }; } catch (_) {}
  }
  const facts = { salon: tenant.name, revenue: { ...r.revenue, months: r.revenue.months.slice(-6) }, services: r.services.slice(0, 6), falling: r.falling_services, clients: { ...r.clients, top_spenders: r.clients.top_spenders.slice(0, 3).map((x) => ({ spend_12m: x.spend_12m, visits: x.visits })), lapsed_list: undefined, came_once_list: undefined },
    staff: r.staff.slice(0, 6), times: r.times, past_campaigns: (r.campaigns || []).slice(0, 8).map((x) => ({ name: x.name, texts: x.texts, returned: x.returned, revenue: x.revenue })), moves: r.moves.slice(0, 4).map((m) => ({ name: m.name, why: m.why, audience: m.audience, value: m.value })) };
  try {
    const chat = llm || (await import('./lib/llm.js')).chat;
    const out = await chat({ system: [
      `You are Lola, the business analyst and marketing manager of ${tenant.name || 'this salon'}. Write for the owner.`,
      'Use ONLY the numbers in the data. Never invent a number, a client or a trend.',
      'Three short paragraphs, plain words, no headings, no bullet symbols: 1) how the business is doing and the one trend that matters; 2) what is behind it (services, clients, days, team); 3) the 2-3 moves to make this week, with who, what offer and the expected value — and what past campaigns taught us.',
      'Warm, direct, confident. Under 170 words.'].join('\n'),
      messages: [{ role: 'user', content: JSON.stringify(facts) }], maxTokens: 420, temperature: 0.3, deadlineMs: 15000 });
    const text = out?.ok ? String(out.text || '').trim() : '';
    if (text.length > 60) {
      const at = new Date(now).toISOString();
      try { await c.from('platform_settings').upsert({ key, value: { text, basis, at }, updated_at: at }, { onConflict: 'key' }); } catch (_) {}
      return { text, by: 'lola', at };
    }
  } catch (_) {}
  return { text: fallback, by: 'rules' };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  try {
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'not authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no salon for this account' });
    const c = db();
    if (!c) return res.status(503).json({ ok: false, error: 'database not configured' });
    try { const { ensureMigrations } = await import('./lib/migrate.js'); await ensureMigrations(); } catch (_) {}
    const sd = await import('./lib/square-data.js');
    const conn = await connection(c, tenant.id);
    const body = req.method === 'POST' ? (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})) : {};

    if (req.method === 'GET') {
      const led = await sd.loadLedger(c, tenant.id);
      const r = conn.status === 'not_connected' && !Object.keys(led.payments || {}).length ? { ok: false, empty: true } : await sd.squareInsights(c, tenant);
      const take = r.ok ? await lolaTake(c, tenant, r, { refresh: req.query?.refresh === '1' }) : null;
      return res.status(200).json({ ok: true, salon: tenant.name, connection: conn,
        sync: { store: led.store, tables: led.store === 'tables', payments: Object.keys(led.payments || {}).length, orders: Object.keys(led.orders || {}).length, backfilled: !!led.backfilled, updated_at: led.updated_at || null, from: led.done_until ? null : null, clients: led.client_sync || null },
        insights: r, take });
    }
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'GET or POST' });

    if (body.action === 'sync') {
      if (!conn.connected) return res.status(400).json({ ok: false, error: 'Connect Square first (Settings → Square).' });
      const { squareRows } = await import('./lib/square-care.js');
      const integ = (await squareRows(c, { status: 'connected' })).find((x) => x.tenant_id === tenant.id);
      if (!integ) return res.status(400).json({ ok: false, error: 'Connect Square first (Settings → Square).' });
      const r = await sd.importSquareSales(c, integ, { budgetMs: 20000 });
      return res.status(200).json({ ok: true, ...r });
    }

    if (body.action === 'preview' || body.action === 'launch') {
      const r = await sd.squareInsights(c, tenant);
      const mv = (r.moves || []).find((m) => m.key === body.key);
      if (!mv) return res.status(404).json({ ok: false, error: 'That move is no longer suggested — refresh the page.' });
      if (!mv.segment) return res.status(400).json({ ok: false, error: 'This one is advice, not a text campaign.' });
      const m = await import('./lib/marketing.js');
      const tz = await m.tenantTz(tenant.id);
      const message = String(body.message || mv.message || '').trim();
      if (!message) return res.status(400).json({ ok: false, error: 'Write the text first.' });
      if (body.action === 'preview') {
        const a = await m.audience(c, tenant.id, mv.segment, { days: mv.days, tz });
        return res.status(200).json({ ok: true, count: a.recipients.length, capped: a.capped, sample: a.recipients.slice(0, 4).map((x) => x.first_name).filter(Boolean), sending_now: m.inSendingHours(new Date(), tz), message });
      }
      const made = await m.createCampaign(c, tenant, { name: mv.name, segment: mv.segment, days: mv.days, message, createdBy: 'lola-insights' });
      if (!made.ok) return res.status(400).json({ ok: false, error: made.error });
      const st = await m.startCampaign(c, tenant, made.campaign.id, { max: 15, deadline: Date.now() + 12000, tz });
      return res.status(200).json({ ok: true, total: made.total, first_batch: st.batch || null, sending_now: m.inSendingHours(new Date(), tz) });
    }
    return res.status(400).json({ ok: false, error: 'unknown action' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e).slice(0, 200) });
  }
}
