import { getUserFromToken, bearer } from './lib/auth.js';
import { db } from './lib/db.js';
import { resolveTenantForUser } from './lib/tenant-access.js';

function check(name, ready, detail){ return { name, ready:Boolean(ready), ...(detail ? { detail } : {}) }; }

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');
  if(req.method === 'OPTIONS') return res.status(204).end();
  if(req.method !== 'GET') return res.status(405).json({ ok:false, error:'GET only' });

  try{
    const user = await getUserFromToken(bearer(req));
    if(!user) return res.status(401).json({ ok:false, error:'Not authenticated' });
    const tenant = await resolveTenantForUser(user);
    if(!tenant?.id) return res.status(404).json({ ok:false, error:'No tenant mapped to this account' });
    const client = db();
    if(!client) return res.status(503).json({ ok:false, error:'Database not configured' });

    const [{ data:onboarding }, { data:integrations }] = await Promise.all([
      client.from('tenant_onboarding').select('*').eq('tenant_id', tenant.id).maybeSingle(),
      client.from('integrations').select('provider,status').eq('tenant_id', tenant.id)
    ]);

    const connected = new Set((integrations || []).filter(x => x.status === 'connected').map(x => x.provider));
    const hasBooking = Boolean(tenant.booking_url || connected.has('boulevard') || connected.has('square') || connected.has('fresha') || connected.has('vagaro') || connected.has('mindbody'));
    const checks = [
      check('supabase', true, 'Tenant resolved'),
      check('business_profile', Boolean(tenant.name && tenant.location), tenant.name || 'Missing business name'),
      check('booking', hasBooking, hasBooking ? 'Booking destination connected' : 'Add a booking URL or integration'),
      check('telnyx_api', Boolean(process.env.TELNYX_API_KEY), process.env.TELNYX_API_KEY ? 'Configured' : 'Missing TELNYX_API_KEY'),
      check('telnyx_voice', Boolean(process.env.TELNYX_VOICE_APP_ID), process.env.TELNYX_VOICE_APP_ID ? 'Configured' : 'Missing TELNYX_VOICE_APP_ID'),
      check('telnyx_messaging', Boolean(process.env.TELNYX_MESSAGING_PROFILE), process.env.TELNYX_MESSAGING_PROFILE ? 'Configured' : 'Missing TELNYX_MESSAGING_PROFILE'),
      check('phone_number', Boolean(tenant.phone_number), tenant.phone_number || 'No tenant number assigned'),
      check('onboarding', onboarding?.status === 'complete', onboarding?.status || 'not_started')
    ];
    const ready = checks.every(item => item.ready);
    return res.status(200).json({ ok:true, ready, tenant_id:tenant.id, checks, onboarding:onboarding || null });
  }catch(error){
    return res.status(500).json({ ok:false, error:String(error?.message || error) });
  }
}
