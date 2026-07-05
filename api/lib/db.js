/*
 * api/lib/db.js — Shared Supabase client + multi-tenant helpers
 * Extended with client memory, deposits, and demo request helpers
 */

import { createClient } from '@supabase/supabase-js';
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
    auth: { persistSession: false }
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
export async function getTenantByPhone(toNumber){
  const phone = e164(toNumber);
  const c = db();
  if(c){
    const { data, error } = await c
      .from('tenants').select('*')
      .eq('phone_number', phone)
      .maybeSingle();
    if(!error && data) return data;
  }
  // Security: an unmapped/unprovisioned number must NOT silently resolve to a
  // real tenant. Only the dedicated demo line may fall back to the demo tenant.
  const demoNum = process.env.DEMO_FROM_NUMBER ? e164(process.env.DEMO_FROM_NUMBER) : null;
  if(phone && (phone === demoNum || phone === demoTenant().phone_number)) return demoTenant();
  return null;
}
export function getDemoTenant(){ return demoTenant(); }

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
    .eq('telnyx_call_id', telnyxCallId)
    .select().maybeSingle();
  return data;
}

export async function getCallByTelnyxId(tenantId, telnyxCallId){
  const c = db();
  if(!c || !tenantId || !telnyxCallId) return null;
  const { data } = await c.from('calls').select('*')
    .eq('tenant_id', tenantId).eq('telnyx_call_id', telnyxCallId)
    .limit(1);
  return data?.[0] || null;
}

export async function getTenantBySlug(slug){
  const c = db();
  if(!c) return demoTenant();
  const { data } = await c.from('tenants').select('*').eq('slug', slug).maybeSingle();
  return data || demoTenant();
}

function demoTenant(){
  return {
    id: '00000000-0000-0000-0000-000000000000',
    slug: 'demo',
    name: 'MMΛ Salon',
    owner_name: 'Meddy',
    location: 'Miami Beach',
    hours: 'Tuesday to Saturday, noon to 8pm',
    booking_url: 'https://www.mmasalon.com/book',
    phone_number: '+19294568227',
    services: [
      { name:'Balayage', price:395, duration:'2h30' },
      { name:'Extensions', price:800, duration:'consult' },
      { name:'Hair Botox', price:325, duration:'2h' },
      { name:'Cut and Gloss', price:225, duration:'1h15' },
      { name:'Blowout', price:95, duration:'1h' }
    ],
    team: [
      { name:'Meddy', role:'Owner · Master Colorist' },
      { name:'Michelle', role:'Senior Stylist' }
    ],
    _demo: true
  };
}

// ── CLIENTS ──
export async function upsertClient(tenantId, { phone, name, email }){
  const c = db();
  if(!c) return null;
  const phoneE = e164(phone);
  const { data } = await c.from('clients').upsert(
    { tenant_id: tenantId, phone_number: phoneE, name, email },
    { onConflict: 'tenant_id,phone_number' }
  ).select().maybeSingle();
  return data;
}

// ── Web visitors (website widget) ──
// Widget visitors have no phone yet; they're identified by a stable
// visitor id stored on the tenant's site. Keyed as 'web:<id>' in the
// clients table — deliberately NOT e164()'d. When they book and share
// a real phone, the SMS/voice memory unifies on that number.
export async function upsertWebVisitor(tenantId, visitorId, { name, email } = {}){
  const c = db();
  if(!c || !visitorId) return null;
  const key = 'web:' + String(visitorId).slice(0, 64);
  const { data } = await c.from('clients').upsert(
    { tenant_id: tenantId, phone_number: key, name, email },
    { onConflict: 'tenant_id,phone_number' }
  ).select().maybeSingle();
  return data;
}

export async function getClientByPhone(tenantId, phone){
  const c = db();
  if(!c) return null;
  const { data } = await c.from('clients').select('*')
    .eq('tenant_id', tenantId)
    .eq('phone_number', e164(phone))
    .maybeSingle();
  return data;
}

// ── SMS COMPLIANCE (10DLC: STOP must be honored and persisted) ──
export async function setOptOut(tenantId, phone, optedOut){
  const c = db();
  if(!c) return null;
  const { data } = await c.from('clients').upsert(
    { tenant_id: tenantId, phone_number: e164(phone), opted_out: optedOut, opted_out_at: optedOut ? new Date().toISOString() : null },
    { onConflict: 'tenant_id,phone_number' }
  ).select().maybeSingle();
  return data;
}

export async function isOptedOut(tenantId, phone){
  const c = db();
  if(!c) return false; // demo mode: never block sends
  const { data } = await c.from('clients').select('opted_out')
    .eq('tenant_id', tenantId).eq('phone_number', e164(phone)).maybeSingle();
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
export async function logCall({ tenantId, conversationId, clientId, fromNumber, toNumber, direction, durationSec, outcome, transcript, telnyxCallId }){
  const c = db();
  if(!c) return null;
  const { data } = await c.from('calls').insert({
    tenant_id: tenantId, conversation_id: conversationId, client_id: clientId,
    from_number: e164(fromNumber), to_number: e164(toNumber),
    direction, duration_sec: durationSec, outcome, transcript, telnyx_call_id: telnyxCallId
  }).select().maybeSingle();
  return data;
}

// ── BOOKINGS ──
export async function createBooking(tenantId, { clientId, conversationId, service, stylist, startsAt, durationMin, price }){
  const c = db();
  if(!c) return null;
  const { data } = await c.from('bookings').insert({
    tenant_id: tenantId, client_id: clientId, conversation_id: conversationId,
    service, stylist, starts_at: startsAt, duration_min: durationMin, price
  }).select().single();
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
    website_url: websiteUrl || null,
    business_mode: businessMode || 'salon'
  };
  if(trialEndsAt) row.trial_ends_at = trialEndsAt;
  if(services) row.services = services;
  if(team) row.team = team;
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
  const allowed = ['name','location','hours','booking_url','persona','services','team','phone_number'];
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
  let k = tenant.knowledge || {};
  if(typeof k === 'string'){ const s=k; try{ k = JSON.parse(s); }catch{ k = s.trim() ? { summary: s } : {}; } }
  const lines = [];
  if(tenant.name) lines.push(`Business: ${tenant.name}`);
  if(tenant.business_mode) lines.push(`Type: ${tenant.business_mode}`);
  if(tenant.location) lines.push(`Location: ${tenant.location}`);
  if(tenant.hours) lines.push(`Hours: ${tenant.hours}`);
  const svc = (tenant.services||[]).map(s=>`${s.name}${s.price?` $${s.price}`:''}${s.duration?` (${s.duration})`:''}`).join('; ');
  if(svc) lines.push(`Services: ${svc}`);
  if(tenant.booking_url) lines.push(`Booking link: ${tenant.booking_url}`);
  if(k.positioning) lines.push(`Positioning: ${k.positioning}`);
  if(k.tone) lines.push(`Brand voice: ${k.tone}`);
  if(k.summary) lines.push(`About: ${k.summary}`);
  if(k.audience) lines.push(`Typical clients: ${k.audience}`);
  if(k.upsells && k.upsells.length > 0) {
    const upsellText = k.upsells.map(u => `- When they ask for ${u.trigger}, suggest adding ${u.offer} for $${u.price} (Pitch: "${u.pitch}")`).join('\n');
    lines.push(`UPSELL PROTOCOL:\n${upsellText}`);
  }
  if(k.documents_digest) lines.push(`REFERENCE KNOWLEDGE (from the salon's uploaded documents & reviews — use these facts when relevant):\n${k.documents_digest}`);
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

