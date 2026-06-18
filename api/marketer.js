/**
 * /api/marketer — Marketer agent (analyze / strategy / campaign)
 * Kimi-K2.6 returns EMPTY for long structured-JSON requests but writes
 * excellent PROSE. So we ask for clean labeled prose and return it as
 * { ok, text } — the page renders the text. No JSON parsing to fail.
 */
import { chat } from './lib/llm.js';

/**
 * Parses labeled-section prose like:
 *   SUMMARY:
 *   Some text here, possibly multiple lines.
 *   POSITIONING:
 *   More text.
 * into { summary: "...", positioning: "..." }.
 *
 * WHY THIS EXISTS: Kimi-K2.6 on Telnyx reliably writes good prose but
 * unreliably returns anything for structured-JSON requests (see the
 * file header). So the LLM is always asked for clean labeled prose —
 * but the frontend (marketer.html) was built against rich structured
 * fields (d.summary, d.positioning, d.strengths[], etc.) for its card
 * UI. This parser bridges that gap: reliable prose in, the exact
 * structured shape the frontend already expects out. Don't change the
 * frontend back to expecting raw JSON from the model — that's the
 * failure mode this whole design avoids.
 *
 * `labelMap` maps the ALL-CAPS label text (as it appears after "SUMMARY:")
 * to the camelCase/snake_case output key. `listKeys` are keys whose
 * value should be split into an array of bullet lines instead of a
 * single string block.
 */
function parseLabeledSections(text, labelMap, listKeys = []){
  const out = {};
  if(!text) return out;
  const labels = Object.keys(labelMap);
  // Build one regex that finds "LABEL:" at the start of a line, case-sensitive
  // to the labels we actually asked for, capturing everything up to the next
  // label or end of text.
  const pattern = labels.map(l => l.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|');
  const re = new RegExp(`(?:^|\\n)\\s*(${pattern})\\s*:?\\s*\\n?`, 'g');
  const matches = [...text.matchAll(re)];
  for(let i=0;i<matches.length;i++){
    const label = matches[i][1];
    const key = labelMap[label];
    if(!key) continue;
    const start = matches[i].index + matches[i][0].length;
    const end = i+1 < matches.length ? matches[i+1].index : text.length;
    let block = text.slice(start, end).trim();
    if(listKeys.includes(key)){
      out[key] = block.split('\n')
        .map(l => l.replace(/^[-•*]\s*/, '').replace(/^\d+\.\s*/, '').trim())
        .filter(Boolean);
    } else {
      out[key] = block.replace(/\n+/g,' ').trim();
    }
  }
  return out;
}

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
  const system = 'You are the Marketer agent for LolaDesk, a sharp marketing strategist for salons, spas, and med-spas. Analyze the website and write a clear, well-structured report in plain text using these labeled sections, each on its own lines:\n\nSUMMARY:\nPOSITIONING:\nTARGET AUDIENCE:\nSTRENGTHS: (bullet list with -)\nGAPS: (bullet list with -)\nSERVICES DETECTED: (short bullet list with -, just service names, max 8)\nBRAND TONE:\nTOP OPPORTUNITIES: (bullet list with -)\n\nBe specific and honest. No preamble, start directly with SUMMARY:.';
  const user = 'Analyze this salon site.\nURL: '+url+'\nTitle: '+(site.title||'')+'\nContent: '+content;
  let result;
  try{ result = await chat({ system, messages:[{role:'user',content:user}], maxTokens:1100 }); }
  catch(e){ return { ok:false, error:'LLM error: '+String(e&&e.message||e), url }; }
  if(!result || !result.ok) return { ok:false, error:(result&&result.error)||'LLM call failed', url };
  const raw = (result.text||'').trim();
  const parsed = parseLabeledSections(raw, {
    'SUMMARY':'summary', 'POSITIONING':'positioning', 'TARGET AUDIENCE':'audience',
    'STRENGTHS':'strengths', 'GAPS':'gaps', 'SERVICES DETECTED':'services_detected',
    'BRAND TONE':'tone', 'TOP OPPORTUNITIES':'opportunities'
  }, ['strengths','gaps','services_detected','opportunities']);
  return { ok:true, url, title:site.title, provider:result.provider, text:raw, raw, ...parsed };
}

