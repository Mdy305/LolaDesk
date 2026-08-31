/*
 * api/lib/db.js — Shared Supabase client + multi-tenant helpers
 * Extended with client memory, deposits, and demo request helpers
 */

import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { encrypt, decrypt } from './crypto.js';

let _client = null;
export function db(){
  if(_client) return _client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if(!url || !key){
    // graceful: handlers can detect and fall back to demo mode
    return null;
  }
  _client = createClient(url, key, {
    auth: { persistSession: false },
    // supabase-js 2.108's realtime client requires a WebSocket transport on
    // Node < 22 (no native WebSocket) — without this every createClient call
    // throws on Node 20, which is what CI runs. `ws` is already a dependency.
    realtime: { transport: WebSocket }
  });
  return _client;
}

// ── normalize phone numbers to E.164 ──
export function e164(num){
  if(!num) return null;
  const cleaned = String(num).replace(/[^\d+]/g,'');
  if(cleaned.startsWith('+')) return cleaned;
  if(cleaned.length === 11 && cleaned.startsWith('1')) return '+'+cleaned;
  if(cleaned.length === 10) return '+1'+cleaned;
  return cleaned.startsWith('+') ? cleaned : '+'+cleaned;
}

// ── TENANT RESOLUTION ──
export const DEMO_TENANT_ID = '00000000-0000-0000-0000-000000000000';

// DEMO-ENABLED. Resolves by the tenant's phone number but falls back to the
// demo salon on ANY miss or DB error. That fallback is a cross-tenant leak
// for inbound telecom: an unprovisioned number would be greeted as the demo
// salon. Only use this for demo-flavored flows (booking tools, public
// resources, execution). For inbound calls/texts use lib/tenant-resolver.js
// (resolveInboundTenant) or getTenantByPhoneStrict below.
export async function getTenantByPhone(toNumber){
  const c = db();
  if(!c) return demoTenant();
  const phone = e164(toNumber);
  const { data, error } = await c
    .from('tenants').select('*')
    .eq('phone_number', phone)
    .maybeSingle();
  if(error || !data) return demoTenant();
  return data;
}

// STRICT. Same lookup as getTenantByPhone but returns null on a miss or DB
// error — never the demo tenant. Inbound telecom routing MUST use this (or
// the resolver, which wraps it) so an unrecognized number can never be
// answered with someone else's salon data.
export async function getTenantByPhoneStrict(toNumber){
  const c = db();
  if(!c) return null;
  const phone = e164(toNumber);
  if(!phone) return null;
  const { data, error } = await c
    .from('tenants').select('*')
    .eq('phone_number', phone)
    .maybeSingle();
  if(error || !data || data.id === DEMO_TENANT_ID) return null;
  return data;
}

// ── Shared Jarvis line: which salon does this CALLER run? ──
// One operator number serves every tenant: the owner's registered
// operator_phone (set in Settings via /api/operator-setup) identifies
// their salon. Deliberately NO demo fallback — an unrecognized caller
// on the owner line must get null, never someone else's salon.
export async function getTenantByOperatorPhone(fromNumber){
  const c = db();
  if(!c) return null;
  const phone = e164(fromNumber);
  if(!phone) return null;
  const { data } = await c
    .from('tenants').select('*')
    .eq('operator_phone', phone)
    .limit(1);
  return data?.[0] || null;
}

// ── Update a call row by its Telnyx id (transcript append, outcome) ──
export async function updateCallByTelnyxId(tenantId, telnyxCallId, patch = {}){
  const c = db();
  if(!c || !tenantId || !telnyxCallId) return null;
  const { data } = await c.from('calls')
    .update(patch)
    .eq('tenant_id', tenantId)
    .eq('telnyx_call_control_id', telnyxCallId)
    .select().maybeSingle();
  return data;
}

