import { db, updateTenantFields, logUsage } from './lib/db.js';
import { getUserFromToken, bearer } from './lib/auth.js';
import { resolveTenantForUser } from './lib/tenant-access.js';

/**
 * /api/telnyx-numbers — Search & buy phone numbers
 * ════════════════════════════════════════════════════════════════
 * This is the revenue line: every salon needs a Lola number, and you
 * resell Telnyx numbers at a markup with recurring monthly rent.
 *
 * GET  /api/telnyx-numbers?action=search&area=305&country=US
 *        → returns available numbers to show in the marketplace
 *
 * POST /api/telnyx-numbers   { action:'buy', phone_number:'+1305...', tenantId }
 *        → orders the number, attaches it to the salon, provisions Lola
 *
 * ENV VARS:
 *   TELNYX_API_KEY
 *   TELNYX_VOICE_APP_ID       (your TeXML app id, to auto-attach voice)
 *   TELNYX_MESSAGING_PROFILE  (your messaging profile id, to auto-attach SMS)
 */

const TELNYX = 'https://api.telnyx.com/v2';

/* ── Retail pricing — the recurring-revenue line ─────────────────
   Telnyx local numbers cost ~$1/mo wholesale; toll-free ~$2/mo.
   The salon pays retail — env-configurable so pricing is a knob,
   not a redeploy. Search results return BOTH `cost` (what Telnyx
   charges you) and `monthly` (what the salon pays), so the UI shows
   retail and the margin per number is visible in one place. Every
   purchase logs a `number_rent` usage event at the retail price,
   which the billing layer can roll into the monthly invoice. */
const RETAIL = {
  local: Number(process.env.NUMBER_RETAIL_MONTHLY || 5),
  toll_free: Number(process.env.NUMBER_RETAIL_TOLLFREE_MONTHLY || 9)
};
const WHOLESALE = { local: 1.0, toll_free: 2.0 };
function pricingFor(type='local'){
  const t = type === 'toll_free' ? 'toll_free' : 'local';
  return { cost: WHOLESALE[t], monthly: RETAIL[t], margin: +(RETAIL[t] - WHOLESALE[t]).toFixed(2) };
}

function authHeaders(){
  return {
    'Content-Type':'application/json',
    'Authorization':`Bearer ${process.env.TELNYX_API_KEY}`
  };
}

// ── Search available numbers ──
async function searchNumbers({ area, country='US', type='local', limit=10 }){
  const params = new URLSearchParams();
  params.set('filter[country_code]', country);
  params.set('filter[features][]', 'voice');
  params.append('filter[features][]', 'sms');
  params.set('filter[limit]', String(limit));
  params.set('filter[phone_number_type]', type); // local | toll_free
  if(area) params.set('filter[national_destination_code]', area); // e.g. 305 for Miami

  const r = await fetch(`${TELNYX}/available_phone_numbers?${params.toString()}`, { headers: authHeaders() });
  const data = await r.json();
  // normalise for the front-end
  const price = pricingFor(type);
  const numbers = (data.data||[]).map(n => ({
    phone_number: n.phone_number,
    city: n.region_information?.find?.(x=>x.region_type==='rate_center')?.region_name
          || n.region_information?.[0]?.region_name || '',
    monthly: price.monthly,   // retail — what the salon pays
    cost: price.cost,         // wholesale — what Telnyx charges you
    features: (n.features||[]).map(f=>f.name)
  }));
  return numbers;
}

// ── Order (buy) a number ──
async function orderNumber({ phone_number }){
  const r = await fetch(`${TELNYX}/number_orders`, {
    method:'POST',
    headers: authHeaders(),
    body: JSON.stringify({ phone_numbers: [{ phone_number }] })
  });
  return r.json();
}

// ── Attach the number to voice (TeXML app) + messaging profile ──
async function provisionNumber({ phone_number_id }){
  const results = {};
  // attach voice connection (TeXML app)
  if(process.env.TELNYX_VOICE_APP_ID){
    const r = await fetch(`${TELNYX}/phone_numbers/${phone_number_id}/voice`, {
      method:'PATCH', headers: authHeaders(),
      body: JSON.stringify({ connection_id: process.env.TELNYX_VOICE_APP_ID })
    });
    results.voice = await r.json();
  }
  // attach messaging profile
  if(process.env.TELNYX_MESSAGING_PROFILE){
    const r = await fetch(`${TELNYX}/phone_numbers/${phone_number_id}/messaging`, {
      method:'PATCH', headers: authHeaders(),
      body: JSON.stringify({ messaging_profile_id: process.env.TELNYX_MESSAGING_PROFILE })
    });
    results.messaging = await r.json();
  }
  return results;
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  if(req.method === 'OPTIONS') return res.status(200).end();

  if(!process.env.TELNYX_API_KEY){
    return res.status(500).json({ error:'Server not configured: missing TELNYX_API_KEY' });
  }

  try{
    // ── SEARCH (GET) ──
    if(req.method === 'GET'){
      const url = new URL(req.url, 'http://x');
      const action = url.searchParams.get('action') || 'search';
      if(action === 'search'){
        const numbers = await searchNumbers({
          area: url.searchParams.get('area') || '',
          country: url.searchParams.get('country') || 'US',
          type: url.searchParams.get('type') || 'local',
          limit: Number(url.searchParams.get('limit')||10)
        });
        return res.status(200).json({ ok:true, numbers });
      }
      return res.status(400).json({ error:'unknown action' });
    }

    // ── BUY (POST) ──
    const body = typeof req.body === 'string' ? JSON.parse(req.body||'{}') : (req.body||{});
    if(body.action === 'buy' && body.phone_number){
      const order = await orderNumber({ phone_number: body.phone_number });
      // Telnyx returns the ordered numbers; grab the id to provision
      const pnId = order?.data?.phone_numbers?.[0]?.id;
      let provisioning = null;
      if(pnId) provisioning = await provisionNumber({ phone_number_id: pnId });

      // Save phone number to the tenant row in the database
      try {
        const token = bearer(req);
        if(token) {
          const user = await getUserFromToken(token);
          if(user) {
            const c = db();
            if(c) {
              const tenant = await resolveTenantForUser(user);
              if(tenant) {
                await updateTenantFields(tenant.id, { phone_number: body.phone_number });
                // Recurring revenue line: retail rent for this number,
                // rolled into the monthly invoice by the billing layer.
                const price = pricingFor(body.type === 'toll_free' ? 'toll_free' : 'local');
                await logUsage(tenant.id, 'number_rent', price.monthly, {
                  phone_number: body.phone_number,
                  wholesale: price.cost,
                  margin: price.margin
                }).catch(()=>{});
              }
            }
          }
        }
      } catch(dbErr) {
        console.error('[telnyx-numbers] Database phone number update failed:', dbErr);
      }

      return res.status(200).json({ ok:true, order, provisioning });
    }

    return res.status(400).json({ error:'unknown action' });
  }catch(e){
    return res.status(500).json({ ok:false, error:String(e) });
  }
}
