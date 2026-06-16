/**
 * /api/marketer — The Marketer agent
 * ════════════════════════════════════════════════════════════════
 * Three modes:
 *   action=analyze   { url }                       → fetch + analyze any URL (own site or competitor)
 *   action=strategy  { analysis, salon, goals }    → write a smart strategy from the analysis
 *   action=campaign  { type, tenant, audience }    → draft a full campaign (subject, copy, send plan)
 *
 * Routes all LLM calls through api/lib/llm.js → Telnyx Inference by default,
 * Anthropic if LLM_PROVIDER=anthropic.
 *
 * ENV VARS:
 *   TELNYX_API_KEY    (required)
 *   LLM_PROVIDER      'telnyx' (default) | 'anthropic'
 */

import { chat } from './lib/llm.js';

// Helper: fetch a URL's HTML and strip down to readable text for the model
async function fetchSite(url){
  try{
    if(!/^https?:\/\//i.test(url)) url = 'https://' + url;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 LolaDeskMarketer/1.0' },
      redirect: 'follow'
    });
    if(!r.ok) return { ok:false, error:`HTTP ${r.status}`, url };
    const html = await r.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi,' ')
      .replace(/<style[\s\S]*?<\/style>/gi,' ')
      .replace(/<!--[\s\S]*?-->/g,' ')
      .replace(/<[^>]+>/g,' ')
      .replace(/&nbsp;/g,' ')
      .replace(/\s+/g,' ')
      .trim()
      .slice(0, 8000);
    const title = (html.match(/<title[^>]*>([^<]+)<\/title>/i)||[])[1]?.trim() || '';
    const metaDesc = (html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)/i)||[])[1] || '';
    return { ok:true, url, title, metaDesc, text };
  }catch(e){
    return { ok:false, error:String(e), url };
  }
}

function tryJSON(text){
  if(!text) return null;
  const cleaned = text.replace(/```json|```/g,'').trim();
  try{ return JSON.parse(cleaned); }catch{ return null; }
}

// ── MODE 1: ANALYZE A URL ──
async function analyze({ url, context }){
  const site = await fetchSite(url);
  if(!site.ok) return { ok:false, error: site.error || 'Could not fetch URL', url };

  const system = `You are the Marketer agent for LolaDesk, an AI front-desk product for salons and med-spas.
You analyze websites and surface marketing insights a salon owner can act on. Be honest, sharp, specific. Do not be vague.

Return STRICT JSON only, no prose around it, with this shape:
{
  "summary": "2-3 sentences on what this site/brand is doing",
  "positioning": "what positioning are they signaling (luxury/value/clinical/playful/etc)",
  "audience": "who they appear to target",
  "strengths": ["3-5 specific strengths"],
  "gaps": ["3-5 specific gaps or weaknesses"],
  "services_detected": ["any services you can identify with prices if visible"],
  "tone": "the voice/tone they're using",
  "opportunities": ["3-5 concrete marketing opportunities to act on"]
}`;

  const user = `URL: ${site.url}
Title: ${site.title}
Meta description: ${site.metaDesc}
${context ? 'Context from the salon owner: '+context+'\n' : ''}
Site content:
"""
${site.text}
"""`;

  const result = await chat({
    system,
    messages: [{ role:'user', content: user }],
    maxTokens: 1500,
    jsonMode: true
  });

  if(!result.ok){
    return { ok:false, error: result.error || 'LLM call failed', provider: result.provider, url: site.url };
  }
  const parsed = tryJSON(result.text);
  if(!parsed){
    return { ok:true, url:site.url, title:site.title, raw:result.text, parsed:null, provider:result.provider };
  }
  return { ok:true, url:site.url, title:site.title, provider:result.provider, ...parsed };
}

