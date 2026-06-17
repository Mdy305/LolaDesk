/**
 * api/lib/db.js — Shared Supabase client + multi-tenant helpers
 * ═══════════════════════════════════════════════════════════════
 * Every /api/* handler imports from here. One source of truth.
 *
 * Server-side only. We use SUPABASE_SERVICE_KEY which bypasses RLS,
 * so the server can read/write any tenant's data — we enforce tenant
 * isolation in code by ALWAYS scoping queries to a resolved tenant_id.
 *
 * ENV VARS (Vercel → Settings → Environment Variables):
 *   SUPABASE_URL              public, e.g. https://xxx.supabase.co
 *   SUPABASE_SERVICE_KEY      server-side service role key (sensitive)
 *
 * NEVER ship SUPABASE_SERVICE_KEY to the browser. It only lives in
 * Vercel env vars, used only by these serverless functions.
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
// The single most important function: given a called/texted number,
// find which salon owns it. This is how multi-tenant works.
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

export async function getTenantBySlug(slug){
  const c = db();
  if(!c) return demoTenant();
  const { data } = await c.from('tenants').select('*').eq('slug', slug).maybeSingle();
  return data || demoTenant();
}

// Fallback so the app never crashes when Supabase isn't wired yet
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

// Find or start a conversation for an inbound message/call from a phone number
export async function getOrStartConversation(tenantId, { clientId, channel, agent='lola' }){
  const c = db();
  if(!c) return null;
  // Reuse an open conversation in the same channel from the last 60 minutes
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

// Pull recent message history for an ongoing conversation (for LLM context)
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
  // accept both camelCase and snake_case (signup uses snake_case)
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
// Tokens are encrypted at rest (see api/lib/crypto.js). ALWAYS use these
// helpers instead of querying the `integrations` table directly, so
// encryption/decryption can never accidentally be skipped.

// Write (or update) an integration's tokens. Called from the OAuth callback.
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

// Read all connected integrations for a tenant, decrypted and ready
// to hand to a connector (square.js, boulevard.js, etc). This is the
// ONLY place that should ever decrypt tokens — keep them in-memory,
// server-side, for the duration of the request only.
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


export async function saveTenantKnowledge(tenantId, knowledge){
  const c = db();
  if(!c) return null;
  // Merge services detected by the analysis into the tenant's services if empty
  const patch = { knowledge };
  if(knowledge?.services_detected?.length){
    // only set if tenant has no services yet
    const { data: t } = await c.from('tenants').select('services').eq('id', tenantId).maybeSingle();
    if(t && (!t.services || t.services.length === 0)){
      patch.services = knowledge.services_detected.map(s => {
        // try to parse "Balayage $395" style strings
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
  if(k.positioning) lines.push(`Positioning: ${k.positioning}`);
  if(k.tone) lines.push(`Brand voice: ${k.tone}`);
  if(k.summary) lines.push(`About: ${k.summary}`);
  if(k.audience) lines.push(`Typical clients: ${k.audience}`);
  return lines.join('\n');
}
