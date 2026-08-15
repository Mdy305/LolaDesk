/**
 * lib/onboarding-engine.js — the ONE onboarding brain
 * ════════════════════════════════════════════════════════════════════
 * Steve-Jobs-grade onboarding: the owner should do almost nothing, and
 * every step should feel like a reveal, not a form.
 *
 *   • ONE NEXT STEP — journey() always returns exactly one `next` action,
 *     so the UI never presents a wall of fields. Progressive disclosure.
 *   • SHOW, DON'T TELL — discovery reads the owner's website with the LLM,
 *     drafts their service menu and brand voice automatically, and hands
 *     back Lola's *actual opening line* so they hear their AI before launch.
 *   • ZERO RETYPING — applyDiscovery fills tenants.services only when the
 *     owner hasn't already set a menu; review steps default to what Lola
 *     learned.
 *   • THE PAYOFF — celebrate() is the go-live moment: Lola's first words.
 *
 * Everything is tenant-scoped by the caller (each handler resolves the
 * tenant first and passes the tenant row + its own Supabase client).
 */

import { chat } from './llm.js';

export const STAGES = {
  business:      { order: 1, progress: 20, label: 'Who you are' },
  discovery:     { order: 2, progress: 50, label: 'Lola reads your business' },
  configuration: { order: 3, progress: 80, label: 'Approve & connect' },
  activation:    { order: 4, progress: 95, label: 'Go live' },
  complete:      { order: 5, progress: 100, label: 'Live' }
};

// ── SSRF guard for website discovery ──────────────────────────────
export function safePublicUrl(value){
  if(!value) return '';
  // Accept bare domains like "salon.com" — assume https (as the legacy
  // /api/onboard flow did) so a pasted address "just works".
  let raw = String(value).trim();
  if(!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = 'https://' + raw;
  let url;
  try{ url = new URL(raw); }catch{ return ''; }
  if(!['http:','https:'].includes(url.protocol)) throw new Error('Only http/https URLs are supported');
  const host = url.hostname.toLowerCase();
  if(host === 'localhost' || host === '127.0.0.1' || host === '::1' ||
     /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(host)){
    throw new Error('Private network URLs are not allowed');
  }
  return url.toString();
}

// ── Heuristic fallback when the LLM is unreachable ─────────────────
export function extractSite(html){
  const text = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi,' ')
    .replace(/<style[\s\S]*?<\/style>/gi,' ')
    .replace(/<[^>]+>/g,' ')
    .replace(/&nbsp;/g,' ')
    .replace(/\s+/g,' ').trim();
  const title = (String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/<[^>]+>/g,' ').trim();
  const description = (String(html).match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i)?.[1] || '').trim();
  const prices = [...text.matchAll(/(?:\$|USD\s?)(\d{2,5}(?:\.\d{1,2})?)/g)].slice(0,30).map(m => Number(m[1]));
  return { title: title.slice(0,180), description: description.slice(0,500), summary: text.slice(0,6000), prices };
}

function cleanService(s){
  if(!s) return null;
  if(typeof s === 'string'){
    const name = String(s).trim();
    if(!name) return null;
    const m = name.match(/^(.*?)\s*\$?(\d+(?:\.\d{1,2})?)$/);
    return m ? { name: m[1].trim(), price: Number(m[2]), duration: '' } : { name, price: 0, duration: '' };
  }
  const name = String(s.name || '').trim();
  if(!name) return null;
  return { name, price: Number(s.price || 0), duration: String(s.duration || s.dur || '').trim() };
}

// ── The magic: read a website and extract everything Lola needs ────
export async function discoverWebsite({ websiteUrl, businessMode = 'salon', name = '' }){
  const url = safePublicUrl(websiteUrl);
  if(!url) throw new Error('A website URL is required');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  let response;
  try{
    response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'LolaDesk-Business-Discovery/1.0' }
    });
  }finally{ clearTimeout(timer); }
  if(!response.ok) throw new Error(`Website returned ${response.status}`);

  const html = (await response.text()).slice(0, 750000);
  const fallback = extractSite(html);

  const system = [
    `You are Lola, an ultra-sharp AI receptionist onboarding a new ${businessMode || 'business'}${name ? ` called "${name}"` : ''}.`,
    `You just read their public website. Extract everything you need to answer their phones.`,
    `Return STRICT JSON only (no markdown, no commentary) with exactly these keys:`,
    `{"summary":"2-3 sentence description","positioning":"luxury/value/clinical/boutique/etc","audience":"who they serve","tone":"their brand voice","hours":"opening hours if visible else empty string","services_detected":[{"name":"service","price":0,"duration":""}],"usp":"what makes them special","opportunities":["2-3 concrete ways to grow"]}`
  ].join('\n');

  let knowledge = null, provider = null, usedLlm = false;
  try{
    const result = await chat({
      system,
      messages: [{ role: 'user', content: `Website: ${url}\nTitle: ${fallback.title}\nDescription: ${fallback.description}\nContent:\n"""${fallback.summary}"""` }],
      maxTokens: 1600,
      temperature: 0.4
    });
    if(result?.ok){
      const cleaned = String(result.text || '').replace(/```json|```/g, '').trim();
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');
      if(start >= 0 && end > start){
        knowledge = JSON.parse(cleaned.slice(start, end + 1));
        provider = result.provider;
        usedLlm = true;
      }
    }
  }catch(_e){ /* fall through to heuristic */ }

  if(!knowledge){
    knowledge = {
      summary: fallback.summary.slice(0, 400),
      title: fallback.title,
      description: fallback.description,
      positioning: null, audience: null, tone: null, hours: '',
      services_detected: [], usp: null, opportunities: [], _heuristic: true
    };
  }

  const services = (Array.isArray(knowledge.services_detected) ? knowledge.services_detected : [])
    .map(cleanService).filter(Boolean).slice(0, 40);
  knowledge.services_detected = services;

  return {
    ok: true,
    knowledge,
    provider,
    usedLlm,
    website: { title: fallback.title, description: fallback.description, prices: fallback.prices }
  };
}

