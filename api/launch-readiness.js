import { getUserFromToken, bearer } from './lib/auth.js';
import { db } from './lib/db.js';
import { resolveTenantForUser } from './lib/tenant-access.js';
import { verifyTenantRouting } from './lib/tenant-resolver.js';
import { telnyxRequest } from './lib/telnyx-client.js';

function check(name, ready, detail){ return { name, ready:Boolean(ready), ...(detail ? { detail } : {}) }; }

// The SMS health gate. A disabled Telnyx messaging profile silently kills
// booking confirmations, the reminder engine, and waitlist offers while
// `Boolean(env)` still says "Configured" — the exact outage class we hit.
// So this check verifies the profile is actually ENABLED via the Telnyx API:
// key present → profile reachable → enabled. Never crashes, never green
// when SMS is down, and never leaks the API key (it only lives in the
// Authorization header inside telnyx-client.js).
export async function smsMessagingCheck({ key = process.env.TELNYX_API_KEY, profileId = process.env.TELNYX_MESSAGING_PROFILE, timeoutMs = 4000 } = {}){
  if(!key) return { ready:false, detail:'Missing TELNYX_API_KEY — SMS cannot send' };
  if(!profileId) return { ready:false, detail:'Missing TELNYX_MESSAGING_PROFILE — SMS cannot send' };
  let payload = null;
  try{
    payload = await telnyxRequest('/messaging_profiles/' + encodeURIComponent(profileId), { timeoutMs });
  }catch(error){
    const reason = String(error?.message || error);
    return { ready:false, detail:`SMS status unknown — could not verify messaging profile (${reason})` };
  }
  if(payload?.data?.enabled === true) return { ready:true, detail:'Messaging profile enabled' };
  return { ready:false, detail:'SMS degraded — messaging profile disabled (confirmations, reminders, and waitlist offers will not send)' };
}

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
    // Deployment gate: the tenant's number must round-trip back to THIS
    // tenant through the resolver — otherwise inbound calls would be
    // refused (or worse, land on another salon).
    const routing = await verifyTenantRouting(tenant);
    const checks = [
      check('supabase', true, 'Tenant resolved'),
      check('business_profile', Boolean(tenant.name && tenant.location), tenant.name || 'Missing business name'),
      check('booking', hasBooking, hasBooking ? 'Booking destination connected' : 'Add a booking URL or integration'),
      check('telnyx_api', Boolean(process.env.TELNYX_API_KEY), process.env.TELNYX_API_KEY ? 'Configured' : 'Missing TELNYX_API_KEY'),
      check('telnyx_voice', Boolean(process.env.TELNYX_VOICE_APP_ID), process.env.TELNYX_VOICE_APP_ID ? 'Configured' : 'Missing TELNYX_VOICE_APP_ID'),
      await smsMessagingCheck().then(s => check('telnyx_messaging', s.ready, s.detail)),
      check('phone_number', Boolean(tenant.phone_number), tenant.phone_number || 'No tenant number assigned'),
      check('phone_routing', routing.ready, routing.ready ? `Number routes to this tenant (${routing.source || 'routing table'})` : (routing.reason || 'Number does not resolve back to this tenant')),
      check('onboarding', onboarding?.status === 'complete', onboarding?.status || 'not_started')
    ];
    const ready = checks.every(item => item.ready);
    return res.status(200).json({ ok:true, ready, tenant_id:tenant.id, checks, routing, onboarding:onboarding || null });
  }catch(error){
    return res.status(500).json({ ok:false, error:String(error?.message || error) });
  }
}
