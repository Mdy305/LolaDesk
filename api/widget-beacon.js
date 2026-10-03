// POST /api/widget-beacon { tenant, kind, snippet, source }
// Fire-and-forget telemetry from the onboarding flow (embed copy, previews, etc.)
// and the booking widget's load ping. The widget sends navigator.sendBeacon()
// with URL params (?tenant=&kind=&origin=&host=) and an empty body, so fields
// are read from the JSON body first, then the query string.
// No auth — this is a metric ping, not user data.
import { cors, jsonBody } from './lib/cors.js';
import { db } from './lib/db.js';

const str = (v, n) => (v == null || v === '' ? null : String(v).slice(0, n));

export function beaconFields(req) {
  const b = jsonBody(req) || {};
  const q = req.query || {};
  let url = {};
  try { const u = new URL(req.url || '', 'http://x'); url = Object.fromEntries(u.searchParams.entries()); } catch (_) {}
  const get = (k) => (b[k] != null && b[k] !== '' ? b[k] : (q[k] != null && q[k] !== '' ? q[k] : url[k]));
  return {
    tenant: str(get('tenant'), 120),
    kind: str(get('kind'), 60) || 'unknown',
    snippet: str(get('snippet'), 500),
    // The widget reports where it was loaded (origin/host); onboarding sends `source`.
    source: str(get('source') || get('host') || get('origin'), 300),
  };
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(204).end();
  try {
    const f = beaconFields(req);
    const c = db();
    if (c) {
      await Promise.resolve(c.from('telemetry_events').insert({
        tenant_slug: f.tenant,
        kind: f.kind,
        snippet: f.snippet,
        source: f.source,
        ip: req.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || null,
        user_agent: req.headers?.['user-agent'] || null,
        created_at: new Date().toISOString()
      })).catch(() => {});
    }
    return res.status(204).end();
  } catch {
    return res.status(204).end();
  }
}
