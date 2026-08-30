import { getUserFromToken, bearer } from './lib/auth.js';
import { resolveTenantForUser } from './lib/tenant-access.js';
import { getOrStartConversation, getConversationHistory, logMessage, getOwnerMemory, setOwnerMemory } from './lib/db.js';
import { buildClientMemoryBlock, extractPersonalizationSignals, mergeClientProfile, profileFromMemoryRows } from './lib/lola-skills.js';
import { runAgentOrchestra } from './lib/agent-orchestra.js';
import { executeSkill } from './lib/orchestrator.js';
import { SKILLS } from './lola-tools.js';

const AFFIRMATIVE=/^(?:yes|yeah|yep|correct|confirm|confirmed|do it|go ahead|proceed|make it happen|book it|cancel it|move it|please do)(?:[.!\s]|$)/i;
const NEGATIVE=/^(?:no|nope|cancel that|never mind|nevermind|stop|don't|do not)(?:[.!\s]|$)/i;
const CONSEQUENTIAL=new Set(['book_appointment','reschedule_appointment','cancel_appointment']);

function lastUser(messages){
  const m=[...(messages||[])].reverse().find(x=>x?.role==='user');
  return typeof m?.content==='string' ? m.content.trim() : '';
}

function validPending(value){
  if(!value||typeof value!=='object'||!CONSEQUENTIAL.has(value.skill)||!SKILLS[value.skill]) return null;
  const args=value.args&&typeof value.args==='object'?value.args:{};
  return {skill:value.skill,args};
}

function successFrom(skill,output){
  if(!output||output.error) return false;
  if(skill==='book_appointment') return output.booked===true;
  if(skill==='reschedule_appointment') return output.rescheduled===true;
  if(skill==='cancel_appointment') return output.cancelled===true;
  return true;
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

    const pending=validPending(body.pending);
    let out;
    if(pending&&NEGATIVE.test(userText)){
      out={ok:true,executed:false,needs_confirmation:false,pending:null,content:'Understood. I did not execute that action.',orchestration:{agents:[{id:'execution',label:'Execution'}],skill:pending.skill}};
    }else if(pending&&AFFIRMATIVE.test(userText)){
      const result=await executeSkill(tenant,pending.args?.client_phone||null,pending.skill,pending.args,SKILLS);
      const success=successFrom(pending.skill,result);
      out={
        ok:true,
        executed:true,
        execution_ok:success,
        needs_confirmation:false,
        pending:null,
        content:result?.speak||(success?'Done.':'I could not complete that action.'),
        result,
        orchestration:{agents:[{id:'execution',label:'Execution'}],skill:pending.skill}
      };
    }else{
      out=await runAgentOrchestra({
        tenant,
        messages,
        skillsRegistry:SKILLS,
        memoryBlock,
        channel:body.channel||'dashboard_voice',
        confirmed:body.confirmed===true
      });
    }

    try{
      if(conversation?.id){
        await logMessage({conversationId:conversation.id,tenantId:tenant.id,role:'user',agent:'lola',content:userText});
        if(out.content) await logMessage({conversationId:conversation.id,tenantId:tenant.id,role:'assistant',agent:'lola',content:String(out.content)});
      }
    }catch{}

    return res.status(200).json({
      id:`orch_${Date.now()}`,
      type:'message',
      role:'assistant',
      content:[{type:'text',text:out.content||'I am ready.'}],
      executed:!!out.executed,
      execution_ok:out.execution_ok!==undefined?!!out.execution_ok:(out.executed?out.ok!==false:null),
      degraded:out.ok===false,
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
