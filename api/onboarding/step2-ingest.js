// POST /api/onboarding/step2-ingest { websiteUrl }
// Fetches the salon's website and asks Kimi (via Telnyx AI Inference) to
// extract services, hours, and staff so Lola knows the business from day one.
// Non-blocking — the wizard fires this and continues; results merge into
// tenant.business_profile in the background.
import { cors, jsonBody } from '../lib/cors.js';
import { bearer, getUserFromToken } from '../lib/auth.js';
import { resolveTenantForUser } from '../lib/tenant-access.js';
import { db } from '../lib/db.js';
import { chatJson } from '../lib/telnyx-inference.js';

async function fetchPage(url) {
  const r = await fetch(url, {
    headers: { 'User-Agent': 'LolaDesk/1.0 (+https://loladesk.com)' },
    redirect: 'follow'
  });
  if (!r.ok) throw new Error('fetch_failed: ' + r.status);
  const html = await r.text();
  return html.slice(0, 60000);
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function extractWithKimi(text, tenantName) {
  const system = `You extract structured salon business info from unstructured web copy.
Return ONLY valid JSON, no prose, no fences. Use null for anything not stated.
Keep the services list to the top 12.`;

  const user = `Extract this salon's public business info from the text below.
Shape:
{
  "services": [{"name": "...", "price": null, "duration_min": null, "category": null}],
  "hours": {"mon":{"open":"HH:MM","close":"HH:MM","closed":false},"tue":{...},"wed":{...},"thu":{...},"fri":{...},"sat":{...},"sun":{...}},
  "staff": [{"name":"...", "role":"..."}],
  "address": "...",
  "phone": "...",
  "notes": "..."
}

BUSINESS: ${tenantName}
TEXT:
${text.slice(0, 12000)}`;

  return chatJson({ system, user, max_tokens: 1500, temperature: 0.1 });
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

    // Non-blocking response — fire the ingest and don't hold the wizard.
    res.json({ ok: true, queued: true });

    // Do the work after responding.
    try {
      const url = websiteUrl.startsWith('http') ? websiteUrl : 'https://' + websiteUrl;
      const html = await fetchPage(url);
      const text = stripHtml(html);
      const extracted = await extractWithKimi(text, tenant.name);
      if (!extracted) return;

      const c = db();
      await c.from('tenants').update({
        business_profile: extracted,
        ingested_url: url,
        ingested_at: new Date().toISOString()
      }).eq('id', tenant.id);

      // Seed services if we extracted any and the tenant has none.
      const { data: existingServices } = await c.from('services').select('id').eq('tenant_id', tenant.id).limit(1);
      if ((existingServices || []).length === 0 && Array.isArray(extracted.services)) {
        for (const s of extracted.services.slice(0, 12)) {
          if (!s.name) continue;
          await c.from('services').insert({
            tenant_id: tenant.id,
            name: s.name,
            price: s.price || 0,
            duration_min: s.duration_min || 60,
            category: s.category || null,
            active: true
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