export async function getCallByTelnyxId(tenantId, telnyxCallId){
  const c = db();
  if(!c || !tenantId || !telnyxCallId) return null;
  const { data } = await c.from('calls').select('*')
    .eq('tenant_id', tenantId).eq('telnyx_call_control_id', telnyxCallId)
    .limit(1);
  return data?.[0] || null;
}

export async function getTenantBySlug(slug){
  const c = db();
  if(!c) return demoTenant();
  const { data } = await c.from('tenants').select('*').eq('slug', slug).maybeSingle();
  return data || demoTenant();
}

// ── Number routing table (tenant_numbers) ──────────────────────────
// Canonical number → tenant map. Prefer this over tenants.phone_number so a
// tenant can own multiple numbers. onConflict on phone_number means moving a
// number to a different tenant re-points the existing row instead of
// creating an ambiguous duplicate. Degrades safely (warn + null) when the
// migration hasn't been applied yet, so provisioning never hard-fails.
// Flip a pending-email tenant to active on the owner's first confirmed login.
// Idempotent: active tenants pass through untouched. Accepts an injected client
// (FakeSupabase in tests) so the gate is unit-testable.
export async function activateTenant(client, tenant){
  if(!client || !tenant?.id) return { ok:false };
  if((tenant.activation_status || 'active') !== 'pending_email') return { ok:true, already_active:true };
  const { error } = await client.from('tenants').update({ activation_status: 'active' }).eq('id', tenant.id);
  if(error) throw new Error(error.message);
  return { ok:true, activated:true };
}

export async function upsertTenantNumber(tenantId, phoneNumber, opts = {}){
  const c = db();
  if(!c || !tenantId) return null;
  const phone = e164(phoneNumber);
  if(!phone) return null;
  const row = {
    tenant_id: tenantId,
    phone_number: phone,
    kind: opts.kind || 'primary',
    connection_id: opts.connectionId || null,
    status: opts.status || 'active',
    notes: opts.notes || null,
    updated_at: new Date().toISOString()
  };
  try{
    const { data, error } = await c.from('tenant_numbers')
      .upsert(row, { onConflict: 'phone_number' })
      .select().maybeSingle();
    if(error) throw new Error(error.message);
    return data;
  }catch(e){
    console.warn('[db] upsertTenantNumber failed (migration pending?):', String(e?.message || e).slice(0, 200));
    return null;
  }
}

export async function listTenantNumbers(tenantId, limit = 20){
  const c = db();
  if(!c || !tenantId) return [];
  const { data, error } = await c.from('tenant_numbers')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if(error) return [];
  return data || [];
}

// Joined routing rows + tenant identity, for the admin control plane.
// Relies on the FK created in migrations/20260815_tenant_number_routing.sql.
export async function listTenantNumberRoutes(limit = 500){
  const c = db();
  if(!c) return [];
  const { data, error } = await c.from('tenant_numbers')
    .select('*, tenants(name,slug)')
    .order('created_at', { ascending: false })
    .limit(limit);
  if(error) return [];
  return data || [];
}

export async function removeTenantNumber(phoneNumber){
  const c = db();
  if(!c) return false;
  const phone = e164(phoneNumber);
  if(!phone) return false;
  const { error } = await c.from('tenant_numbers').delete().eq('phone_number', phone);
  return !error;
}

export async function setTenantNumberStatus(phoneNumber, status){
  const c = db();
  if(!c) return null;
  const phone = e164(phoneNumber);
  if(!phone) return null;
  const { data, error } = await c.from('tenant_numbers')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('phone_number', phone).select().maybeSingle();
  if(error) return null;
  return data;
}

function demoTenant(){
  return {
    id: '00000000-0000-0000-0000-000000000000',
    slug: 'demo',
    name: 'Demo Salon',
    owner_name: 'Owner',
    location: '',
    hours: '',
    booking_url: '',
    phone_number: '',
    services: [],
    team: [],
    _demo: true
  };
}