function toneToPersona(tone){
  const t = String(tone || '').toLowerCase();
  if(/luxur|premium|high.end|upscale|exclusive|elegant/.test(t)) return 'luxury';
  if(/clinic|medical|doctor|dental|surgical|med.spa/.test(t)) return 'clinical';
  if(/fun|playful|bold|edgy|trendy/.test(t)) return 'playful';
  if(/friendly|warm|approachable|cozy/.test(t)) return 'warm';
  return null;
}

// ── Apply what Lola learned: fill the menu, voice, and brand ───────
export async function applyDiscovery(client, tenant, knowledge){
  const services = (Array.isArray(knowledge.services_detected) ? knowledge.services_detected : [])
    .map(cleanService).filter(Boolean);

  const existing = Array.isArray(tenant.services) ? tenant.services : [];
  const persona = toneToPersona(knowledge.tone);
  // Preserve any knowledge already stored (object or JSON-string form).
  let prior = {};
  try{
    if(typeof tenant.knowledge === 'string' && tenant.knowledge.trim()) prior = JSON.parse(tenant.knowledge);
    else if(tenant.knowledge && typeof tenant.knowledge === 'object' && !Array.isArray(tenant.knowledge)) prior = tenant.knowledge;
  }catch{ prior = {}; }

  const patch = {};
  // Never overwrite a menu the owner already set by hand.
  if(existing.length === 0 && services.length) patch.services = services;
  if(persona) patch.persona = persona;
  if(knowledge.hours && !tenant.hours) patch.hours = String(knowledge.hours).slice(0, 120);
  // Top-level learned fields feed tenantKnowledgePrompt(); the .website key
  // keeps the discovery snapshot (title/description/opportunities/hours).
  patch.knowledge = {
    ...prior,
    summary: knowledge.summary || prior.summary || null,
    positioning: knowledge.positioning || prior.positioning || null,
    audience: knowledge.audience || prior.audience || null,
    tone: knowledge.tone || prior.tone || null,
    usp: knowledge.usp || prior.usp || null,
    opportunities: Array.isArray(knowledge.opportunities) ? knowledge.opportunities : (Array.isArray(prior.opportunities) ? prior.opportunities : []),
    website: {
      title: knowledge.title || null,
      description: knowledge.description || null,
      summary: knowledge.summary || null,
      positioning: knowledge.positioning || null,
      audience: knowledge.audience || null,
      tone: knowledge.tone || null,
      usp: knowledge.usp || null,
      opportunities: Array.isArray(knowledge.opportunities) ? knowledge.opportunities : [],
      hours: knowledge.hours || null
    }
  };

  if(!client) return { services, persona, knowledge: patch.knowledge.website };
  if(Object.keys(patch).length){
    await client.from('tenants').update(patch).eq('id', tenant.id);
  }
  return { services, persona, knowledge: patch.knowledge.website };
}

// ── Lola's actual opening line (the reveal) ────────────────────────
export function previewGreeting(tenant){
  const name = tenant.name || 'your business';
  const services = (Array.isArray(tenant.services) ? tenant.services : [])
    .map(s => (typeof s === 'string' ? s : (s && s.name)))
    .filter(Boolean);
  const first = services[0], second = services[1];
  if(first && second){
    return `Hi, thanks for calling ${name}! This is Lola — should I get you on the books for ${first} or ${second} today?`;
  }
  if(first){
    return `Hi, thanks for calling ${name}! This is Lola — can I book you in for ${first} today?`;
  }
  return `Hi, you've reached ${name}. This is Lola — how can I help you today?`;
}