// ── MODE 2: STRATEGY ──
async function strategy({ analysis, salon, goals }){
  const system = `You are the Marketer agent for LolaDesk. You write smart, concrete marketing strategies for salons and med-spas.
You are not a content mill. Be sharp, specific, prioritized, and honest.

Return STRICT JSON only:
{
  "headline": "one-line strategic position",
  "positioning_shift": "what positioning move (if any) the salon should make",
  "top_priorities": [{ "title":"...", "why":"...", "first_action":"..." }, ... 3 to 5 items],
  "campaigns_to_run": [{ "name":"...", "audience":"...", "channel":"sms|email|instagram|whatsapp|voice", "expected_roi":"...", "frequency":"..." }, ... 3 to 5 items],
  "do_not_do": ["2-3 things the salon should explicitly stop or avoid"],
  "north_star_metric": "the one number to optimize"
}`;

  const user = `Salon: ${JSON.stringify(salon||{})}
Goals: ${goals || 'Grow revenue, fill chairs, retain VIPs'}
Site analysis: ${JSON.stringify(analysis||{})}`;

  const result = await chat({
    system,
    messages: [{ role:'user', content: user }],
    maxTokens: 1800,
    jsonMode: true
  });
  if(!result.ok) return { ok:false, error:result.error, provider:result.provider };
  const parsed = tryJSON(result.text);
  return parsed ? { ok:true, provider:result.provider, ...parsed } : { ok:true, raw:result.text, provider:result.provider };
}

// ── MODE 3: DRAFT A CAMPAIGN ──
async function campaign({ type, tenant, audience, channel, customGoal }){
  const system = `You are the Marketer agent for LolaDesk. You draft full marketing campaigns the salon's Lola agents can actually send.

The salon will hand the output directly to Recovery, Booker, or Sales agents to execute, so write copy that sounds like Lola — warm, brief, never pushy, ends with a clear booking action.

Return STRICT JSON only:
{
  "name": "campaign name",
  "audience_description": "who this targets exactly",
  "channel": "sms|whatsapp|instagram|email|voice",
  "send_window": "best days/times to send",
  "messages": [
    { "sequence": 1, "delay": "immediate", "channel":"...", "copy":"..." },
    { "sequence": 2, "delay": "+3 days", "channel":"...", "copy":"..." },
    { "sequence": 3, "delay": "+7 days", "channel":"...", "copy":"..." }
  ],
  "success_metric": "what to measure",
  "expected_lift": "honest estimate"
}

Rules for SMS/WhatsApp copy: under 320 characters, conversational, one clear call-to-action, no all-caps, no marketing emoji vomit. One emoji max.`;

  const user = `Campaign type: ${type || 'rebooking'}
Salon: ${JSON.stringify(tenant||{name:'MMΛ Salon'})}
Audience: ${audience || 'clients overdue for their next visit'}
Preferred channel: ${channel || 'sms'}
Custom goal: ${customGoal || ''}`;

  const result = await chat({
    system,
    messages: [{ role:'user', content: user }],
    maxTokens: 1800,
    jsonMode: true
  });
  if(!result.ok) return { ok:false, error:result.error, provider:result.provider };
  const parsed = tryJSON(result.text);
  return parsed ? { ok:true, provider:result.provider, ...parsed } : { ok:true, raw:result.text, provider:result.provider };
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method === 'OPTIONS') return res.status(200).end();

  try{
    const body = typeof req.body === 'string' ? JSON.parse(req.body||'{}') : (req.body||{});
    const action = body.action || (req.method==='GET' ? 'analyze' : '');

    if(action === 'analyze'){
      const url = body.url || new URL(req.url, 'http://x').searchParams.get('url');
      if(!url) return res.status(400).json({ ok:false, error:'url required' });
      const result = await analyze({ url, context: body.context });
      return res.status(200).json(result);
    }
    if(action === 'strategy'){
      const result = await strategy(body);
      return res.status(200).json(result);
    }
    if(action === 'campaign'){
      const result = await campaign(body);
      return res.status(200).json(result);
    }
    return res.status(400).json({ ok:false, error:'unknown action' });
  }catch(e){
    return res.status(500).json({ ok:false, error:String(e) });
  }
}
