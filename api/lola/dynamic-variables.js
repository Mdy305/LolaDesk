// POST /api/lola/dynamic-variables
// Telnyx AI Assistant calls this at conversation start.
// Every value in the response is coerced to a plain string —
// Telnyx rejects null / undefined / objects during save validation.
import { db } from '../lib/db.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const emptyPayload = () => ({
    company_name: 'the salon',
    location: '',
    hours: '',
    booking_url: 'https://loladesk.com',
    services: '',
    staff: '',
    caller_brief: 'First-time caller',
    tenant_id: '',
    client_id: '',
    to: '',
    from: '',
    top_strengths: '',
    hero_services: '',
    hero_staff: '',
    brand_voice: '',
    faq_snippet: '',
    memories: ''
  });

  const forceStrings = (obj) => {
    const out = {};
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      out[k] = (v === null || v === undefined) ? '' : String(v);
    }
    return out;
  };

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const to = body.to || body.To || '';
    const from = body.from || body.From || '';

    if (!to) {
      const p = emptyPayload();
      p.to = to;
      p.from = from;
      return res.status(200).json(forceStrings(p));
    }

    const c = db();
    const { data: tn } = await c.from('tenant_numbers')
      .select('tenant_id').eq('phone_e164', to).maybeSingle();
    if (!tn?.tenant_id) {
      const p = emptyPayload();
      p.to = to;
      p.from = from;
      return res.status(200).json(forceStrings(p));
    }

    const [tenantRes, settingsRes, servicesRes, staffRes, faqRes] = await Promise.all([
      c.from('tenants').select('id, name, slug, location, business_profile').eq('id', tn.tenant_id).maybeSingle(),
      c.from('booking_settings').select('business_hours').eq('tenant_id', tn.tenant_id).maybeSingle(),
      c.from('services').select('name, price, duration_minutes').eq('tenant_id', tn.tenant_id).eq('active', true).order('sort_order', { ascending: true, nullsFirst: false }).limit(12),
      c.from('staff').select('first_name, last_name, name, role').eq('tenant_id', tn.tenant_id).eq('active', true).limit(10),
      c.from('knowledge_base').select('key, value').eq('tenant_id', tn.tenant_id).in('source', ['website_faq', 'gmb_qa']).limit(5)
    ]);

    const tenant = tenantRes.data || {};
    const bp = tenant.business_profile || {};

    let caller_brief = 'First-time caller — no history.';
    let client_id = '';
    if (from) {
      const { data: cl } = await c.from('clients')
        .select('id, first_name, last_name, name, visit_count, no_show_count, birthday, tags')
        .eq('tenant_id', tenant.id).eq('phone', from).maybeSingle();
      if (cl) {
        client_id = cl.id;
        const nm = (cl.first_name || cl.last_name) ? [cl.first_name, cl.last_name].filter(Boolean).join(' ') : cl.name;
        const lines = [`Returning client: ${nm}. Visits: ${cl.visit_count || 0}${cl.no_show_count ? ` (${cl.no_show_count} no-shows)` : ''}.`];
        if (cl.birthday) lines.push(`Birthday: ${cl.birthday}.`);
        if (cl.tags?.length) lines.push(`Tags: ${cl.tags.join(', ')}.`);
        caller_brief = lines.join('\n');
      }
    }

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

    const top_strengths = (bp.top_strengths || []).slice(0, 3).map(s => s.theme || s).join(', ');
    const hero_services = (bp.hero_services || []).slice(0, 3).map(s => s.name || s).join(', ');
    const hero_staff = (bp.hero_staff || []).slice(0, 3).map(s => s.name || s).join(', ');
    const brand_voice = bp.brand_voice?.tone
      || (Array.isArray(bp.brand_voice?.adjectives) ? bp.brand_voice.adjectives.slice(0, 3).join(', ') : '');
    const faq_snippet = (faqRes.data || []).slice(0, 3).map(f => `Q: ${f.key}\nA: ${f.value}`).join('\n\n');

    const slugOrId = tenant.slug || tenant.id;
    const booking_url = slugOrId ? `https://loladesk.com/book/${slugOrId}` : 'https://loladesk.com';

    const payload = {
      company_name: tenant.name || 'the salon',
      location: tenant.location || bp.gbp_location?.address?.locality || '',
      hours: hours || '',
      booking_url,
      services: services || '',
      staff: staff || '',
      caller_brief,
      tenant_id: tenant.id || '',
      client_id,
      to,
      from,
      top_strengths,
      hero_services,
      hero_staff,
      brand_voice,
      faq_snippet,
      memories: ''
    };

    return res.status(200).json(forceStrings(payload));
  } catch (e) {
    return res.status(200).json(forceStrings(emptyPayload()));
  }
}
