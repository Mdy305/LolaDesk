/**
 * GET|POST /api/widget-beacon — silent embed-usage telemetry.
 *
 * Answers "which salons actually put the widget on their site":
 *   - widget_load:    fired by booking-widget.js every time it boots on ANY
 *                     page (first-party /book pages AND foreign embedded sites)
 *   - embed_copied:   a salon copied their embed snippet (settings/onboarding)
 *   - embed_preview:  a salon opened the live preview / booking link
 *
 * No auth: the widget runs on third-party sites. Rows land in usage_events
 * (kind is free-form there) with the host/origin so first-party loads are
 * distinguishable from real embeds. The demo tenant is never logged.
 *
 * Beacon from the widget:  navigator.sendBeacon('/api/widget-beacon?tenant=SLUG&kind=widget_load&origin=…')
 * Beacon from the dashboard: same endpoint, POST JSON body.
 */

import { getTenantBySlug, logUsage } from './lib/db.js';

const DEMO_TENANT_ID = '00000000-0000-0000-0000-000000000000';
const VALID_KINDS = new Set(['widget_load', 'embed_copied', 'embed_preview']);

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if(req.method === 'OPTIONS') return res.status(204).end();

  try{
    let body = {};
    if(req.method === 'POST' && req.body){
      try{ body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body; }
      catch{ body = {}; }
    }
    const params = { ...(req.query || {}), ...body };
    const tenant = params.tenant || params.slug || '';
    const kind = String(params.kind || 'widget_load').slice(0, 40);
    if(!VALID_KINDS.has(kind)) return res.status(200).json({ ok: true }); // silently ignore junk
    if(!tenant) return res.status(200).json({ ok: true });

    const t = await getTenantBySlug(tenant);
    if(!t || !t.id || t.id === DEMO_TENANT_ID) return res.status(200).json({ ok: true }); // never log the demo

    await logUsage(t.id, kind, 1, {
      slug: t.slug || null,
      host: String(params.host || (req.headers && req.headers.host) || '').slice(0, 120),
      origin: String(params.origin || params.referrer || '').slice(0, 300),
      path: String(params.path || '').slice(0, 200),
      snippet: String(params.snippet || '').slice(0, 20),
      source: String(params.source || 'widget').slice(0, 20),
      ua: String((req.headers && req.headers['user-agent']) || '').slice(0, 120)
    });
    return res.status(200).json({ ok: true });
  }catch(e){
    // Beacons must never break the page or widget — swallow everything.
    return res.status(200).json({ ok: true });
  }
}
