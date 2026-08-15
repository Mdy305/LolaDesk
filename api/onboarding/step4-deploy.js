// api/onboarding/step4-deploy.js — The payoff: Lola goes live
// Readiness gate + auto-provision a phone number + the celebration moment.
import { getUserFromToken, bearer } from '../lib/auth.js';
import { db } from '../lib/db.js';
import { resolveTenantForUser } from '../lib/tenant-access.js';
import { celebrate, journey } from '../lib/onboarding-engine.js';

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if(req.method === 'OPTIONS') return res.status(204).end();
  if(req.method !== 'POST') return res.status(405).json({ ok:false, error:'POST only' });

  try{
    const user = await getUserFromToken(bearer(req));
    if(!user) return res.status(401).json({ ok:false, error:'Not authenticated' });
    let tenant = await resolveTenantForUser(user);
    if(!tenant?.id) return res.status(404).json({ ok:false, error:'No tenant mapped to this account' });
    const client = db();
    if(!client) return res.status(503).json({ ok:false, error:'Database not configured' });

    // ── AUTO-PROVISION PHONE NUMBER (the "it just works" moment) ──
    // If the tenant doesn't have a number yet, provision one via Telnyx
    // before going live — no separate step, no phone-trees, no waiting.
    if(!tenant.phone_number && process.env.TELNYX_API_KEY){
      try{
        const provisionRes = await fetch(`${req.headers.origin || 'https://www.loladesk.com'}/api/provision-number`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': req.headers.authorization || ''
          },
          body: JSON.stringify({})
        });
        const provisionData = await provisionRes.json();
        if(provisionData?.ok && provisionData?.phoneNumber){
          const { data: freshTenant } = await client.from('tenants').select('*').eq('id', tenant.id).single();
          if(freshTenant) tenant = freshTenant;
        }else{
          console.warn('[ONBOARDING DEPLOY] Phone provisioning failed:', provisionData?.error);
        }
      }catch(provisionErr){
        console.warn('[ONBOARDING DEPLOY] Phone provisioning error (non-fatal):', provisionErr.message);
      }
    }

    // ── The readiness gate ──
    const missing = [];
    if(!tenant.name) missing.push('business name');
    if(!tenant.website_url && !tenant.knowledge) missing.push('business knowledge');
    if(!tenant.booking_url) missing.push('booking connection');
    if(!tenant.phone_number) missing.push('phone number (auto-provisioning failed — tap again)');
    if(!process.env.TELNYX_API_KEY) missing.push('Telnyx server configuration');
    if(!process.env.ELEVENLABS_API_KEY || !process.env.ELEVENLABS_VOICE_ID) missing.push('ElevenLabs voice configuration');

    if(missing.length){
      await client.from('tenant_onboarding').update({
        status: 'blocked',
        stage: 'activation',
        progress: Math.max(20, 100 - missing.length * 14),
        last_error: `Go-live blocked: ${missing.join(', ')}`,
        updated_at: new Date().toISOString()
      }).eq('tenant_id', tenant.id);

      const j = await journey(client, tenant);
      return res.status(409).json({
        ok: false,
        can_go_live: false,
        missing,
        message: 'Lola is almost ready — a few finishing touches first.',
        error: `Still needed: ${missing.join(', ')}.`,
        ...j
      });
    }

    const now = new Date().toISOString();
    const tenantResult = await client.from('tenants').update({
      status: 'live',
      onboarded_at: tenant.onboarded_at || now
    }).eq('id', tenant.id).select().single();
    if(tenantResult.error) throw tenantResult.error;

    await client.from('tenant_onboarding').update({
      stage: 'complete', status: 'complete', progress: 100,
      provisioning: { phone_number: tenant.phone_number, voice: 'verified', booking: 'verified' },
      last_error: null, completed_at: now, updated_at: now
    }).eq('tenant_id', tenant.id);

    const j = await journey(client, tenantResult.data);
    return res.status(200).json({
      ok: true,
      can_go_live: true,
      phoneNumber: tenant.phone_number,
      dashboardUrl: '/dashboard',
      tenantId: tenant.id,
      ...celebrate(tenantResult.data),
      ...j
    });
  }catch(error){
    console.error('[ONBOARDING DEPLOY]', error);
    return res.status(500).json({ ok:false, error:String(error?.message || error) });
  }
}
