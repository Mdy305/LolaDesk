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
// The messaging profile LolaDesk adopted itself (lib/telnyx-account.js), when no env var is set.
async function adoptedProfileId(){
  try { const c = db(); if(!c) return null; const { data } = await c.from('platform_settings').select('value').eq('key', 'telnyx_messaging_profile_id').maybeSingle(); return data?.value?.id || null; } catch { return null; }
}

const TELNYX = 'https://api.telnyx.com/v2';
function telnyxH(){ return { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.TELNYX_API_KEY }; }
function appUrl(){ return process.env.APP_URL || 'https://www.loladesk.com'; }

export async function tFetch(path, opts = {}){
  const r = await fetch(TELNYX + path, { ...opts, headers: { ...telnyxH(), ...(opts.headers || {}) } });
  const j = await r.json().catch(() => ({ errors: [{ detail: 'No body' }] }));
  if(!r.ok) throw new Error(j?.errors?.[0]?.detail || j?.error || 'Telnyx ' + r.status);
  return j;
}

/**
 * GET /v2/balance — Telnyx account credit, used to warn owners before they
 * hit "Not enough credit" mid-purchase. Advisory only: never blocks
 * provisioning; returns null if Telnyx is unreachable.
 */
export async function getAccountBalance(){
  try{
    const j = await tFetch('/balance');
    const d = j?.data || {};
    const available = Number(d.available_credit ?? d.balance ?? 0);
    return {
      currency: d.currency || 'USD',
      balance: Number(d.balance ?? 0),
      available_credit: available,
      credit_limit: Number(d.credit_limit ?? 0)
    };
  }catch(e){
    return null;
  }
}

export async function searchNumbers(areaCode, { limit = 10 } = {}){
  const p = new URLSearchParams();
  p.set('filter[country_code]', 'US');
  p.set('filter[features][]', 'voice');
  p.append('filter[features][]', 'sms');
  p.append('filter[features][]', 'mms');   // clients text Lola photos of their hair
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
      // Telnyx: POST /texml_applications requires friendly_name AND voice_url.
      body: JSON.stringify({ friendly_name: 'LolaDesk', voice_url: webhookUrl, voice_method: 'post', status_callback: webhookUrl, inbound: { channel_limit: 10 }, outbound: { channel_limit: 10 } })
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
            body: JSON.stringify({ friendly_name: 'LolaDesk', voice_url: webhookUrl, voice_method: 'post' })
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
  // Attach texting at order time too (documented on POST /number_orders), so a slow order can't leave it unlinked.
  const profileId = process.env.TELNYX_MESSAGING_PROFILE_ID || process.env.TELNYX_MESSAGING_PROFILE || await adoptedProfileId().catch(() => null);
  if(profileId) body.messaging_profile_id = profileId;
  const j = await tFetch('/number_orders', { method: 'POST', body: JSON.stringify(body) });
  return j?.data || {};
}

export async function linkMessagingProfile(phoneNumberId, override = null){
  const profileId = override || process.env.TELNYX_MESSAGING_PROFILE_ID || process.env.TELNYX_MESSAGING_PROFILE || await adoptedProfileId();
  if(!profileId) return false;
  try { await tFetch('/phone_numbers/' + phoneNumberId + '/messaging', { method: 'PATCH', body: JSON.stringify({ messaging_profile_id: profileId }) }); return true; }
  catch(e){ console.warn('[PROVISION] SMS profile:', e.message); return false; }
}

// ── Canonical voice connection ────────────────────────────────────
// The platform's voice lines answer via the LolaBrain AI assistant: Telnyx
// routes a number into the assistant by pointing its connection at the
// assistant's OWN TeXML app (telephony_settings.default_texml_app_id). That
// id is resolved live from the assistant (with a short cache) rather than
// hardcoded, so provisioning, health, and the numbers panel all agree with
// Telnyx truth. TELNYX_VOICE_APP_ID stays as the fallback when the
// assistant id can't be resolved.
let _brainAppId = null;
let _brainAppAt = 0;
const BRAIN_APP_TTL_MS = 60_000;

// The LolaBrain assistant's own TeXML app — the connection inbound calls on a
// number must point at for Telnyx to route them into the assistant. Resolved
// live from the assistant; this constant is the current production value used
// as a known-good fallback by health/panel checks before the first resolve.
export const LOLA_BRAIN_TEXML_APP_ID = '2958004434761680608';

