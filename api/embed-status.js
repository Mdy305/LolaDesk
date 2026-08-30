/**
 * GET /api/embed-status — "is my booking widget actually installed?"
 *
 * Authenticated (the signed-in salon's own data). Answers whether the
 * booking-widget.js has ever booted on a FOREIGN origin for this tenant —
 * i.e. a real embed, not the loladesk.com /book pages — and lists the
 * sites it was detected on. Powers the "installed" badge in the settings
 * Share & embed section.
 *
 *   GET /api/embed-status → {
 *     ok: true,
 *     installed: bool,
 *     hosts: [ { host, first_seen, last_seen, loads } ],
 *     loads, embedded_loads, first_party_loads
 *   }
 *
 * Reads:
 *   • usage_events — kind 'widget_load' for this tenant (30 days),
 *     metadata.host carries the page host where the widget booted
 */

import { bearer, getUserFromToken } from './lib/auth.js';
import { db } from './lib/db.js';
import { resolveTenantAccessForUser } from './lib/tenant-access.js';
import { classifyHost } from './lib/embed-usage.js';

const WINDOW_MS = 90 * 24 * 3600 * 1000;   // detection window: 90 days

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if(req.method === 'OPTIONS') return res.status(200).end();
  if(req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET only' });

  const user = await getUserFromToken(bearer(req));
  if(!user) return res.status(401).json({ ok: false, error: 'Not signed in' });

  const c = db();
  if(!c) return res.status(503).json({ ok: false, error: 'Database not configured' });

  try{
    const access = await resolveTenantAccessForUser(user);
    const tenant = access?.tenant;
    if(!tenant?.id) return res.status(200).json({ ok: true, installed: false, hosts: [], loads: 0, embedded_loads: 0, first_party_loads: 0, note: 'no_tenant' });

    const since = new Date(Date.now() - WINDOW_MS).toISOString();
    const { data: rows } = await c.from('usage_events')
      .select('metadata,created_at')
      .eq('tenant_id', tenant.id).eq('kind', 'widget_load')
      .gte('created_at', since)
      .limit(5000);

    const byHost = new Map(); // host → { host, first_seen, last_seen, loads }
    let loads = 0, embedded = 0, firstParty = 0;
    for(const r of (rows || [])){
      const meta = r.metadata || {};
      const h = String(meta.host || meta.origin || '').toLowerCase().replace(/^https?:\/\//, '').split('/')[0].trim();
      const bucket = classifyHost(meta.host, meta.origin);
      loads++;
      if(bucket === 'embedded') embedded++;
      else firstParty++;
      if(!h || bucket !== 'embedded') continue;
      const e = byHost.get(h) || { host: h, first_seen: r.created_at, last_seen: r.created_at, loads: 0 };
      e.loads++;
      if(r.created_at && new Date(r.created_at) < new Date(e.first_seen)) e.first_seen = r.created_at;
      if(r.created_at && new Date(r.created_at) > new Date(e.last_seen)) e.last_seen = r.created_at;
      byHost.set(h, e);
    }

    const hosts = [...byHost.values()].sort((a, b) => b.loads - a.loads);
    return res.status(200).json({
      ok: true,
      installed: hosts.length > 0,
      hosts,
      loads,
      embedded_loads: embedded,
      first_party_loads: firstParty
    });
  }catch(e){
    console.error('[embed-status]', e?.message || e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
