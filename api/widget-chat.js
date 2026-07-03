/**
 * /api/widget-chat — Lola on the TENANT'S OWN WEBSITE
 * ════════════════════════════════════════════════════════════════
 * Powers the embeddable widget (widget.js). Every salon gets a
 * copy-paste snippet; their site visitors chat with THEIR Lola —
 * same brain, same memory substrate, zero setup beyond the snippet.
 *
 * ISOLATION MODEL (public endpoint, so this is strict):
 *   · Tenant is resolved by slug + a per-tenant HMAC key
 *     (widgetKeyFor(slug)) minted at /api/widget-embed. Key must
 *     match the slug it was minted for — tenant A's key can never
 *     open tenant B's Lola.
 *   · NO demo fallback anywhere on this path. Bad key → 401.
 *   · Replies only ever draw on this tenant's own data (menu, hours,
 *     knowledge, this visitor's memory). Nothing cross-tenant.
 *   · Per-IP+visitor rate limit; message length capped.
 *
 * Visitors get durable identity: a visitor id minted by widget.js,
 * stored as clients row 'web:<id>' — so Lola REMEMBERS returning
 * website visitors exactly like callers and texters (client_memories,
 * conversations channel 'web').
 *
 *   GET  /api/widget-chat?slug&key            → public config {name, greeting}
 *   POST /api/widget-chat {slug,key,visitor_id,message} → {reply, visitor_id}
 *
 * ENV: WIDGET_EMBED_SECRET (falls back to OPERATOR_TOOLS_SECRET)
 */
import crypto from 'crypto';
import {
  getTenantBySlug, upsertWebVisitor, getClientMemory, setClientMemory,
  getOrStartConversation, getConversationHistory, logMessage, logUsage
} from './lib/db.js';
import { chat } from './lib/llm.js';
import {
  detectLolaIntent, deterministicSkillReply, buildLolaSystemPrompt,
  extractPersonalizationSignals, mergeClientProfile, profileFromMemoryRows, buildClientMemoryBlock
} from './lib/lola-skills.js';

function secret(){ return process.env.WIDGET_EMBED_SECRET || process.env.OPERATOR_TOOLS_SECRET || 'dev-only-secret-change-me'; }
export function widgetKeyFor(slug){
  return crypto.createHmac('sha256', secret()).update('widget|' + String(slug||'')).digest('hex').slice(0, 32);
}
function keyOk(slug, key){
  const want = widgetKeyFor(slug);
  const got = String(key||'');
  return got.length === want.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(got));
}

/* per-instance rate limit: 20 messages/min per ip+visitor */
const bucket = new Map();
function limited(id){
  const now = Date.now(), win = 60_000;
  const b = bucket.get(id) || [];
  const fresh = b.filter(t => now - t < win);
  if(fresh.length >= 20){ bucket.set(id, fresh); return true; }
  fresh.push(now); bucket.set(id, fresh);
  if(bucket.size > 5000) bucket.clear(); // crude memory cap
  return false;
}

