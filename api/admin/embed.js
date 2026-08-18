/**
 * /api/admin/embed — widget adoption for the platform operator.
 * ════════════════════════════════════════════════════════════════
 * Answers "which salons actually put the booking widget on their site":
 * widget_load events from usage_events (30 days), split into EMBEDDED
 * (the widget booted on a foreign domain — a real install) vs FIRST-PARTY
 * (loladesk.com /book pages), plus how often each salon copied the snippet.
 *
 * Hard-gated exactly like /api/admin: the session's email must be in
 * ADMIN_EMAILS. No env var → nobody is admin → 403.
 *
 *   GET /api/admin/embed → { ok, since, totals, tenants:[…] }
 *
 * Reads:
 *   • usage_events — kind 'widget_load' and 'embed_copied', metadata.host
 *                    carries the page host where the widget booted
 */

import { bearer, getUserFromToken, isAdminEmail } from '../lib/auth.js';
import { db } from '../lib/db.js';
import { classifyHost } from '../lib/embed-usage.js';

const WINDOW_MS = 30 * 24 * 3600 * 1000;   // look at the last 30 days
const MAX_ROWS = 10000;


async function snapshot(c){
  const since = new Date(Date.now() - WINDOW_MS).toISOString();

  const [tenants, loads, copies] = await Promise.all([
    c.from('tenants')
      .select('id,slug,name,plan,billing_status,created_at')
      .order('created_at', { ascending: false }).limit(500)
      .then(r => r.data || []),
    c.from('usage_events')
      .select('tenant_id,metadata')
      .eq('kind', 'widget_load').gte('created_at', since)
      .limit(MAX_ROWS)
      .then(r => r.data || []),
    c.from('usage_events')
      .select('tenant_id')
      .eq('kind', 'embed_copied').gte('created_at', since)
      .limit(MAX_ROWS)
      .then(r => r.data || [])
  ]);

  const byId = new Map(tenants.map(t => [t.id, t]));
  const agg = new Map(); // tenant_id → { loads, embedded, first_party, copied }

  for(const row of loads){
    const meta = row.metadata || {};
    const bucket = classifyHost(meta.host, meta.origin);
    let e = agg.get(row.tenant_id);
    if(!e){ e = { loads: 0, embedded: 0, first_party: 0, copied: 0 }; agg.set(row.tenant_id, e); }
    e.loads++;
    if(bucket === 'embedded') e.embedded++;
    else e.first_party++;
  }
  for(const row of copies){
    let e = agg.get(row.tenant_id);
    if(!e){ e = { loads: 0, embedded: 0, first_party: 0, copied: 0 }; agg.set(row.tenant_id, e); }
    e.copied++;
  }

  const tenantsOut = [...agg.entries()].map(([tid, e]) => {
    const t = byId.get(tid) || {};
    return {
      tenant_id: tid,
      slug: t.slug || null,
      name: t.name || null,
      plan: t.plan || '—',
      billing_status: t.billing_status || 'trial',
      widget_loads: e.loads,
      embedded: e.embedded,
      first_party: e.first_party,
      embed_ratio_pct: e.loads ? Math.round((e.embedded / e.loads) * 100) : 0,
      snippet_copies: e.copied
    };
  });
  tenantsOut.sort((a, b) => b.widget_loads - a.widget_loads);

  const totals = tenantsOut.reduce((acc, t) => {
    acc.widget_loads += t.widget_loads;
    acc.embedded += t.embedded;
    acc.first_party += t.first_party;
    acc.snippet_copies += t.snippet_copies;
    return acc;
  }, { widget_loads: 0, embedded: 0, first_party: 0, snippet_copies: 0 });
  totals.salons_embedding = tenantsOut.filter(t => t.embedded > 0).length;

  return { since, totals, tenants: tenantsOut };
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if(req.method === 'OPTIONS') return res.status(200).end();
  if(req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET only' });

  const user = await getUserFromToken(bearer(req));
  if(!user) return res.status(401).json({ ok: false, error: 'Not signed in' });
  if(!isAdminEmail(user.email)) return res.status(403).json({ ok: false, error: 'Not authorized' });

  const c = db();
  if(!c) return res.status(503).json({ ok: false, error: 'Database not configured' });

  try{
    const snap = await snapshot(c);
    return res.status(200).json({ ok: true, ...snap });
  }catch(e){
    console.error('[admin/embed]', e?.message || e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