export async function getLolaBrainConnectionId(){
  if(_brainAppId && Date.now() - _brainAppAt < BRAIN_APP_TTL_MS) return _brainAppId;
  // The assistant that really is Lola (a stale/mistyped id in Vercel is found and corrected).
  try{
    const { resolveAssistant } = await import('./assistant-wiring.js');
    const r = await resolveAssistant();
    if(r?.texml_app_id){ _brainAppId = r.texml_app_id; _brainAppAt = Date.now(); return _brainAppId; }
  }catch(_){}
  const assistantId = String(process.env.TELNYX_LOLA_BRAIN_ID || '').trim();
  if(!assistantId) return null;
  try{
    const a = await tFetch('/ai/assistants/' + assistantId);
    const appId = a?.telephony_settings?.default_texml_app_id || null;
    if(appId){ _brainAppId = appId; _brainAppAt = Date.now(); return appId; }
  }catch(e){ console.warn('[PROVISION] LolaBrain app resolve:', e.message); }
  return null;
}

// Sync read of the cached value (never resolves) — for sync call sites
// (e.g. the connection-sync known-good set). Returns null on first call.
export function getLolaBrainConnectionIdSync(){
  return _brainAppId || LOLA_BRAIN_TEXML_APP_ID;
}

// ── Which line answers the salon's calls ─────────────────────────
// 'loladesk' (default): LolaDesk's own call line — Telnyx sends each turn of the call to
//   /api/telnyx-voice, where Lola thinks (Telnyx AI), books with her real tools and speaks in
//   her ElevenLabs voice. This is the path that answered every call before the assistant move.
// 'assistant': the Telnyx AI assistant (LolaBrain) answers on its own TeXML app.
// LOLA_PHONE_MODE in Vercel wins; otherwise platform_settings.lola_phone_mode (admin switch).
const MODES = new Set(['loladesk', 'assistant']);
let _mode = null, _modeAt = 0;
export async function phoneMode(){
  const env = String(process.env.LOLA_PHONE_MODE || '').trim().toLowerCase();
  if(MODES.has(env)) return env;
  if(_mode && Date.now() - _modeAt < 60_000) return _mode;
  let m = 'loladesk';
  try{
    const c = db();
    if(c){
      const { data } = await c.from('platform_settings').select('value').eq('key', 'lola_phone_mode').maybeSingle();
      const v = String((data?.value && typeof data.value === 'object' ? data.value.mode : data?.value) || '').trim().toLowerCase();
      if(MODES.has(v)) m = v;
    }
  }catch(_){}
  _mode = m; _modeAt = Date.now();
  return m;
}
export function _resetPhoneLineCache(){ _mode = null; _modeAt = 0; _ldApp = null; _ldAt = 0; }

// LolaDesk's own call line: a TeXML app whose voice URL is this deployment's /api/telnyx-voice.
// Found (the Vercel voice app when it is that line, else the app named LolaDesk), repaired when its
// URL drifted to an old domain, or created — so nobody copies ids by hand.
let _ldApp = null, _ldAt = 0;
const voiceLineUrl = () => appUrl().replace(/\/+$/, '') + '/api/telnyx-voice';
const isVoiceLine = (a) => /\/api\/telnyx-voice\/?(\?.*)?$/.test(String(a?.voice_url || a?.webhook_url || ''));
async function pointAt(app){
  const want = voiceLineUrl();
  if(String(app.voice_url || app.webhook_url || '').replace(/\/+$/, '') === want) return app;
  try{ await tFetch('/texml_applications/' + app.id, { method: 'PATCH', body: JSON.stringify({ friendly_name: app.friendly_name || 'LolaDesk', voice_url: want, voice_method: 'post' }) }); }
  catch(e){ console.warn('[PROVISION] voice line URL:', e.message); }
  return app;
}
export async function getLolaDeskVoiceAppId(){
  if(_ldApp && Date.now() - _ldAt < 5 * 60_000) return _ldApp;
  let app = null;
  const envId = String(process.env.TELNYX_VOICE_APP_ID || '').trim();
  if(envId){
    const j = await tFetch('/texml_applications/' + encodeURIComponent(envId)).catch(() => null);
    if(j?.data?.id && isVoiceLine(j.data)) app = await pointAt(j.data);
  }
  if(!app){
    const a = await getOrCreateTexmlApp().catch((e) => { console.warn('[PROVISION] voice line:', e.message); return null; });
    const got = a?.id ? a : a?.data;
    if(got?.id) app = await pointAt(got);
  }
  if(!app?.id) return null;
  _ldApp = app.id; _ldAt = Date.now();
  return _ldApp;
}
export function getLolaDeskVoiceAppIdSync(){ return _ldApp; }