// ── CLIENTS ──
export async function upsertClient(tenantId, { phone, name, email, whatsappEnabled }){
  const c = db();
  if(!c || !tenantId) return null;
  const phoneE = e164(phone);
  const parts=String(name||'Client').trim().split(/\s+/).filter(Boolean);
  const row={tenant_id:tenantId,first_name:parts.shift()||'Client',last_name:parts.join(' ')||null,phone:phoneE,email:email||null,updated_at:new Date().toISOString()};
  // A client messaging the salon over WhatsApp has explicitly opted in to the
  // WhatsApp channel — persist the opt-in so booking reminders can use it.
  if(whatsappEnabled) row.whatsapp_enabled = true;
  let existing=null;
  if(phoneE){ const {data}=await c.from('clients').select('id').eq('tenant_id',tenantId).eq('phone',phoneE).maybeSingle(); existing=data; }
  if(!existing&&email){ const {data}=await c.from('clients').select('id').eq('tenant_id',tenantId).eq('email',String(email).toLowerCase()).maybeSingle(); existing=data; }
  const query=existing?.id?c.from('clients').update(row).eq('id',existing.id).eq('tenant_id',tenantId):c.from('clients').insert(row);
  const {data,error}=await query.select().maybeSingle();
  if(error) throw error;
  return data;
}

// ── Web visitors (website widget) ──
// Widget visitors have no phone yet; they're identified by a stable
// visitor id stored on the tenant's site. Keyed as 'web:<id>' in the
// clients table — deliberately NOT e164()'d. When they book and share
// a real phone, the SMS/voice memory unifies on that number.
export async function upsertWebVisitor(tenantId, visitorId, { name, email } = {}){
  const c = db();
  if(!c || !tenantId || !visitorId) return null;
  const key = 'web:' + String(visitorId).slice(0, 64);
  const { data: existing } = await c.from('clients').select('id')
    .eq('tenant_id', tenantId).eq('phone', key).maybeSingle();
  const row = {
    tenant_id: tenantId,
    phone: key,
    first_name: String(name || 'Website visitor').trim() || 'Website visitor',
    email: email || null,
    updated_at: new Date().toISOString()
  };
  const query = existing?.id
    ? c.from('clients').update(row).eq('id', existing.id).eq('tenant_id', tenantId)
    : c.from('clients').insert(row);
  const { data, error } = await query.select().maybeSingle();
  if(error) throw error;
  return data;
}

export async function getClientByPhone(tenantId, phone){
  const c = db();
  if(!c) return null;
  const { data } = await c.from('clients').select('*')
    .eq('tenant_id', tenantId)
    .eq('phone', e164(phone))
    .maybeSingle();
  return data;
}

// ── SMS COMPLIANCE (10DLC: STOP must be honored and persisted) ──
export async function setOptOut(tenantId, phone, optedOut){
  const c = db();
  if(!c || !tenantId) return null;
  const phoneE = e164(phone);
  if(!phoneE) return null;
  const { data: existing } = await c.from('clients').select('id')
    .eq('tenant_id', tenantId).eq('phone', phoneE).maybeSingle();
  // Opt-out is represented as a status value in the canonical schema; the
  // legacy `opted_out` boolean is a GENERATED column (status-derived) and
  // therefore cannot be written directly.
  const patch = {
    status: optedOut ? 'opted_out' : 'active',
    opted_out_at: optedOut ? new Date().toISOString() : null,
    updated_at: new Date().toISOString()
  };
  const query = existing?.id
    ? c.from('clients').update(patch).eq('id', existing.id).eq('tenant_id', tenantId)
    : c.from('clients').insert({ tenant_id: tenantId, phone: phoneE, first_name: 'Client', ...patch });
  const { data, error } = await query.select().maybeSingle();
  if(error) throw error;
  return data;
}

export async function isOptedOut(tenantId, phone){
  const c = db();
  if(!c || !tenantId) return false; // demo mode: never block sends
  const { data } = await c.from('clients').select('opted_out')
    .eq('tenant_id', tenantId).eq('phone', e164(phone)).maybeSingle();
  return !!data?.opted_out;
}

