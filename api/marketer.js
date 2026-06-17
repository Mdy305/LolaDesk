/**
 * /api/marketer — Marketer agent (analyze / strategy / campaign)
 * Kimi-K2.6 returns EMPTY for long structured-JSON requests but writes
 * excellent PROSE. So we ask for clean labeled prose and return it as
 * { ok, text } — the page renders the text. No JSON parsing to fail.
 */
import { chat } from './lib/llm.js';

async function fetchSite(url){
  try{
    if(!/^https?:\/\//i.test(url)) url = 'https://' + url;
    const controller = new AbortController();
    const timer = setTimeout(()=>controller.abort(), 8000);
    let r;
    try{ r = await fetch(url, { headers:{ 'User-Agent':'Mozilla/5.0 (compatible; LolaDesk/1.0)' }, redirect:'follow', signal: controller.signal }); }
    finally { clearTimeout(timer); }
    if(!r || !r.ok) return { ok:false, error:'HTTP '+(r?r.status:'none'), url, title:'', text:'' };
    const html = await r.text();
    const title = (html.match(/<title[^>]*>([^<]+)<\/title>/i)||[])[1] || '';
    const text = String(html).replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/[^\x20-\x7E]/g,' ').replace(/\s+/g,' ').trim().slice(0,2500);
    return { ok:true, url, title:title.replace(/[^\x20-\x7E]/g,'').trim(), text };
  }catch(e){ return { ok:false, error:String(e&&e.message||e), url, title:'', text:'' }; }
}

async function analyze(body){
  const url = body.url;
  const site = await fetchSite(url);
  const content = site.ok ? site.text : '(could not load the page; analyze from the URL and title)';
  const system = 'You are the Marketer agent for LolaDesk, a sharp marketing strategist for salons, spas, and med-spas. Analyze the website and write a clear, well-structured report in plain text using these labeled sections, each on its own lines:\n\nSUMMARY:\nPOSITIONING:\nTARGET AUDIENCE:\nSTRENGTHS: (bullet list with -)\nGAPS: (bullet list with -)\nSERVICES & PRICING:\nBRAND TONE:\nTOP OPPORTUNITIES: (bullet list with -)\n\nBe specific and honest. No preamble, start directly with SUMMARY:.';
  const user = 'Analyze this salon site.\nURL: '+url+'\nTitle: '+(site.title||'')+'\nContent: '+content;
  let result;
  try{ result = await chat({ system, messages:[{role:'user',content:user}], maxTokens:1100 }); }
  catch(e){ return { ok:false, error:'LLM error: '+String(e&&e.message||e), url }; }
  if(!result || !result.ok) return { ok:false, error:(result&&result.error)||'LLM call failed', url };
  return { ok:true, url, title:site.title, provider:result.provider, text:(result.text||'').trim() };
}

async function strategy(body){
  const { analysis, salon, goals } = body;
  const system = 'You are the Marketer for LolaDesk. Write a concrete, prioritized salon marketing strategy in clear plain text with these labeled sections on their own lines:\n\nHEADLINE:\nPOSITIONING SHIFT:\nTOP PRIORITIES: (numbered list, each with the action and why it matters)\nCAMPAIGNS TO RUN: (bullet list, each with audience, channel, and expected result)\nWHAT NOT TO DO: (bullet list)\nNORTH STAR METRIC:\n\nBe sharp and specific. No preamble, start directly with HEADLINE:.';
  const salonText = typeof salon==='object' ? (salon.name||JSON.stringify(salon)) : String(salon||'a salon');
  const analysisText = analysis ? (typeof analysis==='object' ? JSON.stringify(analysis).slice(0,1200) : String(analysis).slice(0,1200)) : '';
  const user = 'Build the strategy.\nSalon: '+salonText+'\nGoals: '+(goals||'Grow revenue, retain VIP clients, fill empty chairs')+(analysisText?'\nContext: '+analysisText:'');
  let result;
  try{ result = await chat({ system, messages:[{role:'user',content:user}], maxTokens:1200 }); }
  catch(e){ return { ok:false, error:String(e&&e.message||e) }; }
  if(!result||!result.ok) return { ok:false, error:(result&&result.error)||'failed' };
  return { ok:true, provider:result.provider, text:(result.text||'').trim() };
}

async function campaign(body){
  const { type, tenant, audience, channel, customGoal } = body;
  const system = 'You are the Marketer for LolaDesk. Draft a ready-to-send campaign for a salon, in clear plain text with these labeled sections on their own lines:\n\nCAMPAIGN NAME:\nAUDIENCE:\nCHANNEL:\nBEST SEND TIME:\nMESSAGE 1 (send immediately):\nMESSAGE 2 (send +3 days):\nMESSAGE 3 (send +7 days):\nSUCCESS METRIC:\nEXPECTED LIFT:\n\nEach message must be warm, brief, under 320 characters, with one clear booking call-to-action. No preamble, start directly with CAMPAIGN NAME:.';
  const salonText = typeof tenant==='object' ? (tenant.name||'the salon') : String(tenant||'the salon');
  const user = 'Draft the campaign.\nType: '+(type||'rebooking lapsed clients')+'\nSalon: '+salonText+'\nAudience: '+(audience||'clients who have not booked in 60+ days')+'\nChannel: '+(channel||'sms')+(customGoal?'\nGoal: '+customGoal:'');
  let result;
  try{ result = await chat({ system, messages:[{role:'user',content:user}], maxTokens:1100 }); }
  catch(e){ return { ok:false, error:String(e&&e.message||e) }; }
  if(!result||!result.ok) return { ok:false, error:(result&&result.error)||'failed' };
  return { ok:true, provider:result.provider, text:(result.text||'').trim() };
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
      const url = body.url;
      if(!url) return res.status(200).json({ ok:false, error:'url required' });
      return res.status(200).json(await analyze({ ...body, url }));
    }
    if(action === 'strategy') return res.status(200).json(await strategy(body));
    if(action === 'campaign') return res.status(200).json(await campaign(body));
    return res.status(200).json({ ok:false, error:'unknown action' });
  }catch(e){ return res.status(200).json({ ok:false, error:'handler: '+String(e&&e.message||e) }); }
}