function delightFor(stage, tenant){
  if(stage === 'complete'){
    return { kind: 'live', headline: `${tenant.name || 'Your business'} is live`, sub: 'Lola is answering right now.', lola_says: previewGreeting(tenant) };
  }
  if(stage === 'activation'){
    return { kind: 'almost', headline: 'One tap away', sub: 'Your Lola is dressed, trained, and ready to open the door.', lola_says: previewGreeting(tenant) };
  }
  if(stage === 'configuration'){
    return { kind: 'learning', headline: 'Lola already drafted your menu', sub: 'Approve it — she did the typing.', lola_says: previewGreeting(tenant) };
  }
  return null;
}

// ── The single source of truth for where the owner is ──────────────
export async function journey(client, tenant){
  const { data: ob } = await client.from('tenant_onboarding').select('*').eq('tenant_id', tenant.id).maybeSingle();
  const o = ob || {};
  const b = (o.business && typeof o.business === 'object') ? o.business : {};

  const hasIdentity = !!tenant.name;
  const discovered = !!(b.discovered || ['discovery','configuration','activation','complete'].includes(o.stage));
  const services = Array.isArray(tenant.services) ? tenant.services : [];
  const hasServices = services.length > 0;
  const hasBooking = !!(tenant.booking_url || (o.booking && o.booking.booking_url));
  const hasPhone = !!tenant.phone_number;
  const live = tenant.status === 'live' || o.status === 'complete';

  const done = [];
  if(hasIdentity) done.push({ id: 'identity', label: 'Business identity' });
  if(discovered) done.push({ id: 'discovery', label: 'Lola learned your business' });
  if(hasServices) done.push({ id: 'services', label: `Service menu (${services.length})` });
  if(hasBooking) done.push({ id: 'booking', label: 'Booking destination' });
  if(hasPhone) done.push({ id: 'phone', label: 'Lola phone line' });

  // One obvious next step, in strict order. Discovery is an accelerator
  // (it auto-fills the menu), not a gate: an owner without a website can
  // still reach the services step and keep going.
  const identityStep  = { id: 'identity',  title: 'Tell Lola who you are', hint: "Just your name and location — she'll take it from there.", action: 'POST /api/onboarding/step1', endpoint: '/api/onboarding/step1' };
  const discoveryStep = { id: 'discovery', title: 'Introduce Lola to your website', hint: 'Paste your URL and watch her read it — menu, prices, brand voice — in seconds. No site? Add your menu by hand instead.', action: 'POST /api/onboarding/step2-ingest', endpoint: '/api/onboarding/step2-ingest' };
  const servicesStep  = { id: 'services',  title: 'Review the menu Lola learned', hint: 'She already drafted it — approve or tweak it.', action: 'POST /api/onboarding/step3-configure', endpoint: '/api/onboarding/step3-configure' };
  const bookingStep   = { id: 'booking',   title: 'Point Lola at your calendar', hint: 'Where should new bookings land?', action: 'POST /api/onboarding/step3-configure', endpoint: '/api/onboarding/step3-configure' };
  const phoneStep     = { id: 'phone',     title: 'Give Lola her own number', hint: "One tap — she'll pick one and start answering.", action: 'POST /api/onboarding/step4-deploy', endpoint: '/api/onboarding/step4-deploy' };
  const launchStep    = { id: 'launch',    title: 'One tap — Lola goes live', hint: "She's ready. This is the moment.", action: 'POST /api/onboarding/step4-deploy', endpoint: '/api/onboarding/step4-deploy' };

  let stage, progress, status, next = null;
  if(live){
    stage = 'complete'; progress = 100; status = 'complete';
  }else{
    if(!hasIdentity) next = identityStep;
    else if(!hasServices && !discovered) next = discoveryStep;
    else if(!hasServices) next = servicesStep;
    else if(!hasBooking) next = bookingStep;
    else if(!hasPhone) next = phoneStep;
    else next = launchStep;

    const stageByNext = { identity:'business', discovery:'discovery', services:'configuration', booking:'configuration', phone:'activation', launch:'activation' };
    stage = stageByNext[next?.id] || 'business';
    progress = STAGES[stage].progress;
    status = 'in_progress';
  }

  return {
    stage,
    progress,
    status,
    done,
    next,
    delight: delightFor(stage, tenant),
    tenant: { id: tenant.id, name: tenant.name, phone_number: tenant.phone_number }
  };
}

// ── The go-live payoff ─────────────────────────────────────────────
export function celebrate(tenant){
  const line = previewGreeting(tenant);
  return {
    kind: 'live',
    headline: `${tenant.name || 'Your business'} is live.`,
    sub: 'Lola is answering your phone right now.',
    lola_says: line,
    one_more_thing: `Call ${tenant.phone_number || 'your new Lola number'} and hear her open with: "${line}"`
  };
}
