/**
 * /api/reviews/gmb-reply — Lola auto-replies to Google reviews
 * ═══════════════════════════════════════════════════════════════════════════
 * Google retired Business Messages (chat from Maps/Search) on 2024-07-31, so
 * there is no API for "answering" Maps chats anymore. The ONE remaining
 * Google surface a business can automate is review replies
 * (accounts.locations.reviews.updateReply) — that is how Lola answers
 * customers on Google: every new review gets a warm, on-brand reply, and a
 * low rating gets a de-escalating path to the phone.
 *
 *   GET   → { ok, connected, auto_reply_gmb, recent[], note }
 *   POST  → reply to every unreplied review now → { ok, reviewed, replied,
 *           already, errors[] }  (deduped forever by review_id)
 *   PATCH → { auto_reply_gmb: bool } → per-salon opt-in toggle
 *
 * Needs the tenant's 'google_gmb' OAuth integration (Settings → Integrations →
 * Google reviews). Reply copy: Lola's persona via llm.js, with a deterministic
 * fallback so she never goes silent on a review.
 */

import { bearer, getUserFromToken } from '../lib/auth.js';
import { resolveTenantForUser } from '../lib/tenant-access.js';
import { db, getTenantIntegrations } from '../lib/db.js';
import { getConnector } from '../lib/aggregator.js';
import { chat } from '../lib/llm.js';

const MESSAGING_NOTE = 'Google retired Maps chat (Business Messages) on 2024-07-31 — review replies are the live way Lola answers customers on Google.';

async function draftReply(tenant, review){
  const first = String(review.author || '').split(' ')[0] || 'friend';
  const system = [
    `You are Lola, the AI front desk manager for ${tenant.name || 'this salon'}.`,
    'Write a short, warm, human public reply to a Google review.',
    'Rules: under two sentences; thank a positive reviewer by name and invite them back; for a negative review, acknowledge their experience sincerely, never argue or sound defensive, and mention they can call the salon to make it right; never invent details not in the review; no corporate filler like "we appreciate your feedback".'
  ].join(' ');
  const r = await chat({ system, messages: [{ role: 'user', content: review.body || 'Thank you!' }], maxTokens: 120, temperature: 0.6 });
  const text = (r.ok && r.text) ? r.text.trim() : '';
  if(text && text.length >= 10) return text;
  // Deterministic fallback — Lola never goes silent on a review.
  return Number(review.rating) >= 4
    ? `Thank you so much for the kind words, ${first}! We're thrilled you loved your visit — come back and see us anytime. — Lola, front desk of ${tenant.name}`
    : `Thank you for your feedback — we're sorry this visit didn't meet your expectations. Please call ${tenant.phone_number || 'the salon'} and we'll make it right. — Lola, front desk of ${tenant.name}`;
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if(req.method === 'OPTIONS') return res.status(204).end();

  try{
    const user = await getUserFromToken(bearer(req));
    if(!user) return res.status(401).json({ ok: false, error: 'Not authenticated' });
    const tenant = await resolveTenantForUser(user);
    if(!tenant?.id) return res.status(404).json({ ok: false, error: 'No tenant found' });
    const client = db();
    if(!client) return res.status(503).json({ ok: false, error: 'Database not configured' });

    const integrations = await getTenantIntegrations(tenant.id);
    const gmb = integrations.find(i => i.provider === 'google_gmb' || i.provider === 'google');
    const connected = Boolean(gmb?.access_token);

    // ── GET · state ────────────────────────────────────────────────
    if(req.method === 'GET'){
      const { data: recent } = await client.from('gmb_review_replies')
        .select('reviewer,rating,reply,posted_at')
        .eq('tenant_id', tenant.id)
        .order('posted_at', { ascending: false })
        .limit(10);
      return res.status(200).json({
        ok: true,
        connected,
        auto_reply_gmb: Boolean(tenant.auto_reply_gmb),
        recent: recent || [],
        note: connected ? MESSAGING_NOTE : 'Connect Google reviews first — Settings → Integrations → Google reviews.'
      });
    }

    // ── PATCH · per-salon opt-in toggle ────────────────────────────
    if(req.method === 'PATCH'){
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const value = body.auto_reply_gmb;
      if(typeof value !== 'boolean') return res.status(400).json({ ok: false, error: 'Send { auto_reply_gmb: true|false }' });
      const { error } = await client.from('tenants').update({ auto_reply_gmb: value }).eq('id', tenant.id);
      if(error) throw new Error('Could not save the toggle: ' + error.message);
      return res.status(200).json({ ok: true, auto_reply_gmb: value });
    }

    // ── POST · reply to every unreplied review now ─────────────────
    if(req.method === 'POST'){
      if(!gmb?.access_token) return res.status(400).json({ ok: false, error: 'Connect Google reviews first — Settings → Integrations → Google reviews.' });

      const connector = getConnector('google_gmb');
      const reviews = await connector.listReviews(gmb);
      if(!reviews.length) return res.status(200).json({ ok: true, reviewed: 0, replied: 0, already: 0, errors: [], note: 'No reviews on your Google Business Profile yet.' });

      const { data: logRows } = await client.from('gmb_review_replies').select('review_id').eq('tenant_id', tenant.id);
      const already = new Set((logRows || []).map(r => r.review_id));

      let replied = 0, errors = [];
      for(const review of reviews){
        if(!review.reviewId || already.has(review.reviewId)) continue;
        try{
          const reply = await draftReply(tenant, review);
          await connector.replyToReview(gmb, review.reviewId, reply);
          const { error } = await client.from('gmb_review_replies').insert({
            tenant_id: tenant.id,
            review_id: review.reviewId,
            rating: review.rating ?? null,
            reviewer: review.author || null,
            comment: review.body || null,
            reply
          });
          if(error) throw new Error(error.message);
          already.add(review.reviewId);
          replied += 1;
        }catch(e){
          errors.push({ reviewer: review.author, error: String(e?.message || e).slice(0, 160) });
        }
      }

      return res.status(200).json({
        ok: true,
        reviewed: reviews.length,
        replied,
        already: reviews.length - replied - errors.length,
        errors,
        note: `${replied} Google review(s) answered by Lola${errors.length ? ` · ${errors.length} failed — check the Google connection` : ''}.`
      });
    }

    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }catch(e){
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
