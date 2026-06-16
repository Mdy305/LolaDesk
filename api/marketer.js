/**
 * /api/marketer — The Marketer agent
 */

import { chat, POWER_MODEL } from './lib/llm.js';

async function fetchSite(url){
  try{
    if(!/^https?:\/\//i.test(url)) url = 'https://' + url;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 LolaDeskMarketer/1.0' }, redirect: 'follow' });
    if(!r.ok) return { ok:false, error:`HTTP ${r.status}`, url };
    const html = await r.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ')
      .replace(/<!--[\s\S]*?-->/g,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ')
      .replace(/\s+/g,' ').trim().slice(0, 8000);
    const title = (html.match(/<title[^>]*>([^<]+)<\/title>/i)||[])[1]?.trim() || '';
    const metaDesc = (html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)/i)||[])[1] || '';
    return { ok:true, url, title, metaDesc, text };
  }catch(e){ return { ok:false, error:String(e), url }; }
}

function tryJSON(text){
  if(!text) return null;
  let s = text.replace(/```json/gi,'').replace(/```/g,'').trim();
  try{ return JSON.parse(s); }catch{}
  const objMatch = s.match(/\{[\s\S]*\}/);
  if(objMatch){ try{ return JSON.parse(objMatch[0]); }catch{} }
  const arrMatch = s.match(/\[[\s\S]*\]/);
  if(arrMatch){ try{ return JSON.parse(arrMatch[0]); }catch{} }
  const first = s.indexOf('{'), last = s.lastIndexOf('}');
  if(first>=0 && last>first){ try{ return JSON.parse(s.slice(first,last+1)); }catch{} }
  return null;
}

async function analyze({ url, context }){
  const site = await fetchSite(url);
  if(!site.ok) return { ok:false, error: site.error || 'Could not fetch URL', url };
  const system = `You are the Marketer agent for LolaDesk, an AI front-desk product for salons and med-spas. You analyze websites and surface marketing insights a salon owner can act on. Be honest, sharp, specific.
Respond with ONLY a valid JSON object and nothing else. No markdown, no code fences. Start with { and end with }. Shape:
{"summary":"2-3 sentences","positioning":"luxury/value/clinical/etc","audience":"who they target","strengths":["3-5"],"gaps":["3-5"],"services_detected":["service with price if visible"],"tone":"their voice","opportunities":["3-5 concrete opportunities"]}`;
  const user = `URL: ${site.url}\nTitle: ${site.title}\nMeta: ${site.metaDesc}\n${context?'Context: '+context+'\n':''}Content:\n"""${site.text}"""`;
  const result = await chat({ system, messages:[{role:'user',content:user}], maxTokens:1500, model:POWER_MODEL, jsonMode:true });
  if(!result.ok) return { ok:false, error: result.error||'LLM call failed', provider:result.provider, url:site.url };
  const parsed = tryJSON(result.text);
  if(!parsed) return { ok:true, url:site.url, title:site.title, raw:result.text, parsed:null, provider:result.provider };
  return { ok:true, url:site.url, title:site.title, provider:result.provider, ...parsed };
}

async function strategy({ analysis, salon, goals }){
  const system = `You are the Marketer agent for LolaDesk. Write smart, concrete marketing strategies for salons. Be sharp, specific, prioritized.
Respond with ONLY a valid JSON object. No fences. Start { end }. Shape:
{"headline":"one-line position","positioning_shift":"move to make","top_priorities":[{"title":"","why":"","first_action":""}],"campaigns_to_run":[{"name":"","audience":"","channel":"sms|email|instagram","expected_roi":"","frequency":""}],"do_not_do":["2-3"],"north_star_metric":"the one number"}`;
  const user = `Salon: ${JSON.stringify(salon||{})}\nGoals: ${goals||'Grow revenue, fill chairs, retain VIPs'}\nAnalysis: ${JSON.stringify(analysis||{})}`;
  const result = await chat({ system, messages:[{role:'user',content:user}], maxTokens:1800, model:POWER_MODEL, jsonMode:true });
  if(!result.ok) return { ok:false, error:result.error, provider:result.provider };
  const parsed = tryJSON(result.text);
  return parsed ? { ok:true, provider:result.provider, ...parsed } : { ok:true, raw:result.text, provider:result.provider };
}

async function campaign({ type, tenant, audience, channel, customGoal }){
  const system = `You are the Marketer agent for LolaDesk. Draft full campaigns the salon's agents can send. Warm, brief, never pushy, ends with a booking action.
Respond with ONLY a valid JSON object. No fences. Start { end }. Shape:
{"name":"","audience_description":"","channel":"sms|whatsapp|email","send_window":"","messages":[{"sequence":1,"delay":"immediate","channel":"","copy":""},{"sequence":2,"delay":"+3 days","channel":"","copy":""}],"success_metric":"","expected_lift":""}
SMS copy: under 320 chars, conversational, one CTA, one emoji max.`;
  const user = `Type: ${type||'rebooking'}\nSalon: ${JSON.stringify(tenant||{name:'MMA Salon'})}\nAudience: ${audience||'clients overdue'}\nChannel: ${channel||'sms'}\nGoal: ${customGoal||''}`;
  const result = await chat({ system, messages:[{role:'user',content:user}], maxTokens:1800, model:POWER_MODEL, jsonMode:true });
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
      const url = body.url || new URL(req.url,'http://x').searchParams.get('url');
      if(!url) return res.status(400).json({ ok:false, error:'url required' });
      return res.status(200).json(await analyze({ url, context: body.context }));
    }
    if(action === 'strategy') return res.status(200).json(await strategy(body));
    if(action === 'campaign') return res.status(200).json(await campaign(body));
    return res.status(400).json({ ok:false, error:'unknown action' });
  }catch(e){ return res.status(500).json({ ok:false, error:String(e) }); }
}