async function strategy(body){
  const { analysis, salon, goals } = body;
  const system = 'You are the Marketer for LolaDesk. Write a concrete, prioritized salon marketing strategy in clear plain text with these labeled sections on their own lines. Follow the exact line format shown for TOP PRIORITIES and CAMPAIGNS TO RUN so it can be parsed — use the pipe character | as the separator, one item per line:\n\nHEADLINE:\nPOSITIONING SHIFT:\nTOP PRIORITIES: (one per line: Title | Why it matters | First action to take)\nCAMPAIGNS TO RUN: (one per line: Name | Audience | Channel | Frequency | Expected result)\nWHAT NOT TO DO: (bullet list with -)\nNORTH STAR METRIC:\n\nBe sharp and specific. No preamble, start directly with HEADLINE:. Do not add extra pipes within a field.';
  const salonText = typeof salon==='object' ? (salon.name||JSON.stringify(salon)) : String(salon||'a salon');
  const analysisText = analysis ? (typeof analysis==='object' ? JSON.stringify(analysis).slice(0,1200) : String(analysis).slice(0,1200)) : '';
  const user = 'Build the strategy.\nSalon: '+salonText+'\nGoals: '+(goals||'Grow revenue, retain VIP clients, fill empty chairs')+(analysisText?'\nContext: '+analysisText:'');
  let result;
  try{ result = await chat({ system, messages:[{role:'user',content:user}], maxTokens:1200 }); }
  catch(e){ return { ok:false, error:String(e&&e.message||e) }; }
  if(!result||!result.ok) return { ok:false, error:(result&&result.error)||'failed' };
  const raw = (result.text||'').trim();
  const parsed = parseLabeledSections(raw, {
    'HEADLINE':'headline', 'POSITIONING SHIFT':'positioning_shift',
    'TOP PRIORITIES':'_priorities_raw', 'CAMPAIGNS TO RUN':'_campaigns_raw',
    'WHAT NOT TO DO':'do_not_do', 'NORTH STAR METRIC':'north_star_metric'
  }, ['_priorities_raw','_campaigns_raw','do_not_do']);
  const top_priorities = (parsed._priorities_raw||[]).map(line=>{
    const [title,why,first_action] = line.split('|').map(s=>(s||'').trim());
    return { title: title||line, why: why||'', first_action: first_action||'' };
  }).filter(p=>p.title);
  const campaigns_to_run = (parsed._campaigns_raw||[]).map(line=>{
    const [name,audience,channel,frequency,expected_roi] = line.split('|').map(s=>(s||'').trim());
    return { name: name||line, audience: audience||'', channel: channel||'sms', frequency: frequency||'', expected_roi: expected_roi||'' };
  }).filter(c=>c.name);
  return { ok:true, provider:result.provider, text:raw, raw,
    headline: parsed.headline, positioning_shift: parsed.positioning_shift,
    north_star_metric: parsed.north_star_metric, do_not_do: parsed.do_not_do||[],
    top_priorities, campaigns_to_run };
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
  const raw = (result.text||'').trim();
  const parsed = parseLabeledSections(raw, {
    'CAMPAIGN NAME':'name', 'AUDIENCE':'audience_description', 'CHANNEL':'channel',
    'BEST SEND TIME':'send_window',
    'MESSAGE 1 (send immediately)':'_msg1', 'MESSAGE 2 (send +3 days)':'_msg2', 'MESSAGE 3 (send +7 days)':'_msg3',
    'SUCCESS METRIC':'success_metric', 'EXPECTED LIFT':'expected_lift'
  });
  const messages = [
    parsed._msg1 ? { sequence:1, delay:'Send immediately', channel: parsed.channel||channel||'sms', copy: parsed._msg1 } : null,
    parsed._msg2 ? { sequence:2, delay:'+3 days', channel: parsed.channel||channel||'sms', copy: parsed._msg2 } : null,
    parsed._msg3 ? { sequence:3, delay:'+7 days', channel: parsed.channel||channel||'sms', copy: parsed._msg3 } : null
  ].filter(Boolean);
  return { ok:true, provider:result.provider, text:raw, raw,
    name: parsed.name, audience_description: parsed.audience_description,
    channel: parsed.channel||channel||'sms', send_window: parsed.send_window,
    success_metric: parsed.success_metric, expected_lift: parsed.expected_lift,
    messages };
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
