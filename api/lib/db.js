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
