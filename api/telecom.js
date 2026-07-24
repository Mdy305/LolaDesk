import { getUserFromToken, bearer } from './lib/auth.js';
import { resolveTenantForUser } from './lib/tenant-access.js';
import { appUrl, normalizeE164, telnyxData, telnyxRequest, TelnyxApiError } from './lib/telnyx-client.js';

function jsonBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  return req.body;
}

async function authTenant(req) {
  const user = await getUserFromToken(bearer(req));
  if (!user) throw Object.assign(new Error('Not authenticated'), { status: 401 });
  const tenant = await resolveTenantForUser(user);
  if (!tenant) throw Object.assign(new Error('No tenant mapped to this account'), { status: 404 });
  return { user, tenant };
}

function required(body, key) {
  const value = String(body[key] || '').trim();
  if (!value) throw Object.assign(new Error(`${key} is required`), { status: 400 });
  return value;
}

function capability(name, available, reason = null) {
  return { name, available: Boolean(available), ...(reason ? { reason } : {}) };
}

async function capabilities() {
  const results = [];
  const probes = [
    ['numbers', '/available_phone_numbers', { 'filter[country_code]': 'US', 'filter[limit]': 1 }],
    ['porting', '/porting_orders', { 'page[size]': 1 }],
    ['sim_cards', '/sim_cards', { 'page[size]': 1 }],
    ['mobile_voice', '/mobile_phone_numbers', { 'page[size]': 1 }],
    ['ai_assistants', '/ai/assistants', { 'page[size]': 1 }]
  ];
  for (const [name, path, query] of probes) {
    try {
      await telnyxRequest(path, { query });
      results.push(capability(name, true));
    } catch (error) {
      const unavailable = [401, 403, 404].includes(error?.status);
      results.push(capability(name, !unavailable, unavailable ? error.message : 'Probe failed; retry later'));
    }
  }
  return results;
}

async function searchNumbers(body) {
  const features = Array.isArray(body.features) && body.features.length ? body.features : ['voice', 'sms'];
  const query = {
    'filter[country_code]': String(body.country_code || 'US').toUpperCase(),
    'filter[phone_number_type]': body.phone_number_type || 'local',
    'filter[limit]': Math.min(Math.max(Number(body.limit || 10), 1), 50),
    'filter[national_destination_code]': body.area_code || undefined,
    'filter[contains]': body.contains || undefined,
    'filter[best_effort]': 'true',
    'filter[features][]': features
  };
  return telnyxData(await telnyxRequest('/available_phone_numbers', { query }));
}

async function provisionNumber(body, tenant) {
  const phoneNumber = normalizeE164(body.phone_number);
  if (!phoneNumber) throw Object.assign(new Error('A valid phone_number is required'), { status: 400 });
  const ordered = telnyxData(await telnyxRequest('/number_orders', {
    method: 'POST',
    body: { phone_numbers: [{ phone_number: phoneNumber }], customer_reference: `tenant:${tenant.id}` }
  }));
  const item = ordered?.phone_numbers?.[0] || {};
  const phoneNumberId = item.id;
  const voiceConnectionId = body.voice_connection_id || process.env.TELNYX_VOICE_APP_ID;
  const messagingProfileId = body.messaging_profile_id || process.env.TELNYX_MESSAGING_PROFILE;
  if (phoneNumberId && voiceConnectionId) {
    await telnyxRequest(`/phone_numbers/${phoneNumberId}/voice`, { method: 'PATCH', body: { connection_id: voiceConnectionId } });
  }
  if (messagingProfileId) {
    await telnyxRequest(`/messaging_phone_numbers/${encodeURIComponent(phoneNumber)}`, {
      method: 'PATCH', body: { messaging_profile_id: messagingProfileId }
    });
  }
  return { order: ordered, phone_number: phoneNumber, voice_attached: Boolean(voiceConnectionId), messaging_attached: Boolean(messagingProfileId) };
}

async function listNumbers() {
  return telnyxData(await telnyxRequest('/phone_numbers', { query: { 'page[size]': 100 } }));
}