export async function getCanonicalVoiceConnectionId(){
  if((await phoneMode()) === 'assistant') return (await getLolaBrainConnectionId()) || process.env.TELNYX_VOICE_APP_ID || null;
  return (await getLolaDeskVoiceAppId().catch(() => null)) || (await getLolaBrainConnectionId()) || process.env.TELNYX_VOICE_APP_ID || null;
}

/**
 * Attach the number to the platform's voice connection. Prefers the
 * LolaBrain assistant's own TeXML app (the ultra-smart AI path); falls back
 * to TELNYX_VOICE_APP_ID. Returns false when no connection is configured.
 */
export async function linkVoiceConnection(phoneNumberId){
  const connectionId = await getCanonicalVoiceConnectionId();
  if(!connectionId) return false;
  try { await tFetch('/phone_numbers/' + phoneNumberId, { method: 'PATCH', body: JSON.stringify({ connection_id: connectionId }) }); return true; }
  catch(e){ console.warn('[PROVISION] Voice connection:', e.message); return false; }
}

/**
 * List numbers already owned on the Telnyx account. This powers the
 * onboarding "use a number I already own" path: attaching an owned number
 * costs nothing, so the flow never stalls on credit. Fail soft → [] so a
 * Telnyx outage never blocks the purchase path.
 */
export async function listOwnedNumbers(){
  try{
    const j = await tFetch('/phone_numbers?page[size]=100');
    return (j?.data || []).filter(n => n?.phone_number).map(n => ({
      phone_number: n.phone_number,
      id: n.id,
      status: n.status || null,
      connection_id: n.connection_id || null,
      voice_enabled: n.voice_enabled ?? null,
      sms_enabled: n.messaging_profile_id ? true : null
    }));
  }catch(e){
    return [];
  }
}


/**
 * Platform numbers no salon uses yet — the only ones a salon may pick for free
 * (multi-tenant: a salon never sees another salon's number, nor the platform's
 * customer-care line). Shared by /api/provision-number and the setup engine.
 */
export async function freePlatformNumbers(){
  const owned = await listOwnedNumbers().catch(() => []);
  if(!owned.length) return [];
  const c = db(); if(!c) return [];
  const [a, b] = await Promise.all([
    c.from('tenant_numbers').select('phone_number,status').limit(5000),
    c.from('tenants').select('phone_number').limit(5000),
  ]);
  const taken = new Set([...(a.data || []).filter(r => r.status !== 'released').map(r => r.phone_number), ...(b.data || []).map(r => r.phone_number)].filter(Boolean));
  try{ const { data } = await c.from('platform_settings').select('value').eq('key', 'customer_care').maybeSingle(); if(data?.value?.number) taken.add(data.value.number); }catch(_){}
  // A number still being ported in for a salon is spoken for too.
  try{ const { data } = await c.from('tenant_number_ports').select('requested_phone_number,temporary_phone_number,status').limit(5000); (data || []).filter(r => !['cancelled','canceled'].includes(String(r.status || ''))).forEach(r => { if(r.requested_phone_number) taken.add(r.requested_phone_number); if(r.temporary_phone_number) taken.add(r.temporary_phone_number); }); }catch(_){}
  return owned.filter(n => !taken.has(n.phone_number)).map(n => ({ phone_number: n.phone_number, id: n.id, status: n.status, sms_enabled: n.sms_enabled }));
}

/**
 * Attach an ALREADY-OWNED Telnyx number to a tenant — voice connection +
 * SMS profile + LolaBrain — and persist the routing row. No purchase, so no
 * credit is consumed. This is the zero-cost sibling of
 * provisionNumberForTenant (which buys a new number).
 *
 * @returns {Promise<{ok:boolean, phoneNumber, phoneNumberId, voiceLinked:boolean,
 *                    smsLinked:boolean, brainLinked:boolean}>}
 * @throws when the number is not on this Telnyx account.
 */
