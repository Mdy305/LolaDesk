/**
 * /api/reviews/card — render a review card PNG on the fly (preview).
 *
 * GET /api/reviews/card?author=Sarah&body=Incredible…&tenant=MMΛ Salon
 *   -> image/png, 1080x1080.
 *
 * This is the same renderer the publish cron uses, so what you see here is
 * byte-for-byte what gets posted to Meta.
 */

import { renderReviewCardPng } from '../lib/review-syndication.js';

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  if(req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try{
    const q = new URL(req.url, 'http://localhost').searchParams;
    const png = await renderReviewCardPng({
      author: q.get('author') || 'Happy client',
      body: q.get('body') || 'Best salon experience ever.',
      tenantName: q.get('tenant') || ''
    });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400');
    return res.status(200).send(png);
  }catch(e){
    console.error('[reviews/card]', e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
