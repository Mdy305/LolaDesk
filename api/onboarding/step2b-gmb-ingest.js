// POST /api/onboarding/step2b-gmb-ingest
// Reads the tenant's gmb_connections row for OAuth token, fetches Google
// Business Profile info + reviews + Q&A, uses Kimi to extract sentiment
// intelligence, and writes to gmb_reviews + marketing_intelligence +
// tenants.business_profile.
//
// This is where "Lola knows what clients love" becomes real.
import { cors } from '../lib/cors.js';
import { bearer, getUserFromToken } from '../lib/auth.js';
import { resolveTenantForUser } from '../lib/tenant-access.js';
import { db } from '../lib/db.js';
import { chatJson } from '../lib/telnyx-inference.js';

const GBP = 'https://mybusiness.googleapis.com/v4';
const ACC = 'https://mybusinessaccountmanagement.googleapis.com/v1';

async function gcall(url, token) {
  const r = await fetch(url, {
    headers: { 'Authorization': 'Bearer ' + token }
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`GBP ${r.status}: ${j?.error?.message || r.statusText}`);
  return j;
}

async function refreshTokenIfNeeded(c, conn) {
  if (!conn.expires_at) return conn.access_token;
  const expiresMs = new Date(conn.expires_at).getTime();
  if (expiresMs > Date.now() + 60000) return conn.access_token;
  // Refresh
  if (!conn.refresh_token) throw new Error('token_expired_no_refresh');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      refresh_token: conn.refresh_token,
      grant_type: 'refresh_token'
    })
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`refresh failed: ${j?.error_description || r.statusText}`);
  const newExp = new Date(Date.now() + (Number(j.expires_in) || 3600) * 1000).toISOString();
  await c.from('gmb_connections').update({
    access_token: j.access_token,
    expires_at: newExp
  }).eq('id', conn.id);
  return j.access_token;
}

async function analyzeReviews({ reviews, tenantName }) {
  if (!reviews.length) return null;
  const sample = reviews.slice(0, 100).map(r =>
    `[${r.starRating || r.rating || '?'}★] ${(r.comment || '').slice(0, 500)}`
  ).join('\n---\n');

  const system = `You analyze Google reviews for a salon and return marketing intelligence.
Return ONLY valid JSON, no prose, no fences.`;

  const user = `Analyze these ${reviews.length} Google reviews for ${tenantName}.
Return:
{
  "top_strengths": [
    {"theme": "...", "mention_count": 0, "sample_quote": "..."}
  ],
  "top_concerns": [
    {"theme": "...", "mention_count": 0, "sample_quote": "..."}
  ],
  "hero_services": [
    {"name": "...", "mention_count": 0}
  ],
  "hero_staff": [
    {"name": "...", "mention_count": 0}
  ],
  "common_questions": ["..."],
  "brand_voice_from_replies": null,
  "sentiment_summary": "one sentence overall read",
  "avg_rating": 0
}

REVIEWS:
${sample.slice(0, 30000)}`;

  return chatJson({ system, user, max_tokens: 2000, temperature: 0.2 });
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  try {
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'not_authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no_tenant' });

    const c = db();

    const { data: conn } = await c.from('gmb_connections')
      .select('*')
      .eq('tenant_id', tenant.id)
      .maybeSingle();

    if (!conn?.access_token) {
      return res.status(400).json({
        ok: false,
        error: 'gmb_not_connected',
        hint: 'Connect Google Business Profile via /api/oauth/google/start first.'
      });
    }

    // Fast ack — do the work async.
    res.json({ ok: true, queued: true });

    try {
      const token = await refreshTokenIfNeeded(c, conn);
      const accountName = conn.account_name; // e.g. accounts/1234567890
      const locationName = conn.location_name; // e.g. accounts/xxx/locations/yyy
      if (!accountName || !locationName) throw new Error('missing_gbp_location');

      // 1. Fetch location info.
      const loc = await gcall(
        `https://mybusinessbusinessinformation.googleapis.com/v1/${locationName}?readMask=title,storefrontAddress,categories,regularHours,phoneNumbers,websiteUri`,
        token
      );

      // 2. Fetch reviews (paged, up to 200).
      let reviews = [];
      let pageToken = null;
      for (let i = 0; i < 5 && reviews.length < 200; i++) {
        const url = `${GBP}/${locationName}/reviews?pageSize=50${pageToken ? '&pageToken=' + pageToken : ''}`;
        const page = await gcall(url, token);
        if (Array.isArray(page.reviews)) reviews = reviews.concat(page.reviews);
        pageToken = page.nextPageToken;
        if (!pageToken) break;
      }

      // 3. Fetch Q&A.
      let questions = [];
      try {
        const qa = await gcall(`${GBP}/${locationName}/questions?pageSize=25`, token);
        questions = qa.questions || [];
      } catch {}

      // 4. Save raw reviews.
      for (const r of reviews) {
        await c.from('gmb_reviews').upsert({
          tenant_id: tenant.id,
          gmb_review_id: r.reviewId || r.name,
          reviewer_name: r.reviewer?.displayName || null,
          rating: r.starRating || null,
          comment: r.comment || null,
          reply: r.reviewReply?.comment || null,
          create_time: r.createTime || null,
          update_time: r.updateTime || null
        }, { onConflict: 'gmb_review_id' }).catch(() => {});
      }

      // 5. Analyze via Kimi.
      const intel = await analyzeReviews({ reviews, tenantName: tenant.name });

      // 6. Save analysis to marketing_intelligence.
      if (intel) {
        await c.from('marketing_intelligence').insert({
          tenant_id: tenant.id,
          source: 'gmb_review_analysis',
          insights: intel,
          created_at: new Date().toISOString()
        }).catch(() => {});

        // 7. Merge hero_services/staff + strengths into business_profile.
        const { data: t } = await c.from('tenants').select('business_profile').eq('id', tenant.id).maybeSingle();
        const bp = t?.business_profile || {};
        await c.from('tenants').update({
          business_profile: {
            ...bp,
            gmb_avg_rating: intel.avg_rating || null,
            gmb_review_count: reviews.length,
            hero_services: intel.hero_services || [],
            hero_staff: intel.hero_staff || [],
            top_strengths: intel.top_strengths || [],
            top_concerns: intel.top_concerns || [],
            gmb_ingested_at: new Date().toISOString(),
            gbp_location: {
              title: loc.title,
              address: loc.storefrontAddress,
              phone: loc.phoneNumbers?.primaryPhone,
              website: loc.websiteUri,
              categories: loc.categories
            }
          }
        }).eq('id', tenant.id);
      }

      // 8. Seed common questions from Q&A into knowledge_base.
      for (const q of questions.slice(0, 15)) {
        const qText = q.text?.slice(0, 300);
        const aText = q.topAnswers?.[0]?.text?.slice(0, 800);
        if (!qText) continue;
        await c.from('knowledge_base').insert({
          tenant_id: tenant.id,
          source: 'gmb_qa',
          key: qText,
          value: aText || '',
          metadata: { question_id: q.name }
        }).catch(() => {});
      }
    } catch (err) {
      console.error('gmb ingest failed', err?.message);
    }
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
