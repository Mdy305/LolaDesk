import { getUserFromToken, bearer } from './lib/auth.js';
import { resolveTenantForUser } from './lib/tenant-access.js';
import { db, upsertTenantNumber } from './lib/db.js';
import { invalidateRouting } from './lib/tenant-resolver.js';
import { appUrl, normalizeE164, telnyxData, telnyxRequest, TelnyxApiError } from './lib/telnyx-client.js';
import { getCanonicalVoiceConnectionId } from './lib/telnyx-provision.js';

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

async function persistProvisionedNumber(tenant, phoneNumber, metadata) {
  const client = db();
  if (!client) throw Object.assign(new Error('Database not configured'), { status: 503 });

  const { error: tenantError } = await client
    .from('tenants')
    .update({ phone_number: phoneNumber })
    .eq('id', tenant.id);
  if (tenantError) throw Object.assign(new Error(`Number ordered but tenant update failed: ${tenantError.message}`), { status: 500 });

  // Keep the authoritative routing table in sync so inbound calls resolve
  // to this tenant on the very next webhook.
  await upsertTenantNumber(tenant.id, phoneNumber, { kind: 'primary', status: 'active' }).catch(() => {});
  invalidateRouting(phoneNumber);

  const { data: onboarding } = await client
    .from('tenant_onboarding')
    .select('provisioning,channels,progress')
    .eq('tenant_id', tenant.id)
    .maybeSingle();

  if (onboarding) {
    const provisioning = {
      ...(onboarding.provisioning || {}),
      phone_number: phoneNumber,
      number_order_id: metadata.order_id || null,
      phone_number_id: metadata.phone_number_id || null,
      voice_attached: metadata.voice_attached,
      messaging_attached: metadata.messaging_attached,
      number_status: metadata.status || 'ordered',
      updated_at: new Date().toISOString()
    };
    const channels = { ...(onboarding.channels || {}), voice: true, sms: true };
    await client
      .from('tenant_onboarding')
      .update({
        provisioning,
        channels,
        progress: Math.max(Number(onboarding.progress || 0), 85),
        updated_at: new Date().toISOString()
      })
      .eq('tenant_id', tenant.id);
  }
}

