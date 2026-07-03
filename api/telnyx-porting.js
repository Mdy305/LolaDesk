import { getUserFromToken, bearer } from './lib/auth.js';
import {
  createTenantPortRequest,
  e164,
  listTenantPortRequests,
  updateTenantPortRequest,
  updateTenantFields
} from './lib/db.js';
import { resolveTenantForUser } from './lib/tenant-access.js';

const TELNYX = 'https://api.telnyx.com/v2';

function authHeaders(){
  return {
    'Content-Type':'application/json',
    'Authorization':`Bearer ${process.env.TELNYX_API_KEY}`
  };
}

async function resolveAuthTenant(req){
  const user = await getUserFromToken(bearer(req));
  if(!user) return { error: 'not authenticated', status: 401 };
  const tenant = await resolveTenantForUser(user);
  if(!tenant) return { error: 'no tenant mapped to this account', status: 404 };
  return { tenant };
}

async function findAndBuyTemporaryNumber(tenant, requestedNumber){
  const match = String(requestedNumber || '').replace(/[^\d]/g, '');
  const area = match.length >= 10 ? match.slice(match.length - 10, match.length - 7) : '';
  const searchParams = new URLSearchParams();
  searchParams.set('filter[country_code]', 'US');
  searchParams.set('filter[phone_number_type]', 'local');
  searchParams.set('filter[limit]', '1');
  searchParams.set('filter[features][]', 'voice');
  searchParams.append('filter[features][]', 'sms');
  if(area) searchParams.set('filter[national_destination_code]', area);

  const search = await fetch(`${TELNYX}/available_phone_numbers?${searchParams.toString()}`, { headers: authHeaders() });
  const searchData = await search.json();
  if(!search.ok) throw new Error(searchData?.errors?.[0]?.detail || 'failed to search temporary number');

  const candidate = searchData?.data?.[0]?.phone_number;
  if(!candidate) throw new Error('no temporary phone number available in this area');

  const order = await fetch(`${TELNYX}/number_orders`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ phone_numbers: [{ phone_number: candidate }] })
  });
  const orderData = await order.json();
  if(!order.ok) throw new Error(orderData?.errors?.[0]?.detail || 'failed to order temporary number');

  const phoneNumberId = orderData?.data?.phone_numbers?.[0]?.id;
  if(phoneNumberId && process.env.TELNYX_VOICE_APP_ID){
    await fetch(`${TELNYX}/phone_numbers/${phoneNumberId}/voice`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ connection_id: process.env.TELNYX_VOICE_APP_ID })
    });
  }
  if(phoneNumberId && process.env.TELNYX_MESSAGING_PROFILE){
    await fetch(`${TELNYX}/phone_numbers/${phoneNumberId}/messaging`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ messaging_profile_id: process.env.TELNYX_MESSAGING_PROFILE })
    });
  }

  await updateTenantFields(tenant.id, { phone_number: candidate });
  return candidate;
}

async function createPortOrder({ tenant, body }){
  const requested = e164(body.requested_phone_number || body.phone_number || '');
  if(!requested) return { error: 'requested_phone_number is required', status: 400 };
  if(!body.authorized_contact_name || !body.authorized_contact_email) {
    return { error: 'authorized_contact_name and authorized_contact_email are required', status: 400 };
  }

  const payload = {
    phone_numbers: [requested],
    webhook_url: `${process.env.APP_URL || 'https://www.loladesk.com'}/api/webhooks/telnyx`,
    customer_reference: `tenant:${tenant.id}`
  };

  const portCreate = await fetch(`${TELNYX}/porting_orders`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(payload)
  });
  const portData = await portCreate.json();
  if(!portCreate.ok){
    const detail = portData?.errors?.[0]?.detail || 'failed to create port order';
    return { error: detail, status: portCreate.status || 502 };
  }

  let tempNumber = null;
  if(body.use_temporary_number){
    tempNumber = await findAndBuyTemporaryNumber(tenant, requested);
  }

  const row = await createTenantPortRequest(tenant.id, {
    requested_phone_number: requested,
    status: 'submitted',
    current_carrier: body.current_carrier,
    account_number: body.account_number,
    account_pin: body.account_pin,
    billing_name: body.billing_name,
    billing_address: body.billing_address,
    authorized_contact_name: body.authorized_contact_name,
    authorized_contact_email: body.authorized_contact_email,
    telnyx_order_id: portData?.data?.id || null,
    temporary_phone_number: tempNumber,
    metadata: {
      loa_uploaded: !!body.loa_uploaded,
      recent_bill_uploaded: !!body.recent_bill_uploaded
    }
  });

  return {
    ok: true,
    port_request: row,
    telnyx_order: portData?.data || null,
    temporary_phone_number: tempNumber
  };
}

async function listPortOrders({ tenant }){
  const localRows = await listTenantPortRequests(tenant.id, 25);
  const byOrderId = new Map(localRows.filter(r => r.telnyx_order_id).map(r => [r.telnyx_order_id, r]));
  if(byOrderId.size === 0) return { ok: true, orders: localRows };

  const remote = await fetch(`${TELNYX}/porting_orders`, { headers: authHeaders() });
  const remoteData = await remote.json();
  if(remote.ok){
    const remoteOrders = remoteData?.data || [];
    await Promise.all(remoteOrders.map(async (o) => {
      const local = byOrderId.get(o.id);
      if(!local) return;
      const nextStatus = String(o.status || local.status || '').toLowerCase();
      const focDate = o.foc_date || o?.phone_numbers?.[0]?.foc_date || null;
      if(nextStatus !== local.status || focDate !== local.foc_date){
        await updateTenantPortRequest(local.id, { status: nextStatus, foc_date: focDate });
      }
    }));
  }
  const refreshed = await listTenantPortRequests(tenant.id, 25);
  return { ok: true, orders: refreshed };
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if(req.method === 'OPTIONS') return res.status(200).end();

  if(!process.env.TELNYX_API_KEY){
    return res.status(500).json({ error: 'Missing TELNYX_API_KEY env var' });
  }

  try{
    const auth = await resolveAuthTenant(req);
    if(auth.error) return res.status(auth.status).json({ error: auth.error });
    const { tenant } = auth;

    if(req.method === 'GET'){
      const out = await listPortOrders({ tenant });
      return res.status(200).json(out);
    }

    if(req.method === 'POST'){
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const out = await createPortOrder({ tenant, body });
      if(out.error) return res.status(out.status || 400).json({ error: out.error });
      return res.status(200).json(out);
    }

    return res.status(405).json({ error: 'Method Not Allowed' });
  }catch(e){
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
