/**
 * /api/admin/compliance — full 10DLC brand + campaign onboarding for the
 * platform operator. Admin-gated exactly like /api/admin and /api/admin/sync.
 *
 *   GET  /api/admin/compliance → { ok, brands, campaigns }
 *   POST { action: 'brands.create'    }  → register a business brand with TCR
 *   POST { action: 'brands.vet'       }  → submit a brand for external vetting
 *   POST { action: 'campaigns.create' }  → register a messaging campaign
 *
 * Talks to the Telnyx v2 10DLC endpoints directly so operators can complete
 * the whole TCR flow from the Command screen instead of the Telnyx portal.
 */

import { bearer, getUserFromToken, isAdminEmail } from '../lib/auth.js';
import { telnyxRequest, telnyxData } from '../lib/telnyx-client.js';

const ENTITY_TYPES = ['PRIVATE_PROFIT', 'PUBLIC_PROFIT', 'NON_PROFIT', 'GOVERNMENT', 'SOLE_PROPRIETOR'];
const USE_CASES = ['CUSTOMER_CARE', 'DELIVERY_NOTIFICATION', 'ACCOUNT_NOTIFICATION', 'MARKETING', 'MIXED', 'LOW_VOLUME', 'SOLE_PROPRIETOR'];

function jsonBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  return req.body;
}

function required(body, key) {
  const value = String(body[key] ?? '').trim();
  if (!value) throw Object.assign(new Error(`${key} is required`), { status: 400 });
  return value;
}

async function listBrands() {
  try {
    const brands = telnyxData(await telnyxRequest('/10dlc/brand', { query: { 'page[size]': 100 }, timeoutMs: 10000 }));
    return (Array.isArray(brands) ? brands : []).map(b => ({
      id: b.brandId || b.id,
      name: b.displayName || b.brand || b.companyName || null,
      entity_type: b.entityType || null,
      status: b.identityStatus || b.status || 'unknown',
      vetting_score: b.vettingScore ?? null
    }));
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}

async function listCampaigns() {
  try {
    const campaigns = telnyxData(await telnyxRequest('/10dlc/campaignBuilder', { query: { 'page[size]': 100 }, timeoutMs: 10000 }));
    return (Array.isArray(campaigns) ? campaigns : []).map(cp => ({
      id: cp.campaignId || cp.id,
      brand_id: cp.brandId || null,
      use_case: cp.usecase || null,
      status: cp.status || 'unknown'
    }));
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}

async function createBrand(body) {
  const entityType = String(body.entity_type || body.entityType || 'PRIVATE_PROFIT').toUpperCase();
  if (!ENTITY_TYPES.includes(entityType)) {
    throw Object.assign(new Error(`entity_type must be one of ${ENTITY_TYPES.join(', ')}`), { status: 400 });
  }
  const payload = {
    entityType,
    displayName: required(body, 'display_name'),
    companyName: required(body, 'company_name'),
    ein: required(body, 'ein'),
    phone: required(body, 'phone'),
    street: required(body, 'street'),
    city: required(body, 'city'),
    state: required(body, 'state'),
    postalCode: required(body, 'postal_code'),
    country: String(body.country || 'US').toUpperCase(),
    email: required(body, 'email'),
    website: required(body, 'website'),
    vertical: required(body, 'vertical')
  };
  const data = telnyxData(await telnyxRequest('/10dlc/brand', { method: 'POST', body: payload }));
  return {
    brand_id: data?.brandId || data?.id || null,
    status: data?.identityStatus || data?.status || 'submitted',
    raw: data
  };
}

async function vetBrand(body) {
  const brandId = required(body, 'brand_id');
  const data = telnyxData(await telnyxRequest(`/10dlc/brand/${brandId}/externalVetting`, {
    method: 'POST',
    body: {
      evpId: body.evp_id || 'AEGIS',
      vettingClass: body.vetting_class || 'STANDARD'
    }
  }));
  return { brand_id: brandId, status: data?.vettingStatus || data?.status || 'submitted', raw: data };
}

async function createCampaign(body) {
  const usecase = String(body.use_case || body.usecase || 'CUSTOMER_CARE').toUpperCase();
  if (!USE_CASES.includes(usecase)) {
    throw Object.assign(new Error(`use_case must be one of ${USE_CASES.join(', ')}`), { status: 400 });
  }
  const payload = {
    brandId: required(body, 'brand_id'),
    usecase,
    description: required(body, 'description'),
    sample1: required(body, 'sample1'),
    sample2: required(body, 'sample2'),
    messageFlow: required(body, 'message_flow'),
    helpMessage: required(body, 'help_message'),
    optinKeywords: body.optin_keywords || 'START, YES, SUBSCRIBE',
    optoutKeywords: body.optout_keywords || 'STOP, UNSUBSCRIBE, CANCEL, QUIT',
    helpKeywords: body.help_keywords || 'HELP, INFO',
    embeddedLink: body.embedded_link !== undefined ? Boolean(body.embedded_link) : true,
    numberPool: body.number_pool !== undefined ? Boolean(body.number_pool) : false,
    ageGated: body.age_gated !== undefined ? Boolean(body.age_gated) : false
  };
  if (body.sample3) payload.sample3 = String(body.sample3);
  if (body.sample4) payload.sample4 = String(body.sample4);
  if (body.sample5) payload.sample5 = String(body.sample5);

  const data = telnyxData(await telnyxRequest('/10dlc/campaignBuilder', { method: 'POST', body: payload }));
  return {
    campaign_id: data?.campaignId || data?.id || null,
    status: data?.status || 'submitted',
    raw: data
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ ok: false, error: 'GET/POST only' });

  const user = await getUserFromToken(bearer(req));
  if (!user) return res.status(401).json({ ok: false, error: 'Not signed in' });
  if (!isAdminEmail(user.email)) return res.status(403).json({ ok: false, error: 'Not authorized' });

  try {
    if (req.method === 'GET') {
      const [brands, campaigns] = await Promise.all([listBrands(), listCampaigns()]);
      return res.status(200).json({ ok: true, brands, campaigns });
    }

    const body = jsonBody(req);
    const action = String(body.action || '').trim();
    if (!action) return res.status(400).json({ ok: false, error: 'action required', supported: ['brands.create', 'brands.vet', 'campaigns.create'] });

    let data;
    if (action === 'brands.create') data = await createBrand(body);
    else if (action === 'brands.vet') data = await vetBrand(body);
    else if (action === 'campaigns.create') data = await createCampaign(body);
    else return res.status(400).json({ ok: false, error: 'unknown action', supported: ['brands.create', 'brands.vet', 'campaigns.create'] });

    return res.status(200).json({ ok: true, action, ...data });
  } catch (e) {
    console.error('[admin/compliance]', e?.message || e);
    return res.status(e?.status || 500).json({ ok: false, error: String(e?.message || e) });
  }
}
