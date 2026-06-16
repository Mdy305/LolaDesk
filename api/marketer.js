/**
 * /api/marketer — Marketer agent (analyze / strategy / campaign)
 * Crash-proof: every path wrapped, fetch has a timeout, never throws to Vercel.
 */
import { chat, POWER_MODEL } from './lib/llm.js';

async function fetchSite(url){
  try{
    if(!/^https?:\/\//i.test(url)) url = 'https://' + url;
    const controller = new AbortController();
    const timer = setTimeout(()=>controller.abort(), 8000);
    let r;
    try{
      r = await fetch(url, {
        headers: { 'User-Agent':'Mozilla/5.0 (compatible; LolaDesk/1.0)' },
        redirect: 'follow',
        signal: controller.signal
      });
    } finally { clearTimeout(timer); }
    if(!r || !r.ok) return { ok:false, error:`HTTP ${r?r.status:'no-response'}`, url, title:'', text:'' };
    const html = await r.text();
    const title = (html.match(/<title[^>]*>([^<]+)<\/title>/i)||[])[1] || '';
    const text = String(html)
      .replace(/<script[\s\S]*?<\/script>/gi,' ')
      .replace(/<style[\s\S]*?<\/style>/gi,' ')
      .replace(/<[^>]+>/g,' ')
      .replace(/[^\x20-\x7E]/g,' ')
      .replace(/\s+/g,' ').trim().slice(0,2500);
    return { ok:true, url, title: title.replace(/[^\x20-\x7E]/g,'').trim(), text };
  }catch(e){
    return { ok:false, error:String(e&&e.message||e), url, title:'', text:'' };
  }
}

function tryJSON(text){
  if(!text) return null;
  let s = String(text).replace(/```json/gi,'').replace(/```/g,'').trim();
  try{ return JSON.parse(s); }catch{}
  const m = s.match(/\{[\s\S]*\}/);
  if(m){ try{ return JSON.parse(m[0]); }catch{} }
  return null;
}

async function analyze(body){
  const url = body.url;
  const site = await fetchSite(url);
  // Even if fetch fails, still analyze from the URL/title so we never hard-fail.
  const content = site.ok ? site.text : `(could not load page; analyze from the URL itself)`;
  const system = `You are the Marketer agent for LolaDesk. Analyze a salon/spa/med-spa website and return marketing insights. Reply with ONLY valid JSON. Start with { and end with }. Shape: {"summary":"2-3 sentences","positioning":"luxury/value/clinical","audience":"who","strengths":["3-4"],"gaps":["3-4"],"services_detected":["service + price if shown"],"tone":"voice","opportunities":["3-4 actionable"]}`;
  const user = `URL: ${url}\nTitle: ${site.title||''}\nContent: ${content}`;
  let result;
  try{
    result = await chat({ system, messages:[{role:'user',content:user}], maxTokens:900, model:POWER_MODEL });
  }catch(e){
    return { ok:false, error:'LLM error: '+String(e&&e.message||e), url };
  }
  if(!result || !result.ok) return { ok:false, error:(result&&result.error)||'LLM call failed', url };
  const parsed = tryJSON(result.text);
  if(!parsed) return { ok:true, url, title:site.title, raw:result.text, parsed:null, provider:result.provider };
  return { ok:true, url, title:site.title, provider:result.provider, ...parsed };
}

async function strategy(body){
  const { analysis, salon, goals } = body;
  const system = `You are the Marketer for LolaDesk. Write a concrete salon marketing strategy. Reply with ONLY valid JSON, start { end }. Shape: {"headline":"","positioning_shift":"","top_priorities":[{"title":"","why":"","first_action":""}],"campaigns_to_run":[{"name":"","audience":"","channel":"sms","expected_roi":"","frequency":""}],"do_not_do":["2-3"],"north_star_metric":""}`;
  const user = `Salon: ${JSON.stringify(salon||{})}\nGoals: ${goals||'Grow revenue, retain VIPs'}\nAnalysis: ${JSON.stringify(analysis||{}).slice(0,1500)}`;
  let result;
  try{ result = await chat({ system, messages:[{role:'user',content:user}], maxTokens:1100, model:POWER_MODEL }); }
  catch(e){ return { ok:false, error:String(e&&e.message||e) }; }
  if(!result||!result.ok) return { ok:false, error:(result&&result.error)||'failed' };
  const parsed = tryJSON(result.text);
  return parsed ? { ok:true, provider:result.provider, ...parsed } : { ok:true, raw:result.text, provider:result.provider };
}

async function campaign(body){
  const { type, tenant, audience, channel, customGoal } = body;
  const system = `You are the Marketer for LolaDesk. Draft a campaign salon agents can send. Warm, brief, booking-focused. Reply with ONLY valid JSON, start { end }. Shape: {"name":"","audience_description":"","channel":"sms","send_window":"","messages":[{"sequence":1,"delay":"immediate","channel":"sms","copy":""},{"sequence":2,"delay":"+3 days","channel":"sms","copy":""}],"success_metric":"","expected_lift":""}`;
  const user = `Type: ${type||'rebooking'}\nSalon: ${JSON.stringify(tenant||{name:'salon'}).slice(0,800)}\nAudience: ${audience||'overdue clients'}\nChannel: ${channel||'sms'}\nGoal: ${customGoal||''}`;
  let result;
  try{ result = await chat({ system, messages:[{role:'user',content:user}], maxTokens:1100, model:POWER_MODEL }); }
  catch(e){ return { ok:false, error:String(e&&e.message||e) }; }
  if(!result||!result.ok) return { ok:false, error:(result&&result.error)||'failed' };
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
      const url = body.url || (()=>{ try{ return new URL(req.url,'http://x').searchParams.get('url'); }catch{ return null; } })();
      if(!url) return res.status(200).json({ ok:false, error:'url required' });
      return res.status(200).json(await analyze({ ...body, url }));
    }
    if(action === 'strategy') return res.status(200).json(await strategy(body));
    if(action === 'campaign') return res.status(200).json(await campaign(body));
    return res.status(200).json({ ok:false, error:'unknown action' });
  }catch(e){
    return res.status(200).json({ ok:false, error:'handler: '+String(e&&e.message||e) });
  }
}