async function updateRouting(body) {
  const phoneNumberId = required(body, 'phone_number_id');
  const result = {};
  if (body.voice_connection_id) {
    result.voice = telnyxData(await telnyxRequest(`/phone_numbers/${phoneNumberId}/voice`, {
      method: 'PATCH', body: { connection_id: body.voice_connection_id }
    }));
  }
  if (body.messaging_profile_id) {
    const phoneNumber = normalizeE164(body.phone_number);
    if (!phoneNumber) throw Object.assign(new Error('phone_number is required to configure messaging'), { status: 400 });
    result.messaging = telnyxData(await telnyxRequest(`/messaging_phone_numbers/${encodeURIComponent(phoneNumber)}`, {
      method: 'PATCH', body: { messaging_profile_id: body.messaging_profile_id }
    }));
  }
  return result;
}

async function createPort(body, tenant) {
  const phoneNumber = normalizeE164(body.phone_number);
  if (!phoneNumber) throw Object.assign(new Error('A valid phone_number is required'), { status: 400 });
  return telnyxData(await telnyxRequest('/porting_orders', {
    method: 'POST',
    body: {
      phone_numbers: [phoneNumber],
      customer_reference: `tenant:${tenant.id}`,
      webhook_url: `${appUrl()}/api/telecom-webhook`
    }
  }));
}

async function listPorts() {
  return telnyxData(await telnyxRequest('/porting_orders', { query: { 'page[size]': 100 } }));
}

async function confirmPort(body) {
  const portingOrderId = required(body, 'porting_order_id');
  return telnyxData(await telnyxRequest(`/porting_orders/${portingOrderId}/actions/confirm`, { method: 'POST' }));
}

async function listSims() {
  const sims = telnyxData(await telnyxRequest('/sim_cards', { query: { 'page[size]': 100 } }));
  return { sims, note: 'Physical SIM and eSIM availability depends on the Telnyx account, inventory, device, and region.' };
}

async function activateSim(body) {
  const simCardId = required(body, 'sim_card_id');
  return telnyxData(await telnyxRequest(`/sim_cards/${simCardId}/actions/enable`, { method: 'POST' }));
}

async function enableSimVoice(body) {
  const simCardId = required(body, 'sim_card_id');
  return telnyxData(await telnyxRequest(`/sim_cards/${simCardId}/actions/enable_voice`, {
    method: 'POST',
    body: body.connection_id ? { connection_id: body.connection_id } : {}
  }));
}

async function listMobileNumbers() {
  return telnyxData(await telnyxRequest('/mobile_phone_numbers', { query: { 'page[size]': 100 } }));
}

async function assign10dlc(body) {
  const messagingProfileId = required(body, 'messaging_profile_id');
  const campaignId = body.campaign_id || null;
  const tcrCampaignId = body.tcr_campaign_id || null;
  if (Boolean(campaignId) === Boolean(tcrCampaignId)) {
    throw Object.assign(new Error('Provide exactly one of campaign_id or tcr_campaign_id'), { status: 400 });
  }
  return telnyxData(await telnyxRequest('/10dlc/phoneNumberAssignmentByProfile', {
    method: 'POST',
    body: {
      messagingProfileId,
      ...(campaignId ? { campaignId } : { tcrCampaignId })
    }
  }));
}

const handlers = {
  capabilities: async () => capabilities(),
  'numbers.search': async ({ body }) => searchNumbers(body),
  'numbers.list': async () => listNumbers(),
  'numbers.provision': async ({ body, tenant }) => provisionNumber(body, tenant),
  'routing.update': async ({ body }) => updateRouting(body),
  'ports.create': async ({ body, tenant }) => createPort(body, tenant),
  'ports.list': async () => listPorts(),
  'ports.confirm': async ({ body }) => confirmPort(body),
  'sims.list': async () => listSims(),
  'sims.activate': async ({ body }) => activateSim(body),
  'sims.enable_voice': async ({ body }) => enableSimVoice(body),
  'mobile_numbers.list': async () => listMobileNumbers(),
  'compliance.assign_10dlc': async ({ body }) => assign10dlc(body)
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method Not Allowed' });
  try {
    const { tenant } = await authTenant(req);
    const body = jsonBody(req);
    const action = String(req.query?.action || body.action || (req.method === 'GET' ? 'capabilities' : '')).trim();
    const actionHandler = handlers[action];
    if (!actionHandler) return res.status(400).json({ error: 'Unknown telecom action', supported_actions: Object.keys(handlers) });
    const data = await actionHandler({ req, body, tenant });
    return res.status(200).json({ ok: true, action, tenant_id: tenant.id, data });
  } catch (error) {
    const status = error instanceof TelnyxApiError ? error.status : (error?.status || 500);
    return res.status(status).json({ ok: false, error: String(error?.message || error), details: error?.details || undefined });
  }
}