async function provisionNumber(body, tenant) {
  const phoneNumber = normalizeE164(body.phone_number);
  if (!phoneNumber) throw Object.assign(new Error('A valid phone_number is required'), { status: 400 });
  if (tenant.phone_number && normalizeE164(tenant.phone_number) !== phoneNumber && body.replace_existing !== true) {
    throw Object.assign(new Error('Tenant already has a phone number. Pass replace_existing=true to replace it.'), { status: 409 });
  }

  const ordered = telnyxData(await telnyxRequest('/number_orders', {
    method: 'POST',
    body: { phone_numbers: [{ phone_number: phoneNumber }], customer_reference: `tenant:${tenant.id}` }
  }));
  const item = ordered?.phone_numbers?.[0] || {};
  const phoneNumberId = item.id || item.phone_number_id || null;
  // Prefer the LolaBrain assistant's own TeXML app (the AI voice path),
  // falling back to TELNYX_VOICE_APP_ID.
  const voiceConnectionId = body.voice_connection_id || await getCanonicalVoiceConnectionId();
  const messagingProfileId = body.messaging_profile_id || process.env.TELNYX_MESSAGING_PROFILE;
  if (phoneNumberId && voiceConnectionId) {
    await telnyxRequest(`/phone_numbers/${phoneNumberId}/voice`, { method: 'PATCH', body: { connection_id: voiceConnectionId } });
  }
  if (messagingProfileId) {
    await telnyxRequest(`/messaging_phone_numbers/${encodeURIComponent(phoneNumber)}`, {
      method: 'PATCH', body: { messaging_profile_id: messagingProfileId }
    });
  }

  const metadata = {
    order_id: ordered?.id || ordered?.order_id || null,
    phone_number_id: phoneNumberId,
    status: ordered?.status || item?.status || 'ordered',
    voice_attached: Boolean(phoneNumberId && voiceConnectionId),
    messaging_attached: Boolean(messagingProfileId)
  };
  await persistProvisionedNumber(tenant, phoneNumber, metadata);

  return {
    order: ordered,
    phone_number: phoneNumber,
    tenant_persisted: true,
    ...metadata
  };
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

// ── MESSAGING PROFILES (the central object that powers SMS/MMS/WhatsApp) ──
async function listMessagingProfiles() {
  const profiles = telnyxData(await telnyxRequest('/messaging_profiles', { query: { 'page[size]': 100 } }));
  return (Array.isArray(profiles) ? profiles : []).map(p => ({
    id: p.id,
    name: p.name,
    webhook_url: p.webhook_url || null,
    whitelisted_destinations: p.whitelisted_destinations || [],
    features: Array.isArray(p.features) ? p.features : [],
    created_at: p.created_at || null,
    // 10DLC registration state lives on the profile
    tcr: p.tcr_campaign_id ? { campaign_id: p.tcr_campaign_id, status: p.tcr_campaign_status || 'registered' } : null,
    use_case: p.use_case || null
  }));
}

async function createMessagingProfile(body) {
  const name = required(body, 'name');
  const webhookUrl = body.webhook_url || `${appUrl()}/api/telnyx-sms`;
  return telnyxData(await telnyxRequest('/messaging_profiles', {
    method: 'POST',
    body: {
      name,
      webhook_url: webhookUrl,
      webhook_failover_url: body.webhook_failover_url || webhookUrl
    }
  }));
}

async function assignMessagingProfile(body, tenant) {
  const messagingProfileId = required(body, 'messaging_profile_id');
  const phoneNumber = normalizeE164(body.phone_number || tenant.phone_number);
  if (!phoneNumber) throw Object.assign(new Error('A valid phone_number is required — get a number first'), { status: 400 });
  return telnyxData(await telnyxRequest(`/messaging_phone_numbers/${encodeURIComponent(phoneNumber)}`, {
    method: 'PATCH',
    body: { messaging_profile_id: messagingProfileId }
  }));
}

// ── ROUTING STATUS for one number (voice connection + messaging profile) ──
async function numberStatus(body, tenant) {
  const phoneNumber = normalizeE164(body.phone_number || tenant.phone_number);
  if (!phoneNumber) throw Object.assign(new Error('No phone number on this account yet — get one first'), { status: 400 });
  const numbers = telnyxData(await telnyxRequest('/phone_numbers', { query: { 'filter[phone_number]': phoneNumber, 'page[size]': 5 } }));
  const record = (Array.isArray(numbers) ? numbers : []).find(n => normalizeE164(n.phone_number) === phoneNumber) || null;
  const result = {
    phone_number: phoneNumber,
    phone_number_id: record?.id || null,
    status: record?.status || null,
    connection_id: record?.connection_id || null
  };
  if (record?.id) {
    try {
      const v = telnyxData(await telnyxRequest(`/phone_numbers/${record.id}/voice`, { timeoutMs: 8000 }));
      result.voice = { connection_id: v?.connection_id || null };
    } catch { result.voice = null; }
  }
  try {
    const m = telnyxData(await telnyxRequest(`/messaging_phone_numbers/${encodeURIComponent(phoneNumber)}`, { timeoutMs: 8000 }));
    result.messaging = {
      messaging_profile_id: m?.messaging_profile_id || null,
      messaging_product: m?.messaging_product || null
    };
  } catch { result.messaging = null; }
  return result;
}

// ── 10DLC / A2P compliance state (brands + campaigns) ──
async function complianceStatus() {
  const out = { brands: [], campaigns: [] };
  try {
    const brands = telnyxData(await telnyxRequest('/10dlc/brands', { query: { 'page[size]': 100 }, timeoutMs: 8000 }));
    out.brands = (Array.isArray(brands) ? brands : []).map(b => ({ id: b.id, name: b.brand, status: b.status || 'unknown' }));
  } catch (e) { out.brands_error = String(e.message || e); }
  try {
    const campaigns = telnyxData(await telnyxRequest('/10dlc/campaigns', { query: { 'page[size]': 100 }, timeoutMs: 8000 }));
    out.campaigns = (Array.isArray(campaigns) ? campaigns : []).map(c => ({
      id: c.id,
      campaign_id: c.campaign_id || null,
      status: c.status || 'unknown',
      use_case: c.use_case || null
    }));
  } catch (e) { out.campaigns_error = String(e.message || e); }
  return out;
}

const handlers = {
  capabilities: async () => capabilities(),
  'numbers.search': async ({ body }) => searchNumbers(body),
  'numbers.list': async () => listNumbers(),
  'numbers.provision': async ({ body, tenant }) => provisionNumber(body, tenant),
  'numbers.status': async ({ body, tenant }) => numberStatus(body, tenant),
  'routing.update': async ({ body }) => updateRouting(body),
  'ports.create': async ({ body, tenant }) => createPort(body, tenant),
  'ports.list': async () => listPorts(),
  'ports.confirm': async ({ body }) => confirmPort(body),
  'sims.list': async () => listSims(),
  'sims.activate': async ({ body }) => activateSim(body),
  'sims.enable_voice': async ({ body }) => enableSimVoice(body),
  'mobile_numbers.list': async () => listMobileNumbers(),
  'messaging_profiles.list': async () => listMessagingProfiles(),
  'messaging_profiles.create': async ({ body }) => createMessagingProfile(body),
  'messaging_profiles.assign': async ({ body, tenant }) => assignMessagingProfile(body, tenant),
  'compliance.assign_10dlc': async ({ body }) => assign10dlc(body),
  'compliance.status': async () => complianceStatus()
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
