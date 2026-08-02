import { getUserFromToken, bearer } from '../lib/auth.js';
import { db } from '../lib/db.js';
import { resolveTenantForUser } from '../lib/tenant-access.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'POST only' });

  try {
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok:false, error:'Not authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok:false, error:'No tenant mapped to this account' });
    const client = db();
    if (!client) return res.status(503).json({ ok:false, error:'Database not configured' });

    const missing = [];
    if (!tenant.name) missing.push('business name');
    if (!tenant.website_url && !tenant.knowledge) missing.push('business knowledge');
    if (!tenant.booking_url) missing.push('booking connection');
    if (!tenant.phone_number) missing.push('assigned phone number');
    if (!process.env.TELNYX_API_KEY) missing.push('Telnyx server configuration');
    if (!process.env.ELEVENLABS_API_KEY || !process.env.ELEVENLABS_VOICE_ID) missing.push('ElevenLabs voice configuration');

    // ── AUTO-PROVISION PHONE NUMBER ──
    // If the tenant doesn't have a phone number yet, provision one
    // automatically via Telnyx before going live.
    if (!tenant.phone_number && process.env.TELNYX_API_KEY) {
      try {
        const provisionRes = await fetch(`${req.headers.origin || 'https://www.loladesk.com'}/api/provision-number`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': req.headers.authorization || ''
          },
          body: JSON.stringify({})
        });
        const provisionData = await provisionRes.json();
        if (provisionData?.ok && provisionData?.phoneNumber) {
          // Refresh tenant with the new phone number
          const { data: freshTenant } = await client.from('tenants').select('*').eq('id', tenant.id).single();
          if (freshTenant) tenant = freshTenant;
          console.log('[ONBOARDING DEPLOY] Phone provisioned:', provisionData.phoneNumber);
        } else {
          console.warn('[ONBOARDING DEPLOY] Phone provisioning failed:', provisionData?.error);
        }
      } catch (provisionErr) {
        console.warn('[ONBOARDING DEPLOY] Phone provisioning error (non-fatal):', provisionErr.message);
      }
    }

    // Re-check missing after provisioning attempt
    const stillMissing = [];
    if (!tenant.name) stillMissing.push('business name');
    if (!tenant.website_url && !tenant.knowledge) stillMissing.push('business knowledge');
    if (!tenant.booking_url) stillMissing.push('booking connection');
    if (!tenant.phone_number) stillMissing.push('phone number (auto-provisioning failed — try again from dashboard)');
    if (!process.env.TELNYX_API_KEY) stillMissing.push('Telnyx server configuration');
    if (!process.env.ELEVENLABS_API_KEY || !process.env.ELEVENLABS_VOICE_ID) stillMissing.push('ElevenLabs voice configuration');

    if (stillMissing.length) {
      await client.from('tenant_onboarding').update({
        status:'blocked',
        stage:'activation',
        progress:Math.max(20, 100 - stillMissing.length * 14),
        last_error:`Go-live blocked: ${stillMissing.join(', ')}`,
        updated_at:new Date().toISOString()
      }).eq('tenant_id', tenant.id);
      return res.status(409).json({
        ok:false,
        can_go_live:false,
        missing: stillMissing,
        error:'Lola is not ready to go live yet.'
      });
    }

    const now = new Date().toISOString();
    const tenantResult = await client.from('tenants').update({
      status:'live',
      onboarded_at:tenant.onboarded_at || now
    }).eq('id', tenant.id).select().single();
    if (tenantResult.error) throw tenantResult.error;

    await client.from('tenant_onboarding').update({
      stage:'complete', status:'complete', progress:100,
      provisioning:{ phone_number:tenant.phone_number, voice:'verified', booking:'verified' },
      last_error:null, completed_at:now, updated_at:now
    }).eq('tenant_id', tenant.id);

    return res.status(200).json({
      ok:true,
      can_go_live:true,
      phoneNumber:tenant.phone_number,
      dashboardUrl:'/dashboard',
      tenantId:tenant.id
    });
  } catch (error) {
    console.error('[ONBOARDING DEPLOY]', error);
    return res.status(500).json({ ok:false, error:String(error?.message || error) });
  }
}
