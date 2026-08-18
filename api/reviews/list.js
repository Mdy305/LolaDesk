/**
 * /api/reviews/list — tenant-scoped read of the review syndication queue.
 *
 * GET (authenticated, tenant-scoped):
 *   → { ok, counts: {queued,scheduled,published,failed}, reviews: [...] }
 *
 * Reviews are returned newest-first. The reviews.html page renders this so an
 * owner can see what is waiting to post, what has gone live, and any failures
 * (missing Meta credentials, expired token, storage error, …) without digging
 * through the database.
 */

import { bearer, getUserFromToken } from '../lib/auth.js';
import { resolveTenantForUser } from '../lib/tenant-access.js';
import { db } from '../lib/db.js';

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if(req.method === 'OPTIONS') return res.status(204).end();
  if(req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET only' });

  try{
    const user = await getUserFromToken(bearer(req));
    if(!user) return res.status(401).json({ ok: false, error: 'Not authenticated' });
    const tenant = await resolveTenantForUser(user);
    if(!tenant?.id) return res.status(404).json({ ok: false, error: 'No tenant found' });

    const client = db();
    if(!client) return res.status(503).json({ ok: false, error: 'Database not configured' });

    const { data: reviews, error } = await client.from('review_queue')
      .select('id, source, author_name, rating, review_body, image_url, status, scheduled_for, published_at, meta_post_id, error_message, created_at')
      .eq('tenant_id', tenant.id)
      .order('created_at', { ascending: false })
      .limit(200);

    if(error) return res.status(500).json({ ok: false, error: error.message });

    const counts = { queued: 0, scheduled: 0, published: 0, failed: 0 };
    for(const r of (reviews || [])){
      if(counts[r.status] !== undefined) counts[r.status]++;
    }

    return res.status(200).json({ ok: true, tenant: { name: tenant.name }, counts, reviews: reviews || [] });
  }catch(e){
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
