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
      .replace(/[^\x20-\x7E]/g,' ').replace(/\s+/g,' ').trim().slice(0,2500);
    const title = (html.match(/<title[^>]*>([^<]+)<\/title>/i)||[])[1]?.trim() || '';
    const metaDesc = (html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)/i)||[])[1] || '';
    return { ok:true, url, title, metaDesc, text };
  }catch(e){ return { ok:false, error:String(e), url }; }
}

function tryJSON(text){
  if(!text) return null;
  let s = text.replace(/```json/gi,'').replace(/```/g,'').trim();
  try{ return JSON.parse(s); }catch{}
  const m = s.match(/\{[\s\S]*\}/);
  if(m){ try{ return JSON.parse(m[0]); }catch{} }
  return null;
}

async function analyze({ url, context }){
  const site = await fetchSite(url);
  if(!site.ok) return { ok:false, error: site.error || 'Could not fetch URL', url };
  const system = `You are the Marketer agent for LolaDesk. Analyze a salon/spa website and return marketing insights. Reply with ONLY valid JSON, no prose, start with { end with }: {"summary":"2-3 sentences","positioning":"luxury/value/clinical","audience":"who","strengths":["3-4"],"gaps":["3-4"],"services_detected":["service + price if shown"],"tone":"voice","opportunities":["3-4 actions"]}`;
  const user = `URL: ${site.url}\nTitle: ${site.title}\nDescription: ${site.metaDesc}\nContent: ${site.text}`;
  const result = await chat({ system, messages:[{role:'user',content:user}], maxTokens:900, model:POWER_MODEL });
  if(!result.ok) return { ok:false, error: result.error||'LLM call failed', provider:result.provider, url:site.url };
  const parsed = tryJSON(result.text);
  if(!parsed) return { ok:true, url:site.url, title:site.title, raw:result.text, parsed:null, provider:result.provider };
  return { ok:true, url:site.url, title:site.title, provider:result.provider, ...parsed };
}

async function strategy({ analysis, salon, goals }){
  const system = `You are the Marketer for LolaDesk. Write a concrete salon marketing strategy. ONLY valid JSON, start { end }: {"headline":"","positioning_shift":"","top_priorities":[{"title":"","why":"","first_action":""}],"campaigns_to_run":[{"name":"","audience":"","channel":"sms","expected_roi":"","frequency":""}],"do_not_do":["2-3"],"north_star_metric":""}`;
  const user = `Salon: ${JSON.stringify(salon||{})}\nGoals: ${goals||'Grow revenue, retain VIPs'}\nAnalysis: ${JSON.stringify(analysis||{}).slice(0,2000)}`;
  const result = await chat({ system, messages:[{role:'user',content:user}], maxTokens:1200, model:POWER_MODEL });
  if(!result.ok) return { ok:false, error:result.error, provider:result.provider };
  const parsed = tryJSON(result.text);
  return parsed ? { ok:true, provider:result.provider, ...parsed } : { ok:true, raw:result.text, provider:result.provider };
}

async function campaign({ type, tenant, audience, channel, customGoal }){
  const system = `You are the Marketer for LolaDesk. Draft a campaign salon agents can send. Warm, brief, booking-focused. ONLY valid JSON, start { end }: {"name":"","audience_description":"","channel":"sms","send_window":"","messages":[{"sequence":1,"delay":"immediate","channel":"sms","copy":""},{"sequence":2,"delay":"+3 days","channel":"sms","copy":""}],"success_metric":"","expected_lift":""}`;
  const user = `Type: ${type||'rebooking'}\nSalon: ${JSON.stringify(tenant||{name:'salon'}).slice(0,1000)}\nAudience: ${audience||'overdue clients'}\nChannel: ${channel||'sms'}\nGoal: ${customGoal||''}`;
  const result = await chat({ system, messages:[{role:'user',content:user}], maxTokens:1200, model:POWER_MODEL });
  if(!result.ok) return { ok:false, error:result.error, provider:result.provider };
  const parsed = tryJSON(result.text);
  return parsed ? { ok:true, provider:result.provider, ...parsed } : { ok:true, raw:result.text, provider:result.provider };
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
echo '{"functions":{"api/**/*.js":{"maxDuration":60}}}' > vercel.json
cat vercel.json
git add vercel.json && git commit -m "Allow 60s function timeout" && git push
echo '{"functions":{"api/**/*.js":{"maxDuration":60}}}' > vercel.json
cat vercel.json
git add vercel.json
git commit -m "Allow 60s timeout"
git push
