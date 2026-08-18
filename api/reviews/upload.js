/**
 * /api/reviews/upload — import reviews into the syndication queue.
 *
 * POST (authenticated, tenant-scoped):
 *   { source: 'google_gmb'|'yelp_csv'|'shopify'|'manual_csv',
 *     csv: "rating,author,review\n5,\"Sarah\",\"Incredible…\"" }
 *   — or —
 *   { source, rows: [{ rating, author, body }, …] }
 *
 * Filters to rating === 5 && body > 10 chars, flags sensitive data, de-dups
 * by sha-256, and staggers publication +48h apart.
 */

import { bearer, getUserFromToken } from '../lib/auth.js';
import { resolveTenantForUser } from '../lib/tenant-access.js';
import { db } from '../lib/db.js';
import { parseReviewCSV, scheduleReviews } from '../lib/review-syndication.js';

const SOURCES = ['google_gmb', 'yelp_csv', 'shopify', 'manual_csv', 'facebook'];

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

    const input = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const source = String(input.source || 'manual_csv').toLowerCase();
    if(!SOURCES.includes(source)) return res.status(400).json({ ok: false, error: `source must be one of ${SOURCES.join(', ')}` });

    let rows = input.rows;
    if(typeof input.csv === 'string' || typeof input.text === 'string'){
      const parsed = parseReviewCSV(input.csv ?? input.text);
      if(parsed.error) return res.status(400).json({ ok: false, error: parsed.error });
      rows = parsed.rows;
    }

    if(!Array.isArray(rows) || !rows.length) return res.status(400).json({ ok: false, error: 'No reviews found — send { rows } or { csv }.' });

    const result = await scheduleReviews(client, tenant.id, source, rows);
    if(!result.ok) return res.status(500).json(result);

    return res.status(200).json({
      ok: true,
      accepted: result.accepted,
      scheduled: result.scheduled,
      skipped: result.skipped,
      note: `${result.scheduled} review${result.scheduled === 1 ? '' : 's'} queued, published +48h apart. Connect Meta credentials for the cron to publish.`
    });
  }catch(e){
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