// ── CONVERSATIONS + MESSAGES ──
export async function startConversation(tenantId, { clientId, channel, agent='lola' }){
  const c = db();
  if(!c) return null;
  const { data } = await c.from('conversations').insert({
    tenant_id: tenantId, client_id: clientId, channel, agent
  }).select().single();
  return data;
}

export async function endConversation(conversationId, { outcome, intent }={}){
  const c = db();
  if(!c) return null;
  await c.from('conversations').update({
    ended_at: new Date().toISOString(), status: 'closed', outcome, intent
  }).eq('id', conversationId);
}

export async function logMessage({ conversationId, tenantId, role, agent='lola', content }){
  const c = db();
  if(!c) return null;
  await c.from('messages').insert({
    conversation_id: conversationId, tenant_id: tenantId, role, agent, content
  });
}

export async function getOrStartConversation(tenantId, { clientId, channel, agent='lola' }){
  const c = db();
  if(!c) return null;
  const cutoff = new Date(Date.now() - 60*60*1000).toISOString();
  const { data: open } = await c.from('conversations').select('*')
    .eq('tenant_id', tenantId).eq('channel', channel).eq('status', 'open')
    .eq('client_id', clientId)
    .gte('started_at', cutoff)
    .order('started_at', { ascending: false })
    .limit(1).maybeSingle();
  if(open) return open;
  return startConversation(tenantId, { clientId, channel, agent });
}

export async function getConversationHistory(conversationId, limit=12){
  const c = db();
  if(!c) return [];
  const { data } = await c.from('messages').select('role, content')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(limit);
  return (data||[]).map(m => ({ role: m.role, content: m.content }));
}

// ── CALLS ──
// Writes to the canonical calls contract (see migrations/20260812_calendar_core.sql):
//   telnyx_call_control_id, duration_seconds, status, recording_url.
// The legacy columns (outcome, duration_sec, telnyx_call_id, transcript) do not
// exist on the production table — outcome maps onto `status`, durationSec onto
// `duration_seconds`, and transcript/recording_url live on the call row too.
export async function logCall({ tenantId, conversationId, clientId, fromNumber, toNumber, direction, durationSec, outcome, transcript, telnyxCallId }){
  const c = db();
  if(!c) return null;
  const { data } = await c.from('calls').insert({
    tenant_id: tenantId, client_id: clientId,
    from_number: e164(fromNumber), to_number: e164(toNumber),
    direction, duration_seconds: durationSec, status: outcome || 'answered',
    recording_url: transcript || null, telnyx_call_control_id: telnyxCallId || null
  }).select().maybeSingle();
  return data;
}

// ── BOOKINGS ──
// Canonical bookings contract (migrations/20260812_calendar_core.sql):
//   service_id, staff_id, start_time, end_time, total_amount, source.
export async function createBooking(tenantId, { clientId, conversationId, service, stylist, startsAt, durationMin, price }){
  const c = db();
  if(!c) return null;
  const end = new Date(new Date(startsAt).getTime() + (Number(durationMin) || 60) * 60000).toISOString();
  const { data } = await c.from('bookings').insert({
    tenant_id: tenantId, client_id: clientId, conversation_id: conversationId,
    service_id: service?.id || null, staff_id: stylist?.id || null,
    start_time: startsAt, end_time: end, total_amount: price || 0,
    source: 'lola', status: 'confirmed'
  }).select().single();
  return data;
}

// Records which connected external platform a booking was also pushed to,
// and that platform's own appointment ID — so a later reschedule/cancel
// can be synced out to the same place. See migrations/20260810_booking_external_sync.sql
export async function updateBookingExternalRef(bookingId, { external_id, source }){
  const c = db();
  if(!c) return null;
  const { data } = await c.from('bookings').update({ external_id, source }).eq('id', bookingId).select().maybeSingle();
  return data;
}

// ── USAGE METER (for billing later) ──
export async function logUsage(tenantId, kind, units=1, metadata={}){
  const c = db();
  if(!c) return null;
  await c.from('usage_events').insert({
    tenant_id: tenantId, kind, units, metadata
  });
}

