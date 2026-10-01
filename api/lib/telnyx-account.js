/**
 * api/lib/telnyx-account.js — LolaDesk sets up its own Telnyx account.
 * ════════════════════════════════════════════════════════════════════
 * Everything a person used to click in the Telnyx portal, done through the
 * API with the key LolaDesk already has (TELNYX_API_KEY):
 *   texts   a messaging profile exists and sends inbound texts to
 *           /api/telnyx-sms (found, adopted or created; remembered)
 *   calls   the Voice API app (TELNYX_VOICE_APP_ID) has an outbound voice
 *           profile, so LolaDesk can place calls (owner calls, Lola callbacks)
 * Then the assistant (assistant-wiring) and every salon number (tenant-wiring)
 * are wired on top. heal:false only reports.
 */
import { telnyxRequest, telnyxData, appUrl } from './telnyx-client.js';
import { db } from './db.js';

const KEY = 'telnyx_messaging_profile_id';
const smsUrl = () => appUrl() + '/api/telnyx-sms';
const OUR_SMS_PATHS = /\/api\/(telnyx-sms|telnyx-webhook|webhooks\/telnyx)\b/;
const ours = (u) => { try { const x = new URL(u); const a = new URL(appUrl()); return x.hostname.replace(/^www\./, '') === a.hostname.replace(/^www\./, '') && OUR_SMS_PATHS.test(x.pathname); } catch (_) { return false; } };

/** The messaging profile salon numbers join: env first, else the one LolaDesk adopted. */
export async function messagingProfileId(client = db()) {
  const env = process.env.TELNYX_MESSAGING_PROFILE_ID || process.env.TELNYX_MESSAGING_PROFILE;
  if (env) return env;
  try { const { data } = await client.from('platform_settings').select('value').eq('key', KEY).maybeSingle(); return data?.value?.id || data?.value || null; } catch (_) { return null; }
}
async function remember(client, id) {
  try { await client.from('platform_settings').upsert({ key: KEY, value: { id, at: new Date().toISOString() }, updated_at: new Date().toISOString() }, { onConflict: 'key' }); } catch (_) {}
}

export async function wireMessaging(client, { heal = false } = {}) {
  let id = await messagingProfileId(client), profile = null, did = [];
  try {
    if (id) profile = telnyxData(await telnyxRequest('/messaging_profiles/' + encodeURIComponent(id), { timeoutMs: 8000 }));
  } catch (_) { profile = null; }
  if (!profile) {
    const list = telnyxData(await telnyxRequest('/messaging_profiles', { query: { 'page[size]': 100 }, timeoutMs: 8000 })) || [];
    profile = list.find(p => ours(p.webhook_url)) || list.find(p => /lola/i.test(p.name || '')) || list[0] || null;
    if (!profile && heal) { profile = telnyxData(await telnyxRequest('/messaging_profiles', { method: 'POST', body: { name: 'LolaDesk', webhook_url: smsUrl(), webhook_failover_url: smsUrl() }, timeoutMs: 10000 })); did.push('created'); }
    if (profile?.id && heal) { await remember(client, profile.id); did.push('adopted'); }
  }
  if (!profile) return { ok: false, say: 'There’s no messaging profile in your Telnyx account yet.', did };
  const webhookOk = ours(profile.webhook_url);
  if (!webhookOk && heal) {
    await telnyxRequest('/messaging_profiles/' + encodeURIComponent(profile.id), { method: 'PATCH', body: { webhook_url: smsUrl() }, timeoutMs: 8000 });
    did.push('webhook');
  }
  return { ok: webhookOk || did.includes('webhook'), id: profile.id, name: profile.name || null, webhook_ok: webhookOk || did.includes('webhook'), did,
    env_set: !!(process.env.TELNYX_MESSAGING_PROFILE_ID || process.env.TELNYX_MESSAGING_PROFILE) };
}

export async function wireVoiceApp(client, { heal = false } = {}) {
  const id = process.env.TELNYX_VOICE_APP_ID;
  if (!id) return { ok: false, say: 'TELNYX_VOICE_APP_ID isn’t set in Vercel.', did: [] };
  let app;
  try { app = telnyxData(await telnyxRequest('/call_control_applications/' + encodeURIComponent(id), { timeoutMs: 8000 })); }
  catch (e) { return { ok: false, say: 'I couldn’t read the Voice API app from Telnyx: ' + String(e?.message || e), did: [] }; }
  const ovp = app?.outbound?.outbound_voice_profile_id || null;
  if (ovp) return { ok: true, id, outbound_voice_profile_id: ovp, did: [] };
  if (!heal) return { ok: false, id, say: 'The Voice API app has no outbound voice profile, so LolaDesk can’t place calls.', did: [] };
  let list = [];
  try { list = telnyxData(await telnyxRequest('/outbound_voice_profiles', { query: { 'page[size]': 50 }, timeoutMs: 8000 })) || []; } catch (_) {}
  let prof = list.find(p => p.enabled !== false && /lola/i.test(p.name || '')) || list.find(p => p.enabled !== false) || null;
  const did = [];
  if (!prof) {
    try { prof = telnyxData(await telnyxRequest('/outbound_voice_profiles', { method: 'POST', body: { name: 'LolaDesk outbound', traffic_type: 'conversational', service_plan: 'global', enabled: true, whitelisted_destinations: ['US', 'CA'] }, timeoutMs: 10000 })); did.push('created_profile'); }
    catch (e) { return { ok: false, id, say: 'Telnyx wouldn’t create an outbound voice profile: ' + String(e?.message || e), did }; }
  }
  try {
    await telnyxRequest('/call_control_applications/' + encodeURIComponent(id), { method: 'PATCH', timeoutMs: 10000,
      body: { application_name: app.application_name || 'LolaDesk', webhook_event_url: app.webhook_event_url || (appUrl() + '/api/telnyx-voice'), outbound: { ...(app.outbound || {}), outbound_voice_profile_id: prof.id } } });
    did.push('outbound_profile');
    return { ok: true, id, outbound_voice_profile_id: prof.id, did };
  } catch (e) { return { ok: false, id, say: 'Telnyx refused the outbound profile: ' + String(e?.message || e), did }; }
}

export async function wireAccount(client, { heal = false } = {}) {
  if (!process.env.TELNYX_API_KEY) return { ok: false, error: 'TELNYX_API_KEY is not set' };
  const [messaging, voice] = await Promise.all([
    wireMessaging(client, { heal }).catch(e => ({ ok: false, say: String(e?.message || e), did: [] })),
    wireVoiceApp(client, { heal }).catch(e => ({ ok: false, say: String(e?.message || e), did: [] })),
  ]);
  return { ok: messaging.ok && voice.ok, messaging, voice };
}
