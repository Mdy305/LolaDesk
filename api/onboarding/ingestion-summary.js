// GET /api/onboarding/ingestion-summary
// The "she knows your salon" reveal screen queries this to show the
// owner exactly what Lola learned during ingestion.
// Also useful for the ingestion progress screen — poll it every 2s.
import { cors } from '../lib/cors.js';
import { bearer, getUserFromToken } from '../lib/auth.js';
import { resolveTenantForUser } from '../lib/tenant-access.js';
import { db } from '../lib/db.js';

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  try {
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'not_authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no_tenant' });

    const c = db();

    const [tenantRow, services, staff, settings, gmbConn, gmbReviews, faq, gmbQA, intel] = await Promise.all([
      c.from('tenants').select('business_profile, ingested_url, ingested_at').eq('id', tenant.id).maybeSingle(),
      c.from('services').select('id, name, price, duration_min').eq('tenant_id', tenant.id).eq('active', true),
      c.from('staff').select('id, name, first_name, last_name, role').eq('tenant_id', tenant.id).eq('active', true),
      c.from('booking_settings').select('business_hours').eq('tenant_id', tenant.id).maybeSingle(),
      c.from('gmb_connections').select('id, location_name, connected_at').eq('tenant_id', tenant.id).maybeSingle(),
      c.from('gmb_reviews').select('rating', { count: 'exact', head: false }).eq('tenant_id', tenant.id),
      c.from('knowledge_base').select('id', { count: 'exact', head: true }).eq('tenant_id', tenant.id).eq('source', 'website_faq'),
      c.from('knowledge_base').select('id', { count: 'exact', head: true }).eq('tenant_id', tenant.id).eq('source', 'gmb_qa'),
      c.from('marketing_intelligence').select('insights').eq('tenant_id', tenant.id).eq('source', 'gmb_review_analysis').order('created_at', { ascending: false }).limit(1)
    ]);

    const bp = tenantRow.data?.business_profile || {};
    const svcCount = (services.data || []).length;
    const staffCount = (staff.data || []).length;
    const reviewCount = (gmbReviews.data || []).length;
    const avgRating = reviewCount
      ? (gmbReviews.data.reduce((s, r) => s + Number(r.rating || 0), 0) / reviewCount).toFixed(1)
      : null;
    const insights = intel.data?.[0]?.insights || {};

    // Ingestion status per source.
    const status = {
      website: {
        done: !!tenantRow.data?.ingested_url,
        url: tenantRow.data?.ingested_url || null,
        at: tenantRow.data?.ingested_at || null
      },
      services: { done: svcCount > 0, count: svcCount },
      staff: { done: staffCount > 0, count: staffCount },
      hours: { done: !!settings.data?.business_hours },
      faq: { done: (faq.count || 0) > 0, count: faq.count || 0 },
      gmb: {
        connected: !!gmbConn.data,
        location: gmbConn.data?.location_name || null,
        reviews_ingested: reviewCount,
        avg_rating: avgRating,
        analyzed: !!insights.top_strengths,
        qa_ingested: gmbQA.count || 0
      }
    };

    const overall_complete =
      status.website.done &&
      status.services.done &&
      status.staff.done &&
      status.hours.done;

    // The "she knows your salon" reveal payload.
    const summary = {
      overall_complete,
      status,
      salon: {
        name: tenant.name,
        services_learned: svcCount,
        staff_learned: staffCount,
        hours_learned: !!settings.data?.business_hours,
        faq_learned: faq.count || 0,
        reviews_read: reviewCount,
        avg_rating: avgRating
      },
      what_clients_love: insights.top_strengths || [],
      what_clients_wish: insights.top_concerns || [],
      hero_services: insights.hero_services || bp.hero_services || [],
      hero_staff: insights.hero_staff || bp.hero_staff || [],
      brand_voice: bp.brand_voice || null,
      aesthetic: bp.aesthetic || null,
      sentiment_summary: insights.sentiment_summary || null,
      first_opportunities: buildOpportunityHints({
        reviewCount, avgRating,
        strengths: insights.top_strengths || [],
        concerns: insights.top_concerns || []
      })
    };

    return res.json({ ok: true, summary });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}

// Small heuristic — the real Growth agent will do the heavy lifting.
// These are the first "opportunity cards" shown right after onboarding.
function buildOpportunityHints({ reviewCount, avgRating, strengths, concerns }) {
  const out = [];
  if (reviewCount >= 20 && Number(avgRating) >= 4.5) {
    const top = strengths[0];
    if (top?.theme) {
      out.push({
        kind: 'strength_leverage',
        title: `Leverage what clients love: ${top.theme}`,
        detail: `${top.mention_count || 'Many'} clients mention this by name. Post 3 reels + a GMB post spotlighting this.`
      });
    }
  }
  if (concerns.length) {
    const worst = concerns[0];
    if (worst?.theme) {
      out.push({
        kind: 'concern_fix',
        title: `Address recurring feedback: ${worst.theme}`,
        detail: `${worst.mention_count || 'Several'} clients raised this. Lola can flag it whenever it comes up on calls.`
      });
    }
  }
  if (reviewCount === 0) {
    out.push({
      kind: 'review_seed',
      title: 'Ask returning clients for their first Google review',
      detail: 'Lola will invite the next 20 completed appointments to leave a review via SMS.'
    });
  }
  return out;
}