// ── ONBOARDING: create / update a tenant ──
export function slugify(s){
  return (s || 'salon').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

// Create the tenant + owner membership + onboarding row for a freshly
// authenticated user (email/password signup or a first-time Google OAuth).
// Idempotent on owner_email so a retried OAuth callback can never mint a
// duplicate workspace for the same email.
export async function provisionTenantForUser(user, opts = {}){
  const c = db();
  if(!c || !user?.id) return null;
  const email = String(user.email || opts.email || '').toLowerCase();
  const ownerName = opts.name || user.user_metadata?.name || user.user_metadata?.full_name || (email ? email.split('@')[0] : 'My Salon');
  const salonName = opts.salonName || ownerName || 'My Salon';
  const trialEnds = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString();

  // Reuse a workspace this email already owns (idempotency for OAuth retries).
  if(email){
    const { data: existing } = await c.from('tenants').select('*').eq('owner_email', email).limit(1);
    if(existing?.[0]){
      await c.from('tenant_users').upsert(
        { tenant_id: existing[0].id, user_id: user.id, role: 'owner' },
        { onConflict: 'tenant_id,user_id' }
      );
      return existing[0];
    }
  }

  const slug = (slugify(salonName) || 'salon') + '-' + Math.random().toString(36).slice(2, 6);
  const tenant = await upsertTenant({
    slug, name: salonName, owner_name: ownerName, owner_email: email,
    location: opts.location || '', hours: opts.hours || '', plan: opts.plan || 'starter',
    website_url: opts.websiteUrl || '', business_mode: opts.businessMode || 'salon',
    trial_ends_at: trialEnds,
    activation_status: opts.activationStatus
  });
  if(!tenant?.id) return null;

  const linked = await c.from('tenant_users').upsert(
    { tenant_id: tenant.id, user_id: user.id, role: 'owner' },
    { onConflict: 'tenant_id,user_id' }
  );
  if(linked.error) throw linked.error;

  const onboarding = await c.from('tenant_onboarding').upsert({
    tenant_id: tenant.id,
    stage: 'business',
    status: 'in_progress',
    progress: 10,
    business: {
      name: tenant.name,
      location: tenant.location || '',
      website_url: tenant.website_url || '',
      business_mode: tenant.business_mode || 'salon'
    },
    booking: {},
    channels: {},
    persona: { persona: tenant.persona || 'warm' },
    provisioning: {}
  }, { onConflict: 'tenant_id' });
  if(onboarding.error && !/tenant_onboarding/i.test(onboarding.error.message || '')) throw onboarding.error;

  return tenant;
}

export async function upsertTenant(p = {}){
  const c = db();
  if(!c) return null;
  const ownerName  = p.ownerName  ?? p.owner_name;
  const ownerEmail = p.ownerEmail ?? p.owner_email;
  const bookingUrl = p.bookingUrl ?? p.booking_url;
  const phoneNumber= p.phoneNumber?? p.phone_number;
  const websiteUrl = p.websiteUrl ?? p.website_url;
  const businessMode = p.businessMode ?? p.business_mode;
  const { slug, name, location, hours, plan, services, team, persona } = p;
  const trialEndsAt = p.trial_ends_at ?? p.trialEndsAt;
  const row = {
    slug, name,
    owner_name: ownerName, owner_email: ownerEmail,
    location, hours, booking_url: bookingUrl,
    phone_number: phoneNumber ? e164(phoneNumber) : null,
    plan: plan || 'starter',
    persona: persona || 'warm',
    voice_id: p.voiceId ?? p.voice_id ?? null,
    website_url: websiteUrl || null,
    business_mode: businessMode || 'salon'
  };
  if(trialEndsAt) row.trial_ends_at = trialEndsAt;
  if(services) row.services = services;
  if(team) row.team = team;
  if(p.activation_status || p.activationStatus) row.activation_status = p.activation_status ?? p.activationStatus;
  const { data } = await c.from('tenants')
    .upsert(row, { onConflict: 'slug' })
    .select().maybeSingle();
  return data;
}

// ── INTEGRATIONS (Square / Boulevard / Shopify / Google Calendar OAuth) ──
export async function upsertIntegration(tenantId, { provider, accessToken, refreshToken, expiresAt, metadata={} }){
  const c = db();
  if(!c) return null;
  const row = {
    tenant_id: tenantId,
    provider,
    access_token: accessToken != null ? encrypt(accessToken) : null,
    refresh_token: refreshToken != null ? encrypt(refreshToken) : null,
    expires_at: expiresAt || null,
    status: 'connected',
    metadata
  };
  const { data, error } = await c.from('integrations')
    .upsert(row, { onConflict: 'tenant_id,provider' })
    .select().maybeSingle();
  if(error) throw new Error(error.message);
  return data;
}

export async function getTenantIntegrations(tenantId, { status='connected' } = {}){
  const c = db();
  if(!c || !tenantId) return [];
  let q = c.from('integrations').select('*').eq('tenant_id', tenantId);
  if(status) q = q.eq('status', status);
  const { data, error } = await q;
  if(error || !data) return [];
  return data.map(row => ({
    ...row,
    access_token: decrypt(row.access_token),
    refresh_token: decrypt(row.refresh_token)
  }));
}

// ── Partial update for an EXISTING tenant by id (used by Settings) ──
export async function updateTenantFields(tenantId, patch = {}){
  const c = db();
  if(!c || !tenantId) return null;
  // voice_id is intentionally NOT in the allow-list — Lola's voice is
  // canonical platform-wide and cannot be changed per tenant.
  const allowed = ['name','owner_name','location','hours','booking_url','website_url','gmb_url','business_mode','persona','services','team','phone_number','operator_phone','autopilot_enabled','yelp_review_url','google_review_url','instructions','missed_call_textback','review_requests'];
  const row = {};
  for(const k of allowed){ if(patch[k] !== undefined) row[k] = patch[k]; }
  
  if(patch.knowledge !== undefined) {
    // knowledge is a freeform text column ("teach Lola" notes). The old code
    // spread it as an object — {...'some text'} yields {0:'s',1:'o',...} —
    // so Settings returned 200 while persisting garbage. Caught by e2e/run.mjs.
    row.knowledge = typeof patch.knowledge === 'string'
      ? patch.knowledge
      : JSON.stringify(patch.knowledge);
  }

  if(Object.keys(row).length === 0) return null;
  const { data, error } = await c.from('tenants').update(row).eq('id', tenantId).select().maybeSingle();
  if(error) throw new Error(error.message);
  return data;
}

export async function saveTenantKnowledge(tenantId, knowledge){
  const c = db();
  if(!c) return null;
  const patch = { knowledge };
  if(knowledge?.services_detected?.length){
    const { data: t } = await c.from('tenants').select('services').eq('id', tenantId).maybeSingle();
    if(t && (!t.services || t.services.length === 0)){
      patch.services = knowledge.services_detected.map(s => {
        const m = String(s).match(/^(.*?)\s*\$?(\d+)?/);
        return { name: (m?.[1]||s).trim(), price: m?.[2] ? Number(m[2]) : null };
      });
    }
  }
  const { data } = await c.from('tenants').update(patch).eq('id', tenantId).select().maybeSingle();
  return data;
}

// ── Build the knowledge text block Lola uses on calls for this tenant ──
export function tenantKnowledgePrompt(tenant){
  if(!tenant) return '';
  const k = tenant.knowledge || {};
  const lines = [];
  if(tenant.name) lines.push(`Business: ${tenant.name}`);
  if(tenant.business_mode) lines.push(`Type: ${tenant.business_mode}`);
  if(tenant.location) lines.push(`Location: ${tenant.location}`);
  if(tenant.hours) lines.push(`Hours: ${tenant.hours}`);
  const svc = (tenant.services||[]).map(s=>`${s.name}${s.price?` $${s.price}`:''}${s.duration?` (${s.duration})`:''}`).join('; ');
  if(svc) lines.push(`Services: ${svc}`);
  if(tenant.booking_url) lines.push(`Booking link: ${tenant.booking_url}`);
  if(tenant.website_url) lines.push(`Website: ${tenant.website_url}`);
  if(tenant.gmb_url) lines.push(`Google Business (Maps) profile: ${tenant.gmb_url}`);
  if(tenant.google_review_url) lines.push(`Google review page: ${tenant.google_review_url}`);
  if(tenant.yelp_review_url) lines.push(`Yelp profile: ${tenant.yelp_review_url}`);
  if(k.positioning) lines.push(`Positioning: ${k.positioning}`);
  if(k.tone) lines.push(`Brand voice: ${k.tone}`);
  if(k.summary) lines.push(`About: ${k.summary}`);
  if(k.audience) lines.push(`Typical clients: ${k.audience}`);
  // Owner-written "special instructions" from Settings > Lola AI — she follows
  // these verbatim on every call and text.
  if(tenant.instructions) lines.push(`Owner instructions: ${tenant.instructions}`);
  if(k.upsells && k.upsells.length > 0) {
    const upsellText = k.upsells.map(u => `- When they ask for ${u.trigger}, suggest adding ${u.offer} for $${u.price} (Pitch: "${u.pitch}")`).join('\n');
    lines.push(`UPSELL PROTOCOL:\n${upsellText}`);
  }
  return lines.join('\n');
}

// ── NEW: Client memory helpers ──
export async function getClientMemory(tenantId, phone){
  const c = db(); if(!c) return [];
  const phoneE = String(phone||'').includes(':') ? String(phone).slice(0,64) : e164(phone);
  const { data } = await c.from('client_memories').select('key,value,created_at').eq('tenant_id', tenantId).eq('client_phone', phoneE);
  return data || [];
}

export async function setClientMemory(tenantId, phone, key, value){
  const c = db(); if(!c) return null;
  // Namespaced identities ('web:<visitor>', etc) are keys, not phones —
  // e164() would mangle them into a bare '+'; pass them through verbatim.
  const phoneE = String(phone||'').includes(':') ? String(phone).slice(0,64) : e164(phone);
  const { data } = await c.from('client_memories').upsert({ tenant_id: tenantId, client_phone: phoneE, key, value }, { onConflict: 'tenant_id,client_phone,key' }).select().maybeSingle();
  return data;
}

// ── Owner memory ──
// The dashboard/operator side of Lola's memory. Keyed under the literal
// client_phone 'owner' (one owner memory set per tenant) — deliberately
// NOT passed through e164(), which would mangle a non-numeric sentinel.
export async function getOwnerMemory(tenantId){
  const c = db(); if(!c) return [];
  const { data } = await c.from('client_memories').select('key,value,created_at').eq('tenant_id', tenantId).eq('client_phone', 'owner');
  return data || [];
}

export async function setOwnerMemory(tenantId, key, value){
  const c = db(); if(!c) return null;
  const { data } = await c.from('client_memories').upsert({ tenant_id: tenantId, client_phone: 'owner', key, value }, { onConflict: 'tenant_id,client_phone,key' }).select().maybeSingle();
  return data;
}

// ── Tenant memory ("Lola remembers all" — one memory set per salon) ──
// Same client_memories substrate as owner memory, keyed under the literal
// client_phone 'tenant'. Everything Lola learns about a salon — booking
// events, preferences, learned facts — lives here, isolated by tenant_id.
export async function getTenantMemory(tenantId){
  const c = db(); if(!c) return [];
  const { data } = await c.from('client_memories').select('key,value,created_at').eq('tenant_id', tenantId).eq('client_phone', 'tenant').order('created_at', { ascending: false });
  return data || [];
}

export async function setTenantMemory(tenantId, key, value){
  const c = db(); if(!c) return null;
  const { data } = await c.from('client_memories').upsert({ tenant_id: tenantId, client_phone: 'tenant', key: String(key), value }, { onConflict: 'tenant_id,client_phone,key' }).select().maybeSingle();
  return data;
}

// ── NEW: Deposits helpers ──
export async function createDeposit(tenantId, bookingId, amount){
  const c = db(); if(!c) return null;
  const { data } = await c.from('deposits').insert({ tenant_id: tenantId, booking_id: bookingId, amount }).select().maybeSingle();
  return data;
}

export async function updateDepositStatus(depositId, status, stripeIntentId){
  const c = db(); if(!c) return null;
  const { data } = await c.from('deposits').update({ status, stripe_payment_intent_id: stripeIntentId }).eq('id', depositId).select().maybeSingle();
  return data;
}

// ── NEW: Demo request helpers ──
export async function enqueueDemoRequest(phone, ip){
  const c = db(); if(!c) return null;
  const { data } = await c.from('demo_requests').insert({ phone_number: e164(phone), ip }).select().maybeSingle();
  return data;
}

export async function markDemoProcessed(id){
  const c = db(); if(!c) return null;
  const { data } = await c.from('demo_requests').update({ processed: true }).eq('id', id).select().maybeSingle();
  return data;
}

export async function recentDemoRequestsByPhone(phone, minutes=60){
  const c = db(); if(!c) return 0;
  const since = new Date(Date.now() - minutes*60*1000).toISOString();
  const phoneE = e164(phone);
  const { count } = await c.from('demo_requests').select('*', { count: 'exact' }).eq('phone_number', phoneE).gte('created_at', since);
  return Number(count || 0);
}

// ── NEW: Tenant number porting workflow ──
export async function createTenantPortRequest(tenantId, payload = {}){
  const c = db();
  if(!c || !tenantId) return null;
  const row = {
    tenant_id: tenantId,
    requested_phone_number: e164(payload.requested_phone_number),
    status: payload.status || 'draft',
    current_carrier: payload.current_carrier || null,
    account_number: payload.account_number || null,
    account_pin: payload.account_pin || null,
    billing_name: payload.billing_name || null,
    billing_address: payload.billing_address || null,
    authorized_contact_name: payload.authorized_contact_name || null,
    authorized_contact_email: payload.authorized_contact_email || null,
    telnyx_order_id: payload.telnyx_order_id || null,
    foc_date: payload.foc_date || null,
    temporary_phone_number: payload.temporary_phone_number ? e164(payload.temporary_phone_number) : null,
    metadata: payload.metadata || {}
  };
  const { data, error } = await c.from('tenant_number_ports').insert(row).select().maybeSingle();
  if(error) throw new Error(error.message);
  return data;
}

export async function updateTenantPortRequest(portRequestId, patch = {}){
  const c = db();
  if(!c || !portRequestId) return null;
  const row = {};
  const allowed = [
    'status', 'current_carrier', 'account_number', 'account_pin', 'billing_name', 'billing_address',
    'authorized_contact_name', 'authorized_contact_email', 'telnyx_order_id', 'foc_date', 'metadata'
  ];
  for(const k of allowed){
    if(patch[k] !== undefined) row[k] = patch[k];
  }
  if(patch.requested_phone_number !== undefined) row.requested_phone_number = e164(patch.requested_phone_number);
  if(patch.temporary_phone_number !== undefined) row.temporary_phone_number = patch.temporary_phone_number ? e164(patch.temporary_phone_number) : null;
  if(Object.keys(row).length === 0) return null;
  const { data, error } = await c.from('tenant_number_ports').update(row).eq('id', portRequestId).select().maybeSingle();
  if(error) throw new Error(error.message);
  return data;
}

export async function listTenantPortRequests(tenantId, limit = 20){
  const c = db();
  if(!c || !tenantId) return [];
  const { data, error } = await c.from('tenant_number_ports')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if(error) throw new Error(error.message);
  return data || [];
}
