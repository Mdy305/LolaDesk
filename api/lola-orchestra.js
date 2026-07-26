import { getUserFromToken, bearer } from './lib/auth.js';
import { resolveTenantForUser } from './lib/tenant-access.js';
import { getOrStartConversation, getConversationHistory, logMessage, getOwnerMemory, setOwnerMemory } from './lib/db.js';
import { buildClientMemoryBlock, extractPersonalizationSignals, mergeClientProfile, profileFromMemoryRows } from './lib/lola-skills.js';
import { runAgentOrchestra } from './lib/agent-orchestra.js';
import { SKILLS } from './lola-tools.js';

function lastUser(messages){
  const m=[...(messages||[])].reverse().find(x=>x?.role==='user');
  return typeof m?.content==='string' ? m.content.trim() : '';
}

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  res.setHeader('Cache-Control','no-store');
  if(req.method==='OPTIONS') return res.status(200).end();
  if(req.method!=='POST') return res.status(405).json({error:'Method not allowed'});

  try{
    const body=typeof req.body==='string'?JSON.parse(req.body||'{}'):(req.body||{});
    let tenant=null;
    try{
      const user=await getUserFromToken(bearer(req));
      if(user) tenant=await resolveTenantForUser(user);
    }catch{}
    if(!tenant?.id) return res.status(401).json({error:'Not authenticated'});

    let messages=Array.isArray(body.messages)?body.messages.slice(-24):[];
    const userText=lastUser(messages);
    if(!userText) return res.status(400).json({error:'A user message is required'});

    let conversation=null;
    let memoryBlock='';
    try{
      conversation=await getOrStartConversation(tenant.id,{channel:body.channel||'dashboard',agent:'lola'});
      let profile=profileFromMemoryRows(await getOwnerMemory(tenant.id));
      memoryBlock=buildClientMemoryBlock(profile)||'';
      if(conversation?.id&&messages.length<=2){
        const past=await getConversationHistory(conversation.id,12);
        if(past.length) messages=[...past,...messages].slice(-24);
      }
      const signals=extractPersonalizationSignals(userText);
      if(signals?.hasSignal){
        profile=mergeClientProfile(profile,signals);
        await setOwnerMemory(tenant.id,'profile',profile);
      }
    }catch{}

    const out=await runAgentOrchestra({
      tenant,
      messages,
      skillsRegistry:SKILLS,
      memoryBlock,
      channel:body.channel||'dashboard_voice',
      confirmed:body.confirmed===true
    });

    try{
      if(conversation?.id){
        await logMessage({conversationId:conversation.id,tenantId:tenant.id,role:'user',agent:'lola',content:userText});
        if(out.content) await logMessage({conversationId:conversation.id,tenantId:tenant.id,role:'assistant',agent:'lola',content:String(out.content)});
      }
    }catch{}

    return res.status(out.ok===false?502:200).json({
      id:`orch_${Date.now()}`,
      type:'message',
      role:'assistant',
      content:[{type:'text',text:out.content||'I am ready.'}],
      executed:!!out.executed,
      needs_confirmation:!!out.needs_confirmation,
      pending:out.pending||null,
      result:out.result||null,
      orchestration:out.orchestration,
      provider:out.provider||null,
      model:out.model||null,
      error:out.error||null
    });
  }catch(error){
    console.error('[lola-orchestra]',error);
    return res.status(500).json({error:'Lola orchestration failed',detail:String(error?.message||error)});
  }
}
