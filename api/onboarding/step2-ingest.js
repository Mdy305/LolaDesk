// POST /api/onboarding/step2-ingest { websiteUrl }
// Multi-page website scan → Kimi extraction → structured salon intelligence.
// Enhanced from the single-page version: crawls homepage + follows likely
// links (services, staff, about, faq, pricing, booking) and combines them
// into one corpus before extraction.
//
// Writes to: services, staff, booking_settings, knowledge_base, and
// tenants.business_profile — populating everything Lola and the Growth
// agent need to sound like they've worked there for years.
import { cors, jsonBody } from '../lib/cors.js';
import { bearer, getUserFromToken } from '../lib/auth.js';
import { resolveTenantForUser } from '../lib/tenant-access.js';
import { db } from '../lib/db.js';
import { chatJson } from '../lib/telnyx-inference.js';

const PAGE_HINTS = [
  '/', '/services', '/service', '/menu', '/pricing', '/prices',
  '/team', '/stylists', '/staff', '/artists', '/about', '/about-us',
  '/faq', '/faqs', '/policies', '/booking', '/book'
];

async function fetchPage(url) {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'LolaDesk/1.0 (+https://loladesk.com)' },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000)
    });
    if (!r.ok) return null;
    const html = await r.text();
    return html.slice(0, 100000);
  } catch { return null; }
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

async function crawlSite(baseUrl) {
  const seen = new Set();
  const corpus = [];

  for (const hint of PAGE_HINTS) {
    const url = new URL(hint, baseUrl).toString();
    if (seen.has(url)) continue;
    seen.add(url);
    const html = await fetchPage(url);
    if (!html) continue;
    const text = stripHtml(html);
    if (text.length < 100) continue;
    corpus.push(`\n\n=== PAGE: ${hint} ===\n${text.slice(0, 15000)}`);
    if (corpus.join('').length > 60000) break;
  }
  return corpus.join('\n');
}

async function extractSalon(text, tenantName) {
  const system = `You extract structured salon business intelligence from web copy.
Return ONLY valid JSON, no prose, no markdown fences. Use null for anything not stated.
Be conservative — do not invent prices, hours, or services.`;

  const user = `Extract this salon's public info from the multi-page text below.
Shape:
{
  "services": [
    {"name": "...", "price": null, "duration_min": null, "category": null, "description": null}
  ],
  "staff": [
    {"name": "...", "role": "...", "bio_snippet": null, "specialties": []}
  ],
  "hours": {
    "mon":{"open":"HH:MM","close":"HH:MM","closed":false},
    "tue":{"open":"HH:MM","close":"HH:MM","closed":false},
    "wed":{"open":"HH:MM","close":"HH:MM","closed":false},
    "thu":{"open":"HH:MM","close":"HH:MM","closed":false},
    "fri":{"open":"HH:MM","close":"HH:MM","closed":false},
    "sat":{"open":"HH:MM","close":"HH:MM","closed":false},
    "sun":{"open":"HH:MM","close":"HH:MM","closed":true}
  },
  "policies": {
    "deposit_required": null,
    "cancellation_window_hours": null,
    "no_show_fee": null
  },
  "brand_voice": {
    "adjectives": [],
    "tone": null,
    "signature_phrases": []
  },
  "faq": [
    {"question": "...", "answer": "..."}
  ],
  "aesthetic": {
    "colors": [],
    "vibe": null,
    "clientele": null
  },
  "address": null,
  "phone": null,
  "instagram_handle": null,
  "notes": null
}

Keep services to top 15, staff to top 10, faq to top 10.

BUSINESS: ${tenantName}

CORPUS:
${text.slice(0, 45000)}`;

  return chatJson({ system, user, max_tokens: 3000, temperature: 0.1 });
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  try {
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'not_authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no_tenant' });

    const { websiteUrl } = jsonBody(req);
    if (!websiteUrl) return res.status(400).json({ ok: false, error: 'missing_url' });

    // Respond fast — do the work async.
    res.json({ ok: true, queued: true });

    try {
      const baseUrl = websiteUrl.startsWith('http') ? websiteUrl : 'https://' + websiteUrl;
      const corpus = await crawlSite(baseUrl);
      if (!corpus || corpus.length < 200) {
        console.error('ingest: corpus too small', baseUrl);
        return;
      }
      const extracted = await extractSalon(corpus, tenant.name);
      if (!extracted) {
        console.error('ingest: kimi returned no json');
        return;
      }

      const c = db();

      // 1. Save the whole extraction to business_profile.
      await c.from('tenants').update({
        business_profile: {
          ...extracted,
          ingested_source: 'website',
          ingested_url: baseUrl,
          ingested_at: new Date().toISOString()
        },
        ingested_url: baseUrl,
        ingested_at: new Date().toISOString()
      }).eq('id', tenant.id);

      // 2. Seed services table.
      const { data: existingSvc } = await c.from('services').select('id').eq('tenant_id', tenant.id).limit(1);
      if ((existingSvc || []).length === 0 && Array.isArray(extracted.services)) {
        for (const s of extracted.services.slice(0, 15)) {
          if (!s.name) continue;
          await c.from('services').insert({
            tenant_id: tenant.id,
            name: s.name,
            price: s.price || 0,
            duration_min: s.duration_min || 60,
            category: s.category || null,
            description: s.description || null,
            active: true
          }).catch(() => {});
        }
      }

      // 3. Seed staff table.
      const { data: existingStaff } = await c.from('staff').select('id').eq('tenant_id', tenant.id).limit(1);
      if ((existingStaff || []).length === 0 && Array.isArray(extracted.staff)) {
        for (const s of extracted.staff.slice(0, 10)) {
          if (!s.name) continue;
          const parts = String(s.name).split(' ');
          await c.from('staff').insert({
            tenant_id: tenant.id,
            first_name: parts[0] || null,
            last_name: parts.slice(1).join(' ') || null,
            name: s.name,
            role: s.role || 'Stylist',
            active: true
          }).catch(() => {});
        }
      }

      // 4. Save hours to booking_settings.
      if (extracted.hours) {
        await c.from('booking_settings').upsert({
          tenant_id: tenant.id,
          business_hours: extracted.hours
        }, { onConflict: 'tenant_id' }).catch(() => {});
      }

      // 5. Seed FAQ into knowledge_base (if the table + shape support it).
      if (Array.isArray(extracted.faq) && extracted.faq.length) {
        for (const item of extracted.faq.slice(0, 10)) {
          if (!item.question) continue;
          await c.from('knowledge_base').insert({
            tenant_id: tenant.id,
            source: 'website_faq',
            key: item.question.slice(0, 200),
            value: item.answer || '',
            metadata: { url: baseUrl }
          }).catch(() => {});
        }
      }
    } catch (err) {
      console.error('ingest failed', err?.message);
    }
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