export async function attachOwnedNumberForTenant(tenant, phoneNumber, { persist = true } = {}){
  const e164 = String(phoneNumber || '').trim().replace(/[^+\d]/g, '');
  if(!/^\+\d{10,15}$/.test(e164)) throw new Error('Enter a valid phone number, e.g. +13055550100');

  // 1. Verify the number is on THIS Telnyx account (never attach a stranger's line).
  const found = await tFetch('/phone_numbers?filter[phone_number]=' + encodeURIComponent(e164));
  const rec = (found?.data || []).find(n => n?.phone_number === e164);
  if(!rec?.id) throw new Error(e164 + ' is not on this Telnyx account — first buy or port it into Telnyx, then come back.');

  // 2. Attach voice connection + SMS profile + LolaBrain + dynvars webhook.
  //    All are idempotent and none throw (they warn + return false on failure),
  //    so run them in parallel — keeps signup-time auto-assignment inside its
  //    latency budget instead of stacking five sequential Telnyx round trips.
  const [voiceLinked, smsLinked, brainLinked] = await Promise.all([
    linkVoiceConnection(rec.id),
    linkMessagingProfile(rec.id),
    linkLolaBrain(rec.id),
    setDynamicVariablesWebhook()
  ]);

  if(persist) await persistProvisioning(tenant, { phoneNumber: e164, phoneNumberId: rec.id, texmlAppId: await getCanonicalVoiceConnectionId() });

  return { ok: true, phoneNumber: e164, phoneNumberId: rec.id, voiceLinked, smsLinked, brainLinked };
}

/**
 * Best-effort instant onboarding: give a brand-new tenant a live number the
 * moment their workspace is created by attaching the first Telnyx number this
 * account owns that isn't already tracked — no purchase, no credit, no wizard.
 *
 * Safety: the "tracked" set covers tenant_numbers routing rows AND the legacy
 * tenants.phone_number column, so another salon's active line can never be
 * grabbed. Fail-soft: signup must succeed even when Telnyx is down, the key is
 * missing, or every owned number is in use — the owner can always pick or port
 * a number in the wizard instead.
 *
 * @returns {Promise<{assigned:boolean, phoneNumber?:string, reason?:string}>}
 */
export async function autoAssignOwnedNumber(tenant){
  if(!tenant?.id) return { assigned:false, reason:'no-tenant' };
  if(!process.env.TELNYX_API_KEY) return { assigned:false, reason:'telnyx-not-configured' };
  try{
    const owned = await listOwnedNumbers();
    if(!owned.length) return { assigned:false, reason:'no-owned-numbers' };

    const c = db();
    if(!c) return { assigned:false, reason:'database-not-configured' };

    // Numbers already in use: tenant_numbers routing rows AND the legacy
    // tenants.phone_number column (a tenant may predate the routing table).
    const tracked = new Set();
    const [routes, legacy] = await Promise.all([
      c.from('tenant_numbers').select('phone_number'),
      c.from('tenants').select('phone_number')
    ]);
    (routes?.data || []).forEach(r => { if(r?.phone_number) tracked.add(String(r.phone_number)); });
    (legacy?.data || []).forEach(r => { if(r?.phone_number) tracked.add(String(r.phone_number)); });

    const free = owned.find(n => !tracked.has(String(n.phone_number)));
    if(!free) return { assigned:false, reason:'no-untracked-numbers' };

    const result = await attachOwnedNumberForTenant(tenant, free.phone_number);
    return { assigned:true, phoneNumber: result.phoneNumber };
  }catch(e){
    console.warn('[PROVISION] auto-assign skipped:', String(e?.message || e).slice(0, 200));
    return { assigned:false, reason:'error' };
  }
}

/**
 * Fail-loud persist shared by BOTH provisioning paths (attach an owned
 * number, buy a new one). supabase-js returns DB errors as an `error` object
 * instead of throwing, so an ignored result makes provisioning look
 * successful while tenants.phone_number stays null (e.g. a missing column
 * from an unapplied migration). Every write here checks its result and
 * throws a message naming the failing step — a 500 beats a silent lie.
 */
export async function persistProvisioning(tenant, { phoneNumber, phoneNumberId, texmlAppId }){
  const c = db();
  if(!c || !tenant?.id) return;

  const { error: tenantErr } = await c.from('tenants').update({
    phone_number: phoneNumber,
    telnyx_phone_id: phoneNumberId || null,
    texml_app_id: texmlAppId || null,
    provisioning_status: 'active',
    provisioned_at: new Date().toISOString()
    // booking_url is the owner's choice (Settings). Unset → bookingLinkFor()
    // serves the salon's LolaDesk page, computed fresh, never frozen here.
  }).eq('id', tenant.id);
  if(tenantErr) throw new Error('Provisioning persist failed updating tenants (' + tenant.id + '): ' + tenantErr.message);

  // PostgrestBuilder is only PromiseLike (.then) — never .catch on the chain,
  // so the error check lives inside .then and .catch re-throws it.
  await c.from('tenant_onboarding').update({ stage: 'phone_provisioned', updated_at: new Date().toISOString() })
    .eq('tenant_id', tenant.id).maybeSingle()
    .then(({ error }) => { if(error) throw new Error('Provisioning persist failed updating tenant_onboarding (' + tenant.id + '): ' + error.message); })
    .catch(e => { throw e; });

  const route = await upsertTenantNumber(tenant.id, phoneNumber, { kind: 'primary', connectionId: texmlAppId || null, status: 'active' });
  if(!route) throw new Error('Provisioning persist failed upserting tenant_numbers routing row for ' + phoneNumber);

  invalidateRouting(phoneNumber);
}

