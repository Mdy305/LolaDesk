// api/onboarding/step2-ingest.js - Auto-analyze business data
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import cheerio from 'cheerio';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { websiteUrl, gmbUrl, instagramUrl, tenantId } = req.body;
  let dataPoints = 0;
  let results = {};

  try {
    // 1. SCRAPE WEBSITE
    if (websiteUrl) {
      try {
        const response = await axios.get(websiteUrl, { timeout: 10000 });
        const $ = cheerio.load(response.data);

        const services = [];
        $('[data-service], .service, .pricing').each((i, el) => {
          const name = $(el).find('.name, .title, h3').text().trim();
          const price = $(el).find('.price').text().trim();
          if (name) services.push({ name, price });
        });

        const team = [];
        $('[data-team], .team, .staff').each((i, el) => {
          const name = $(el).find('.name, h3').text().trim();
          const role = $(el).find('.role').text().trim();
          if (name) team.push({ name, role });
        });

        results.website = { services: services.slice(0, 50), team: team.slice(0, 20) };
        dataPoints += services.length + team.length;
      } catch (e) {
        console.error('[INGEST] Website error:', e.message);
      }
    }

    // 2. PARSE GOOGLE MY BUSINESS
    if (gmbUrl) {
      try {
        const response = await axios.get(gmbUrl, { timeout: 10000 });
        const $ = cheerio.load(response.data);

        const rating = parseFloat($('[data-rating], .rating').first().text());
        const reviewCount = parseInt($('[data-reviews], .review-count').text());

        results.gmb = { rating: rating || 0, reviewCount: reviewCount || 0 };
        dataPoints += 2;
      } catch (e) {
        console.error('[INGEST] GMB error:', e.message);
      }
    }

    // 3. STORE IN SUPABASE
    await supabase.from('tenant_memories').upsert({
      tenant_id: tenantId,
      memory_type: 'business_data',
      memory_key: 'ingested',
      value: results,
      source: 'onboarding',
    });

    await supabase.from('tenants').update({ status: 'onboarding_step2' }).eq('id', tenantId);

    res.json({ ok: true, dataPoints, ...results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
