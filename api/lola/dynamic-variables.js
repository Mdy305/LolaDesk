// POST /api/lola/dynamic-variables
// Telnyx AI Assistant calls this at conversation start.
// Returns tenant-specific variables Telnyx substitutes into LolaBrain's prompt.
// Also injects the deep ingestion intelligence (strengths, hero services,
// FAQ, brand voice) so Lola sounds like she's worked at this salon for years.
import { db } from '../lib/db.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const to = body.to || body.To || null;
    const from = body.from || body.From || null;

    const fallback = {
      company_name: 'the salon',
      location: '',
      hours: '',
      booking_url: 'https://loladesk.com',
      services: '',
      staff: '',
      caller_brief: 'First-time caller',
      tenant_id: '',
      to: to || '',
      from: from || '',
      top_strengths: '',
      hero_services: '',
      hero_staff: '',
      brand_voice: '',
      faq_snippet: '',
      client_id: ''
    };

    if (!to) return res.status(200).json(fallback);

    const c = db();
    const { data: tn } = await c.from('tenant_numbers')
      .select('tenant_id').eq('phone_e164', to).maybeSingle();
    if (!tn?.tenant_id) return res.status(200).json(fallback);

    const [tenantRes, settingsRes, servicesRes, staffRes, faqRes] = await Promise.all([
      c.from('tenants').select('id, name, slug, location, business_profile').eq('id', tn.tenant_id).maybeSingle(),
      c.from('booking_settings').select('business_hours').eq('tenant_id', tn.tenant_id).maybeSingle(),
      c.from('services').select('name, price, duration_minutes').eq('tenant_id', tn.tenant_id).eq('active', true).order('sort_order', { ascending: true, nullsFirst: false }).limit(12),
      c.from('staff').select('first_name, last_name, name, role').eq('tenant_id', tn.tenant_id).eq('active', true).limit(10),
      c.from('knowledge_base').select('key, value').eq('tenant_id', tn.tenant_id).in('source', ['website_faq', 'gmb_qa']).limit(5)
    ]);

    const tenant = tenantRes.data || {};
    const bp = tenant.business_profile || {};

    // Deep caller memory.
    let caller_brief = 'First-time caller — no history.';
    let client_id = '';
    if (from) {
      const { data: cl } = await c.from('clients')
        .select('id, first_name, last_name, name, visit_count, no_show_count, birthday, notes, tags')
        .eq('tenant_id', tenant.id).eq('phone', from).maybeSingle();
      if (cl) {
        client_id = cl.id;
        const nm = (cl.first_name || cl.last_name) ? [cl.first_name, cl.last_name].filter(Boolean).join(' ') : cl.name;

        const [lastVisit, memories, profile, formula] = await Promise.all([
          c.from('appointments').select('start_time, notes').eq('tenant_id', tenant.id).eq('client_id', cl.id).eq('outcome', 'completed').order('start_time', { ascending: false }).limit(2),
          c.from('client_memory').select('key, value').eq('tenant_id', tenant.id).eq('client_id', cl.id).order('created_at', { ascending: false }).limit(5),
          c.from('client_profiles').select('preferences, communication_style, quirks').eq('tenant_id', tenant.id).eq('client_id', cl.id).maybeSingle(),
          c.from('client_formulas').select('service, formula').eq('tenant_id', tenant.id).eq('client_id', cl.id).order('updated_at', { ascending: false }).limit(1)
        ]);

        const lines = [`Returning client: ${nm}. Visits: ${cl.visit_count || 0}${cl.no_show_count ? ` (${cl.no_show_count} no-shows)` : ''}.`];
        if (lastVisit.data?.length) {
          const days = Math.floor((Date.now() - new Date(lastVisit.data[0].start_time).getTime()) / 86400000);
          lines.push(`Last visit ${days} days ago.${lastVisit.data[0].notes ? ' Notes: ' + lastVisit.data[0].notes : ''}`);
        }
        if (profile.data?.communication_style) lines.push(`Style: ${profile.data.communication_style}.`);
        if (profile.data?.preferences) lines.push(`Prefers: ${profile.data.preferences}.`);
        if (profile.data?.quirks) lines.push(`Note: ${profile.data.quirks}.`);
        if (formula.data?.length) lines.push(`Formula (${formula.data[0].service}): ${formula.data[0].formula}.`);
        if (cl.birthday) lines.push(`Birthday: ${cl.birthday}.`);
        if (cl.tags?.length) lines.push(`Tags: ${cl.tags.join(', ')}.`);
        if (memories.data?.length) {
          memories.data.slice(0, 3).forEach(m => lines.push(`• ${m.key}: ${m.value}`));
        }
        caller_brief = lines.join('\n');
      }
    }

    // Format for the prompt.
    const services = (servicesRes.data || []).map(s =>
      `${s.name}${s.price ? ` — $${s.price}` : ''}${s.duration_minutes ? ` (${s.duration_minutes} min)` : ''}`
    ).join(' • ');

    const hoursObj = settingsRes.data?.business_hours || {};
    const hours = ['mon','tue','wed','thu','fri','sat','sun'].map(d => {
      const h = hoursObj[d];
      if (!h || h.closed) return `${d}: closed`;
      return `${d}: ${h.open}–${h.close}`;
    }).join('; ');

    const staff = (staffRes.data || []).map(s =>
      (s.first_name || s.last_name) ? [s.first_name, s.last_name].filter(Boolean).join(' ') : s.name
    ).filter(Boolean).join(', ');

    // Ingestion intelligence — the "she's worked here for years" injection.
    const top_strengths = (bp.top_strengths || []).slice(0, 3)
      .map(s => s.theme || s).join(', ');
    const hero_services = (bp.hero_services || []).slice(0, 3)
      .map(s => s.name || s).join(', ');
    const hero_staff = (bp.hero_staff || []).slice(0, 3)
      .map(s => s.name || s).join(', ');
    const brand_voice = bp.brand_voice?.tone
      || (Array.isArray(bp.brand_voice?.adjectives) ? bp.brand_voice.adjectives.slice(0, 3).join(', ') : '');
    const faq_snippet = (faqRes.data || []).slice(0, 3)
      .map(f => `Q: ${f.key}\nA: ${f.value}`).join('\n\n');

    return res.status(200).json({
      company_name: tenant.name || 'the salon',
      location: tenant.location || bp.gbp_location?.address?.locality || '',
      hours,
      booking_url: `https://loladesk.com/book/${tenant.slug || tenant.id}`,
      services,
      staff,
      caller_brief,
      tenant_id: tenant.id || '',
      client_id,
      to: to || '',
      from: from || '',
      top_strengths,
      hero_services,
      hero_staff,
      brand_voice,
      faq_snippet
    });
  } catch (e) {
    return res.status(200).json({
      company_name: 'the salon', services: '', hours: '', staff: '',
      caller_brief: 'First-time caller', tenant_id: '', to: '', from: '',
      booking_url: 'https://loladesk.com', location: '', client_id: '',
      top_strengths: '', hero_services: '', hero_staff: '', brand_voice: '', faq_snippet: ''
    });
  }
}
