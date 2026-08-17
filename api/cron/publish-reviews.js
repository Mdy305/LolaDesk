/**
 * /api/cron/publish-reviews — Meta Graph API publish cron.
 *
 * Fired by Vercel Cron (see vercel.json `crons`). Requires the
 * CRON_SECRET env var: Vercel sends `Authorization: Bearer <CRON_SECRET>`
 * on cron GETs; we also accept POST with the same header for manual runs.
 *
 * For each due queue row (status scheduled/queued and scheduled_for <= now):
 *   1. resolve Meta credentials (per-tenant integration or env fallback)
 *   2. render + upload the card if it has no image_url yet
 *   3. publish to the Facebook page photo (and Instagram if configured)
 *   4. mark published (meta_post_id) or failed (error_message)
 */

import { db } from '../lib/db.js';
import { resolveMetaConfig, storeReviewCard, publishToMeta } from '../lib/review-syndication.js';

const BATCH = 20;

function authorized(req){
  const auth = req.headers.authorization || '';
  return auth === `Bearer ${process.env.CRON_SECRET}`;
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if(req.method === 'OPTIONS') return res.status(204).end();
  if(req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ ok: false, error: 'GET/POST only' });

  if(!process.env.CRON_SECRET){
    return res.status(503).json({ ok: false, error: 'CRON_SECRET is not set — publish cron is disabled' });
  }
  if(!authorized(req)){
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const client = db();
  if(!client) return res.status(503).json({ ok: false, error: 'Database not configured' });

  const { data: due, error } = await client.from('review_queue')
    .select('*')
    .in('status', ['scheduled', 'queued'])
    .lte('scheduled_for', new Date().toISOString())
    .order('scheduled_for')
    .limit(BATCH);

  if(error) return res.status(500).json({ ok: false, error: error.message });
  if(!due?.length) return res.status(200).json({ ok: true, published: 0, failed: 0, note: 'Nothing due' });

  let published = 0, failed = 0;
  const errors = [];

  for(const review of due){
    try{
      const { data: tenant } = await client.from('tenants').select('id,name').eq('id', review.tenant_id).maybeSingle();
      const config = await resolveMetaConfig(client, review.tenant_id);
      if(!config.accessToken || (!config.pageId && !config.igUserId)){
        throw new Error('Meta not configured — add a "meta" integration or META_ACCESS_TOKEN + META_PAGE_ID/META_IG_ID');
      }

      let imageUrl = review.image_url;
      if(!imageUrl) imageUrl = await storeReviewCard(client, tenant || { id: review.tenant_id, name: 'LolaDesk' }, review);

      const caption = `${review.review_body}\n\n— ${review.author_name} · ★★★★★`;
      const result = await publishToMeta(config, { imageUrl, caption });

      await client.from('review_queue').update({
        status: 'published',
        meta_post_id: result.postId,
        published_at: new Date().toISOString(),
        error_message: null
      }).eq('id', review.id);

      published++;
    }catch(e){
      failed++;
      const msg = String(e?.message || e);
      errors.push({ id: review.id, error: msg.slice(0, 200) });
      await client.from('review_queue').update({ status: 'failed', error_message: msg.slice(0, 500) }).eq('id', review.id);
    }
  }

  return res.status(200).json({ ok: true, published, failed, errors: errors.slice(0, 10) });
}
