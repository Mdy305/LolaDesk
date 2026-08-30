// api/onboarding/step3-configure.js — Approve & connect
// Review/approve. Lola has already drafted the menu (step2); here the owner
// approves it, tunes her voice, and points her at the calendar. Every field
// is optional and merges with what Lola already knows — no retyping.
import { getUserFromToken, bearer } from '../lib/auth.js';
import { db } from '../lib/db.js';
import { resolveTenantForUser } from '../lib/tenant-access.js';
import { previewGreeting, journey } from '../lib/onboarding-engine.js';

function cleanServices(value){
  if(!Array.isArray(value)) return null;
  return value.slice(0, 100).map(service => ({
    name: String(service?.name || '').trim().slice(0, 120),
    price: Number(service?.price || 0),
    duration: String(service?.duration || service?.dur || '').trim().slice(0, 40)
  })).filter(service => service.name);
}
function safeUrl(value){
  const raw = String(value || '').trim();
  if(!raw) return '';
  try{
    const url = new URL(raw);
    if(!['http:','https:'].includes(url.protocol)) return '';
    return url.toString().slice(0, 1000);
  }catch{ return ''; }
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  if(req.method === 'OPTIONS') return res.status(204).end();
  if(req.method !== 'POST') return res.status(405).json({ ok:false, error:'POST only' });

  try{
    const user = await getUserFromToken(bearer(req));
    if(!user) return res.status(401).json({ ok:false, error:'Not authenticated' });
    const tenant = await resolveTenantForUser(user);
    if(!tenant?.id) return res.status(404).json({ ok:false, error:'No tenant mapped to this account' });
    const client = db();
    if(!client) return res.status(503).json({ ok:false, error:'Database not configured' });

    const input = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});

    // Approve the menu: only overwrite when the owner explicitly sends one.
    const services = cleanServices(input.selectedServices ?? input.services);
    const personality = String(input.personality || input.persona || tenant.persona || 'warm').trim().slice(0, 80);
    const voice = String(input.voiceType || input.voice || 'lola').trim().slice(0, 80);
    const bookingUrl = safeUrl(input.bookingUrl || input.booking_url || tenant.booking_url || '');
    const platform = String(input.platform || 'link').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);

    const tenantPatch = { persona: personality, lolabrain_voice: voice, lolabrain_personality: personality };
    if(services && services.length) tenantPatch.services = services;
    if(bookingUrl) tenantPatch.booking_url = bookingUrl;
    const tenantResult = await client.from('tenants').update(tenantPatch).eq('id', tenant.id).select().maybeSingle();
    if(tenantResult.error) throw tenantResult.error;

    const onboardingPatch = {
      stage: 'configuration',
      status: 'in_progress',
      progress: 80,
      persona: { persona: personality, voice },
      provisioning: { services_count: (services && services.length) || (Array.isArray(tenant.services) ? tenant.services.length : 0), booking_connected: !!bookingUrl, booking_provider: platform },
      last_error: null,
      updated_at: new Date().toISOString()
    };
    if(bookingUrl) onboardingPatch.booking = { booking_url: bookingUrl, platform };
    await client.from('tenant_onboarding').update(onboardingPatch).eq('tenant_id', tenant.id);

    const t = tenantResult.data || { ...tenant, ...tenantPatch };
    const j = await journey(client, t);
    return res.status(200).json({
      ok: true,
      configured: true,
      tenant_id: tenant.id,
      services_count: Array.isArray(t.services) ? t.services.length : 0,
      booking: { url: bookingUrl, platform },
      lola_says: previewGreeting(t),
      ...j
    });
  }catch(error){
    return res.status(error?.status || 500).json({ ok:false, error:String(error?.message || error) });
  }
}