function fallbackAnswer(tenant, text){
  const t = String(text||'').toLowerCase();
  let services = [];
  try{ services = Array.isArray(tenant.services) ? tenant.services : JSON.parse(tenant.services||'[]'); }catch{}
  if(/(service|menu|price|cost|how much|offer)/.test(t) && services.length)
    return `Here's our menu: ${services.map(s=>`${s.name}${s.price?` — $${s.price}`:''}`).join(', ')}. Want me to help you book one?`;
  if(/(hour|open|close|when)/.test(t) && tenant.hours) return `We're open ${tenant.hours}.`;
  if(/(where|location|address|find)/.test(t) && tenant.location) return `You'll find us at ${tenant.location}.`;
  if(/(book|appointment|schedule|come in)/.test(t))
    return tenant.booking_url
      ? `I'd love to get you in! Book right here: ${tenant.booking_url} — or leave your number and we'll text you.`
      : `I'd love to get you in! Leave your number and the service you want, and we'll text you to confirm.`;
  return `Hi! I'm Lola, ${tenant.name}'s assistant. Ask me about services, prices, hours — or let's get you booked in.`;
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*'); // embedded on tenant sites
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if(req.method === 'OPTIONS') return res.status(200).end();

  const url = new URL(req.url, 'http://x');
  const q = Object.fromEntries(url.searchParams.entries());
  const body = req.method === 'POST'
    ? (typeof req.body === 'string' ? JSON.parse(req.body||'{}') : (req.body||{}))
    : {};
  const slug = String(body.slug || q.slug || '').slice(0, 80);
  const key  = String(body.key  || q.key  || '');

  if(!slug || !keyOk(slug, key)) return res.status(401).json({ ok:false, error:'invalid widget key' });
  const tenant = await getTenantBySlug(slug);
  if(!tenant?.id) return res.status(401).json({ ok:false, error:'invalid widget key' });

  /* ── public config for the launcher ── */
  if(req.method === 'GET'){
    return res.status(200).json({ ok:true, name: tenant.name,
      greeting: `Hi! I'm Lola, ${tenant.name}'s assistant 💗 Ask me anything — or let's get you booked in.`,
      booking_url: tenant.booking_url || null });
  }
  if(req.method !== 'POST') return res.status(405).json({ ok:false });

  const visitorId = String(body.visitor_id || crypto.randomUUID()).slice(0, 64);
  const message = String(body.message || '').slice(0, 800).trim();
  if(!message) return res.status(400).json({ ok:false, error:'empty message' });
  const ip = String(req.headers['x-forwarded-for']||'').split(',')[0] || 'noip';
  if(limited(`${ip}|${visitorId}`)) return res.status(429).json({ ok:false, error:'slow down a touch 💗' });

  /* ── identity + memory (web visitors remember like callers do) ── */
  let client = null, conv = null, history = [], profile = null;
  try{
    client = await upsertWebVisitor(tenant.id, visitorId, {});
    conv = await getOrStartConversation(tenant.id, { clientId: client?.id, channel: 'web', agent: 'lola' });
    if(conv?.id) history = await getConversationHistory(conv.id, 10);
    profile = profileFromMemoryRows(await getClientMemory(tenant.id, 'web:' + visitorId));
  }catch{}

  try{
    const signals = extractPersonalizationSignals(message);
    if(signals?.hasSignal){
      profile = mergeClientProfile(profile, signals);
      await setClientMemory(tenant.id, 'web:' + visitorId, 'profile', profile).catch(()=>{});
    }
  }catch{}

  /* ── the brain: deterministic skill → LLM → grounded fallback ── */
  const intent = detectLolaIntent(message);
  let reply = deterministicSkillReply({ tenant, intent, channel: 'web', clientName: profile?.name || '' }) || '';
  if(!reply){
    const memoryBlock = buildClientMemoryBlock(profile) || '';
    const system = buildLolaSystemPrompt({ tenant, channel: 'web', intent, memoryBlock })
      + '\nYou are chatting on the salon\'s website with a potential client. Be warm and brief (1–3 sentences). Your #1 goal is getting them booked: offer to take their name, number, service, and preferred time.'
      + (tenant.booking_url ? ` Online booking link if useful: ${tenant.booking_url}` : '');
    const r = await chat({ system, messages: [...history, { role:'user', content: message }], maxTokens: 260, temperature: 0.7, source: 'widget' }).catch(()=>({ ok:false }));
    reply = (r?.ok && String(r.text||'').trim()) ? String(r.text).trim() : fallbackAnswer(tenant, message);
  }

  try{
    if(conv?.id){
      await logMessage({ conversationId: conv.id, tenantId: tenant.id, role:'user', agent:'lola', content: message });
      await logMessage({ conversationId: conv.id, tenantId: tenant.id, role:'assistant', agent:'lola', content: reply });
    }
    await logUsage(tenant.id, 'widget_message', 1);
  }catch{}

  return res.status(200).json({ ok:true, reply, visitor_id: visitorId });
}
