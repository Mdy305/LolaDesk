/**
 * api/lib/telnyx-provision.js — Telnyx number provisioning, shared by the
 * onboarding flow (api/provision-number.js) and the Stripe webhook's
 * automated provisioning (api/stripe-webhook.js) so there is exactly ONE
 * implementation of search -> order -> link -> tenant activation.
 *
 * ENV: TELNYX_API_KEY, TELNYX_MESSAGING_PROFILE_ID, TELNYX_LOLA_BRAIN_ID,
 *      APP_URL
 */

import { db, upsertTenantNumber } from './db.js';
import { invalidateRouting } from './tenant-resolver.js';

const TELNYX = 'https://api.telnyx.com/v2';
function telnyxH(){ return { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.TELNYX_API_KEY }; }
function appUrl(){ return process.env.APP_URL || 'https://www.loladesk.com'; }

export async function tFetch(path, opts = {}){
  const r = await fetch(TELNYX + path, { ...opts, headers: { ...telnyxH(), ...(opts.headers || {}) } });
  const j = await r.json().catch(() => ({ errors: [{ detail: 'No body' }] }));
  if(!r.ok) throw new Error(j?.errors?.[0]?.detail || j?.error || 'Telnyx ' + r.status);
  return j;
}

export async function searchNumbers(areaCode, { limit = 10 } = {}){
  const p = new URLSearchParams();
  p.set('filter[country_code]', 'US');
  p.set('filter[features][]', 'voice');
  p.append('filter[features][]', 'sms');
  p.set('filter[limit]', String(limit));
  p.set('filter[phone_number_type]', 'local');
  if(areaCode && /^\d{3}$/.test(areaCode)) p.set('filter[national_destination_code]', areaCode);
  let j;
  try{
    j = await tFetch('/available_phone_numbers?' + p);
  }catch(e){
    if(/no numbers found|best_effort/i.test(String(e?.message || e))){
      throw new Error('No numbers available' + (areaCode ? ' in area code ' + areaCode : '') + '. Try a different area code.');
    }
    throw e;
  }
  const nums = (j?.data || []).filter(n => n?.phone_number);
  if(!nums.length) throw new Error('No numbers available' + (areaCode ? ' in area code ' + areaCode : '') + '. Try a different area code.');
  return nums;
}

export async function getOrCreateTexmlApp(){
  const webhookUrl = appUrl() + '/api/telnyx-voice';
  // TeXML applications carry the name as `friendly_name` (and the webhook as
  // `webhook_url` or `voice_url` depending on API version) — never `name`.
  // Match on all three so a pre-existing app is reused instead of colliding.
  const matches = (a) => a?.friendly_name === 'LolaDesk' || a?.webhook_url === webhookUrl || a?.voice_url === webhookUrl;
  const list = await tFetch('/texml_applications?page[size]=20').catch(() => ({ data: [] }));
  const ex = (list?.data || []).find(matches);
  if(ex) return ex;
  try{
    const j = await tFetch('/texml_applications', {
      method: 'POST',
      body: JSON.stringify({ friendly_name: 'LolaDesk', webhook_url: webhookUrl, webhook_api_version: '2', inbound: { channel_limit: 10 }, outbound: { channel_limit: 10 } })
    });
    return j?.data || {};
  }catch(e){
    // Name collision — a stale 'LolaDesk' app exists with a different webhook
    // (created before the friendly_name fix). Adopt it instead of failing
    // provisioning, and repoint its webhook so calls route to the voice line.
    if(/already in use|conflict|duplicate/i.test(String(e?.message || e))){
      const retry = await tFetch('/texml_applications?page[size]=20').catch(() => ({ data: [] }));
      const adopt = (retry?.data || []).find(a => a?.friendly_name === 'LolaDesk');
      if(adopt){
        try{
          await tFetch('/texml_applications/' + adopt.id, {
            method: 'PATCH',
            body: JSON.stringify({ webhook_url: webhookUrl, webhook_api_version: '2' })
          });
        }catch(patchErr){ console.warn('[PROVISION] adopted app webhook update:', patchErr.message); }
        return adopt;
      }
    }
    throw e;
  }
}

