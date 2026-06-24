import { bearer, getUserFromToken } from './lib/auth.js';
import { db, getTenantIntegrations } from './lib/db.js';
import { resolveTenantForUser } from './lib/tenant-access.js';

function check(name, ok, severity='blocking', detail=''){
  return { name, ok: !!ok, severity, detail };
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  if(req.method === 'OPTIONS') return res.status(200).end();
  if(req.method !== 'GET') return res.status(405).json({ error:'GET only' });

  try{
    const user = await getUserFromToken(bearer(req));
    if(!user) return res.status(401).json({ error:'not authenticated' });
    const tenant = await resolveTenantForUser(user);
    if(!tenant?.id) return res.status(404).json({ error:'no tenant mapped to this account' });
    const c = db();
    const integrations = await getTenantIntegrations(tenant.id).catch(() => []);

    const services = Array.isArray(tenant.services) ? tenant.services : [];
    const team = Array.isArray(tenant.team) ? tenant.team : [];
    const checks = [
      check('Business profile', !!tenant.name && !!tenant.location, 'blocking', 'Set business name and location'),
      check('Service menu', services.length >= 3, 'blocking', 'Add at least 3 priced services'),
      check('Team setup', team.length >= 1, 'important', 'Add at least one stylist/member'),
      check('Business hours', !!tenant.hours, 'blocking', 'Configure opening hours'),
      check('Booking destination', !!tenant.booking_url || integrations.length > 0, 'blocking', 'Connect calendar or set booking link'),
      check('Phone line', !!tenant.phone_number, 'blocking', 'Order/connect your Lola number'),
      check('Secure webhooks', !!process.env.TELNYX_PUBLIC_KEY, 'important', 'Set TELNYX_PUBLIC_KEY in production'),
      check('Voice rendering', !!process.env.APP_URL, 'important', 'Set APP_URL for reliable voice audio playback')
    ];

    const blocking = checks.filter(x => !x.ok && x.severity === 'blocking');
    const important = checks.filter(x => !x.ok && x.severity !== 'blocking');
    const passed = checks.filter(x => x.ok).length;
    const score = Math.round((passed / checks.length) * 100);

    const payload = {
      tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name },
      score,
      can_go_live: blocking.length === 0,
      checks,
      blocking_items: blocking,
      important_items: important,
      next_actions: [...blocking, ...important].map(x => x.detail).filter(Boolean)
    };
    return res.status(200).json(payload);
  }catch(e){
    return res.status(500).json({ error:String(e && e.message || e) });
  }
}