export async function linkLolaBrain(phoneNumberId){
  // The real attachment: point the number's voice connection at the
  // assistant's own TeXML app so Telnyx routes inbound calls into the
  // assistant. (The old POST /ai/assistants/{id}/phone_numbers endpoint 404s
  // — it silently failed, leaving numbers off the assistant while the
  // connection looked healthy.)
  // On LolaDesk's own line (the default) the number points there instead — one place decides.
  const appId = (await phoneMode()) === 'assistant' ? await getLolaBrainConnectionId() : await getCanonicalVoiceConnectionId();
  if(!appId) return false;
  // connection_id is a field of the number (PATCH /phone_numbers/{id}); /voice has no connection_id.
  try { await tFetch('/phone_numbers/' + phoneNumberId, { method: 'PATCH', body: JSON.stringify({ connection_id: appId }) }); return true; }
  catch(e){ console.warn('[PROVISION] LolaBrain:', e.message); return false; }
}

export async function setDynamicVariablesWebhook(){
  // The resolved Lola (a stale/mistyped env id is found on the account), the documented update
  // method, and the signed URL — so the salon details really load on every call.
  try{
    const { resolveAssistant, updateAssistant, variablesUrl } = await import('./assistant-wiring.js');
    const found = await resolveAssistant();
    if(!found.id) return false;
    await updateAssistant(found.id, { dynamic_variables_webhook_url: variablesUrl() });
    return true;
  }catch(e){ console.warn('[PROVISION] DynVars:', e.message); return false; }
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
  const canonicalAppId = await getCanonicalVoiceConnectionId();
  // The legacy TeXML app is only needed when Lola's own app can't be found.
  const texmlApp = canonicalAppId ? null : await getOrCreateTexmlApp();
  // Prefer the LolaBrain assistant's app (ultra-smart AI path); the legacy
  // TeXML app (getOrCreateTexmlApp) remains the fallback connection.
  const texmlAppId = canonicalAppId || texmlApp?.id || texmlApp?.data?.id;
  await purchaseNumber(phoneNumber, texmlAppId);
  // The order lands asynchronously: look for the number until it's on the account (up to ~10s),
  // instead of guessing one fixed wait. Overridable via env so tests don't sleep.
  const settle = Number(process.env.TELNYX_ORDER_SETTLE_MS ?? 2000);
  let phoneNumberId = null;
  for(let i = 0; i < 5 && !phoneNumberId; i++){
    if(settle) await new Promise(r => setTimeout(r, settle));
    const numbersRes = await tFetch('/phone_numbers?filter[phone_number]=' + encodeURIComponent(phoneNumber)).catch(() => ({ data: [] }));
    phoneNumberId = numbersRes?.data?.[0]?.id || null;
    if(!settle) break;
  }

  const smsLinked = phoneNumberId ? await linkMessagingProfile(phoneNumberId) : false;
  const brainLinked = phoneNumberId ? await linkLolaBrain(phoneNumberId) : false;
  await setDynamicVariablesWebhook();

  if(persist) await persistProvisioning(tenant, { phoneNumber, phoneNumberId, texmlAppId: canonicalAppId });

  return { ok: true, phoneNumber, texmlAppId: canonicalAppId, phoneNumberId, smsLinked, brainLinked };
}

export default {
  tFetch, getAccountBalance, searchNumbers, getOrCreateTexmlApp, purchaseNumber,
  linkMessagingProfile, linkVoiceConnection, linkLolaBrain, setDynamicVariablesWebhook,
  getLolaBrainConnectionId, getLolaBrainConnectionIdSync, getCanonicalVoiceConnectionId,
  phoneMode, getLolaDeskVoiceAppId, getLolaDeskVoiceAppIdSync,
  LOLA_BRAIN_TEXML_APP_ID,
  listOwnedNumbers, freePlatformNumbers, attachOwnedNumberForTenant, autoAssignOwnedNumber, provisionNumberForTenant, persistProvisioning
};