export async function purchaseNumber(phoneNumber, texmlAppId){
  const body = { phone_numbers: [{ phone_number: phoneNumber }] };
  if(texmlAppId) body.connection_id = texmlAppId;
  const j = await tFetch('/number_orders', { method: 'POST', body: JSON.stringify(body) });
  return j?.data || {};
}

export async function linkMessagingProfile(phoneNumberId){
  const profileId = process.env.TELNYX_MESSAGING_PROFILE_ID;
  if(!profileId) return false;
  await tFetch('/phone_numbers/' + phoneNumberId + '/messaging', { method: 'PATCH', body: JSON.stringify({ messaging_profile_id: profileId }) })
    .catch(e => console.warn('[PROVISION] SMS profile:', e.message));
  return true;
}

export async function linkLolaBrain(phoneNumberId){
  const assistantId = process.env.TELNYX_LOLA_BRAIN_ID;
  if(!assistantId) return false;
  await tFetch('/ai/assistants/' + assistantId + '/phone_numbers', { method: 'POST', body: JSON.stringify({ phone_number_id: phoneNumberId }) })
    .catch(e => console.warn('[PROVISION] LolaBrain:', e.message));
  return true;
}

export async function setDynamicVariablesWebhook(){
  const assistantId = process.env.TELNYX_LOLA_BRAIN_ID;
  if(!assistantId) return false;
  await tFetch('/ai/assistants/' + assistantId, { method: 'PATCH', body: JSON.stringify({ dynamic_variables_webhook_url: appUrl() + '/api/agent-variables' }) })
    .catch(e => console.warn('[PROVISION] DynVars:', e.message));
  return true;
}

/**
 * The full provisioning flow, idempotent-ish:
 *   search -> order (with TeXML app connection) -> find phone number id ->
 *   link SMS profile + LolaBrain -> persist on the tenant + routing table.
 *
 * Returns { ok, phoneNumber, texmlAppId, phoneNumberId, smsLinked, brainLinked }.
 * Throws on Telnyx failures so callers can mark provisioning_pending.
 */
export async function provisionNumberForTenant(tenant, { areaCode, requestedNumber, persist = true } = {}){
  const phoneNumber = requestedNumber || (await searchNumbers(areaCode || ''))[0].phone_number;
  const texmlApp = await getOrCreateTexmlApp();
  const texmlAppId = texmlApp?.id || texmlApp?.data?.id;
  await purchaseNumber(phoneNumber, texmlAppId);
  // Telnyx needs a beat for the order to land before we can address the
  // number. Overridable via env so tests don't sleep.
  await new Promise(r => setTimeout(r, Number(process.env.TELNYX_ORDER_SETTLE_MS || 3000)));

  const numbersRes = await tFetch('/phone_numbers?filter[phone_number]=' + encodeURIComponent(phoneNumber)).catch(() => ({ data: [] }));
  const phoneNumberId = numbersRes?.data?.[0]?.id;

  const smsLinked = phoneNumberId ? await linkMessagingProfile(phoneNumberId) : false;
  const brainLinked = phoneNumberId ? await linkLolaBrain(phoneNumberId) : false;
  await setDynamicVariablesWebhook();

  if(persist){
    const c = db();
    if(c && tenant?.id){
      await c.from('tenants').update({
        phone_number: phoneNumber,
        telnyx_phone_id: phoneNumberId || null,
        texml_app_id: texmlAppId || null,
        provisioning_status: 'active',
        provisioned_at: new Date().toISOString(),
        booking_url: tenant.booking_url || appUrl() + '/book.html?t=' + tenant.slug
      }).eq('id', tenant.id);
      // PostgrestBuilder is only PromiseLike (.then) — never .catch on the chain.
      await c.from('tenant_onboarding').update({ stage: 'phone_provisioned', updated_at: new Date().toISOString() })
        .eq('tenant_id', tenant.id).maybeSingle().then(() => {}).catch(() => {});
      await upsertTenantNumber(tenant.id, phoneNumber, { kind: 'primary', connectionId: texmlAppId || null, status: 'active' });
      invalidateRouting(phoneNumber);
    }
  }

  return { ok: true, phoneNumber, texmlAppId, phoneNumberId, smsLinked, brainLinked };
}

export default {
  tFetch, searchNumbers, getOrCreateTexmlApp, purchaseNumber,
  linkMessagingProfile, linkLolaBrain, setDynamicVariablesWebhook, provisionNumberForTenant
};
