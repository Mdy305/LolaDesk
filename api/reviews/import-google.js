/**
 * /api/reviews/import-google — pull a tenant's REAL Google reviews into the
 * syndication queue (review_queue → branded cards → Facebook/Instagram).
 *
 * POST (authenticated, tenant-scoped): {} → { ok, fetched, scheduled, skipped }
 *
 * Uses the tenant's 'google_gmb' integration (OAuth'd via Settings →
 * Integrations → Google reviews). Reviews are filtered to 5-star + >10 chars
 * by the shared pipeline, deduped by sha-256, and staggered +48h apart — so
 * importing repeatedly is safe and never floods the feed.
 */

import { bearer, getUserFromToken } from '../lib/auth.js';
import { resolveTenantForUser } from '../lib/tenant-access.js';
import { db, getTenantIntegrations } from '../lib/db.js';
import { getConnector } from '../lib/aggregator.js';
import { scheduleReviews } from '../lib/review-syndication.js';

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if(req.method === 'OPTIONS') return res.status(204).end();
  if(req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  try{
    const user = await getUserFromToken(bearer(req));
    if(!user) return res.status(401).json({ ok: false, error: 'Not authenticated' });
    const tenant = await resolveTenantForUser(user);
    if(!tenant?.id) return res.status(404).json({ ok: false, error: 'No tenant found' });

    const client = db();
    if(!client) return res.status(503).json({ ok: false, error: 'Database not configured' });

    const integrations = await getTenantIntegrations(tenant.id);
    const gmb = integrations.find(i => i.provider === 'google_gmb' || i.provider === 'google');
    if(!gmb?.access_token) return res.status(400).json({ ok: false, error: 'Connect Google reviews first — Settings → Integrations → Google reviews.' });

    const connector = getConnector('google_gmb');
    const reviews = await connector.listReviews(gmb);

    if(!reviews.length) return res.status(200).json({ ok: true, fetched: 0, scheduled: 0, skipped: {}, note: 'No reviews on your Google Business Profile yet.' });

    const result = await scheduleReviews(client, tenant.id, 'google_gmb', reviews);
    if(!result.ok) return res.status(500).json(result);

    return res.status(200).json({
      ok: true,
      fetched: reviews.length,
      scheduled: result.scheduled,
      accepted: result.accepted,
      skipped: result.skipped,
      note: `${result.scheduled} of ${reviews.length} Google review(s) queued — cards post to Facebook/Instagram every 48h.`
    });
  }catch(e){
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
