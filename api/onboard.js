import { upsertTenant, saveTenantKnowledge } from './lib/db.js';
import { chat } from './lib/llm.js';

async function fetchSite(url){
  try{
    if(!/^https?:\/\//i.test(url)) url = 'https://' + url;
    const r = await fetch(url, { headers:{ 'User-Agent':'Mozilla/5.0 LolaDeskOnboard/1.0' }, redirect:'follow' });
    if(!r.ok) return { ok:false, error:`HTTP ${r.status}` };
    const html = await r.text();
    const text = html.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim().slice(0,8000);
    const title = (html.match(/<title[^>]*>([^<]+)<\/title>/i)||[])[1]?.trim() || '';
    return { ok:true, text, title };
  }catch(e){ return { ok:false, error:String(e) }; }
}

async function analyzeSite(url, businessMode){
  const site = await fetchSite(url);
  if(!site.ok) return { ok:false, error: site.error };
  const system = `You are the Marketer agent for LolaDesk. Analyze this ${businessMode||'salon'}'s website so the AI receptionist (Lola) knows their business.
Return STRICT JSON only:
{"summary":"2-3 sentence description","positioning":"luxury/value/clinical/etc","audience":"who they serve","tone":"brand voice","services_detected":["service with price if visible"],"usp":"what makes them special","opportunities":["2-3 marketing opportunities"]}`;
  const result = await chat({ system, messages:[{ role:'user', content:`Website: ${url}\nTitle: ${site.title}\nContent:\n"""${site.text}"""` }], maxTokens:1200, jsonMode:true });
  if(!result.ok) return { ok:false, error: result.error };
  const cleaned = (result.text||'').replace(/```json|```/g,'').trim();
  try{ return { ok:true, knowledge: JSON.parse(cleaned), provider: result.provider }; }
  catch{ return { ok:true, knowledge:{ summary: result.text }, provider: result.provider }; }
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method === 'OPTIONS') return res.status(200).end();
  if(req.method !== 'POST') return res.status(405).json({ ok:false, error:'POST only' });
  try{
    const body = typeof req.body === 'string' ? JSON.parse(req.body||'{}') : (req.body||{});
    const { name, websiteUrl, businessMode } = body;
    if(!name) return res.status(400).json({ ok:false, error:'name required' });
    const slug = body.slug || name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
    const tenant = await upsertTenant({ ...body, slug });
    let knowledge = null, analysisError = null;
    if(websiteUrl){
      const analysis = await analyzeSite(websiteUrl, businessMode);
      if(analysis.ok){ knowledge = analysis.knowledge; if(tenant?.id) await saveTenantKnowledge(tenant.id, knowledge); }
      else analysisError = analysis.error;
    }
    return res.status(200).json({ ok:true, tenant: tenant?{ id:tenant.id, slug:tenant.slug, name:tenant.name }:null, knowledge, analysisError, message: knowledge?`Lola now knows ${name}.`:`Tenant created. ${analysisError?'Analysis failed: '+analysisError:'No website provided.'}` });
  }catch(e){ return res.status(500).json({ ok:false, error:String(e) }); }
}
