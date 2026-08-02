/**
 * Auto-provisions a Telnyx phone number for a new salon signup.
 *
 * Flow:
 *   1. Search for available numbers in the salon's preferred area code
 *   2. Purchase the number via Telnyx Number Order API
 *   3. Link it to the LolaDesk TeXML app (voice webhook)
 *   4. Update the tenant record with the provisioned phone number
 *   5. Return the number + connection details
 *
 * Called from onboarding step 3 or directly from the dashboard.
 */
import { getUserFromToken, bearer } from './lib/auth.js';
import { db, updateTenantFields } from './lib/db.js';

const TELNYX = 'https://api.telnyx.com/v2';

function authHeaders(){
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`
  };
}

function appUrl(){
  return process.env.APP_URL || 'https://www.loladesk.com';
}

/**
 * Search for available phone numbers in a given area code or country.
 * Falls back to US national search if no area code provided.
 */
async function searchAvailableNumbers(areaCode, country = 'US'){
  const params = new URLSearchParams({
    'filter[country_code]': country,
    'limit': '10',
    'filter[features]': 'sms,mms,voice',
  });
  if(areaCode && /^\d{3}$/.test(areaCode)){
    params.set('filter[national]`, `true');
    params.set('filter[area_code]', areaCode);
  }

  const r = await fetch(`${TELNYX}/available_phone_numbers?${params}`, { headers: authHeaders() });
  if(!r.ok){
    const body = await r.text().catch(() => '');
    throw new Error(`Number search failed (${r.status}): ${body.slice(0,200)}`);
  }
  const j = await r.json();
  const numbers = (j?.data || []).filter(n =>
    n?.availability === 'available' &&
    n?.cost?.amount &&
    parseFloat(n.cost.amount) <= 3.00  // cap at $3/mo
  );
  if(!numbers.length) throw new Error(`No available numbers found${areaCode ? ` in area code ${areaCode}` : ''}.`);
  return numbers;
}

/**
 * Purchase a phone number via Telnyx.
 * Returns the purchased number object.
 */
async function purchaseNumber(phoneNumber, billingGroupId){
  const body = {
    phone_numbers: [{ phone_number: phoneNumber }],
    connection_id: billingGroupId || undefined,
  };

  const r = await fetch(`${TELNYX}/number_orders`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });

  if(!r.ok){
    const text = await r.text().catch(() => '');
    throw new Error(`Number purchase failed (${r.status}): ${text.slice(0,200)}`);
  }
  const j = await r.json();
  const order = j?.data;
  if(!order?.phone_numbers?.length){
    throw new Error('Purchase succeeded but no numbers returned');
  }
  const purchased = order.phone_numbers[0];
  if(purchased.status === 'failed'){
    throw new Error(`Purchase failed: ${purchased.failside_number_errors || 'unknown error'}`);
  }
  return purchased;
}

/**
 * Get or create a TeXML app that routes to LolaDesk voice handler.
 * Each tenant can share the same TeXML app — the webhook reads the To
 * number to look up the tenant, so one app serves all salons.
 */
async function getOrCreateTexmlApp(){
  // First, try to find an existing "LolaDesk Voice" TeXML app
  try{
    const r = await fetch(`${TELNYX}/texml_applications`, { headers: authHeaders() });
    if(r.ok){
      const j = await r.json();
      const apps = j?.data || [];
      const existing = apps.find(a =>
        a?.name?.toLowerCase().includes('lola') ||
        a?.voice_url?.includes('loladesk.com')
      );
      if(existing) return existing;
    }
  }catch{}

  // Create a new TeXML app pointing to our voice webhook
  const webhookUrl = `${appUrl()}/api/telnyx-voice`;
  const r = await fetch(`${TELNYX}/texml_applications`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      application_name: 'LolaDesk Voice',
      voice_url: webhookUrl,
      voice_method: 'POST',
      status_callback_url: `${appUrl()}/api/telnyx-voice`,
      status_callback_method: 'POST',
    }),
  });

  if(!r.ok){
    const text = await r.text().catch(() => '');
    throw new Error(`TeXML app creation failed (${r.status}): ${text.slice(0,200)}`);
  }
  const j = await r.json();
  return j?.data;
}

/**
 * Link a purchased phone number to a TeXML app.
 */
async function linkNumberToApp(phoneNumberId, texmlAppId){
  const r = await fetch(`${TELNYX}/phone_numbers/${phoneNumberId}`, {
    method: 'PATCH',
    headers: authHeaders(),
    body: JSON.stringify({
      texml_application_id: texmlAppId,
    }),
  });

  if(!r.ok){
    const text = await r.text().catch(() => '');
    throw new Error(`Number linking failed (${r.status}): ${text.slice(0,200)}`);
  }
  return await r.json();
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if(req.method === 'OPTIONS') return res.status(200).end();
  if(req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  if(!process.env.TELNYX_API_KEY){
    return res.status(503).json({ ok: false, error: 'Telnyx API key not configured' });
  }

  // Auth
  const user = await getUserFromToken(bearer(req));
  if(!user?.email) return res.status(401).json({ ok: false, error: 'Not authenticated' });

  const client = db();
  if(!client) return res.status(503).json({ ok: false, error: 'Database not configured' });

  // Get tenant for this user
  const { data: rows } = await client.from('tenants').select('*').eq('owner_email', user.email).limit(1);
  const tenant = rows?.[0];
  if(!tenant?.id) return res.status(404).json({ ok: false, error: 'No salon found for this account' });

  // Already has a number? Return it.
  if(tenant.phone_number){
    return res.status(200).json({
      ok: true,
      already_provisioned: true,
      phoneNumber: tenant.phone_number,
      message: 'This salon already has a phone number provisioned.'
    });
  }

  // Parse requested area code from body
  let body = {};
  try{ body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }catch{}
  const requestedAreaCode = body.areaCode || body.area_code;

  try{
    // 1. Search for available numbers
    const numbers = await searchAvailableNumbers(requestedAreaCode);

    // Pick the cheapest number
    const picked = numbers.sort((a,b) => parseFloat(a.cost.amount) - parseFloat(b.cost.amount))[0];
    const phoneNumber = picked.phone_number;

    // 2. Get or create the TeXML app
    const texmlApp = await getOrCreateTexmlApp();

    // 3. Purchase the number (linked to TeXML app)
    const purchased = await purchaseNumber(phoneNumber, texmlApp?.id);

    // Wait a moment for Telnyx to process
    await new Promise(r => setTimeout(r, 2000));

    // 4. Link to TeXML app
    const phoneNumberId = purchased.id || purchased.phone_number_id;
    if(phoneNumberId){
      try{
        await linkNumberToApp(phoneNumberId, texmlApp.id);
      }catch(linkErr){
        console.error('[PROVISION] Number linking failed (non-fatal, will retry):', linkErr.message);
      }
    }

    // 5. Update tenant record
    await updateTenantFields(tenant.id, {
      phone_number: phoneNumber,
      telnyx_phone_id: phoneNumberId,
      texml_app_id: texmlApp.id,
      provisioning_status: 'provisioned',
      provisioned_at: new Date().toISOString(),
    });

    // 6. Update onboarding status
    await client.from('tenant_onboarding').update({
      stage: 'phone_provisioned',
      updated_at: new Date().toISOString(),
    }).eq('tenant_id', tenant.id);

    return res.status(200).json({
      ok: true,
      phoneNumber,
      texmlAppId: texmlApp.id,
      cost: picked.cost,
      message: `Your Lola number is ready: ${phoneNumber}. Call it to hear Lola answer.`
    });

  }catch(e){
    console.error('[PROVISION] Error:', e.message);
    return res.status(500).json({
      ok: false,
      error: String(e?.message || e),
      hint: requestedAreaCode
        ? `Try a different area code, or omit it to get any available US number.`
        : `No area code provided. Try passing { "areaCode": "305" } in the request body.`
    });
  }
}
