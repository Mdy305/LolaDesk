// POST /api/widget-beacon { tenant, kind, snippet, source }
// Fire-and-forget telemetry from the onboarding flow (embed copy, previews, etc.).
// No auth — this is a metric ping, not user data. Rate-limited by IP+kind.
import { cors, jsonBody } from './lib/cors.js';
import { db } from './lib/db.js';

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(204).end();
  try {
    const { tenant, kind, snippet, source } = jsonBody(req);
    const c = db();
    await c.from('telemetry_events').insert({
      tenant_slug: tenant || null,
      kind: kind || 'unknown',
      snippet: snippet ? String(snippet).slice(0, 500) : null,
      source: source || null,
      ip: req.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || null,
      user_agent: req.headers?.['user-agent'] || null,
      created_at: new Date().toISOString()
    }).catch(() => {});
    return res.status(204).end();
  } catch {
    return res.status(204).end();
  }
}
