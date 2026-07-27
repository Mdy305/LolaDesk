import { bearer, getUserFromToken } from './lib/auth.js';
import { resolveTenantForUser } from './lib/tenant-access.js';
import { getOrStartConversation, logMessage, logUsage } from './lib/db.js';
import { getConversationHistory } from './lib/db.js';
import { answerOwner } from './lib/owner-brain.js';
import { OPERATOR_SKILLS } from './operator-tools.js';
import { parseOperatorIntent } from './operator-voice.js';

function bodyOf(req){
  if(typeof req.body === 'string'){
    try{return JSON.parse(req.body || '{}');}catch{return {};}
  }
  return req.body || {};
}

function safe(value, max=500){ return String(value || '').trim().slice(0,max); }

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');
  if(req.method === 'OPTIONS') return res.status(200).end();
  if(req.method !== 'POST') return res.status(405).json({error:'POST only'});

  try{
    const user = await getUserFromToken(bearer(req));
    if(!user) return res.status(401).json({error:'not authenticated'});
    const tenant = await resolveTenantForUser(user);
    if(!tenant) return res.status(404).json({error:'tenant not found'});

    const body = bodyOf(req);
    const text = safe(body.text, 1000);
    const tool = safe(body.tool, 80);
    const confirmToken = safe(body.confirm_token, 3000);
    const pin = safe(body.pin, 12).replace(/\D/g,'');
    let conversation = null;
    try{ conversation = await getOrStartConversation(tenant.id,{channel:'dashboard',agent:'lola-brain'}); }catch{}

    async function audit(reply, metadata={}){
      try{
        if(conversation?.id){
          if(text) await logMessage({conversationId:conversation.id,tenantId:tenant.id,role:'user',agent:'lola-brain',content:text});
          if(reply) await logMessage({conversationId:conversation.id,tenantId:tenant.id,role:'assistant',agent:'lola-brain',content:reply});
        }
        await logUsage(tenant.id,'brain_command',1,{actor_user_id:user.id,tool:metadata.tool||null,executed:!!metadata.executed,needs_confirmation:!!metadata.needs_confirmation});
      }catch{}
    }

    if(tool && confirmToken){
      if(!OPERATOR_SKILLS[tool]) return res.status(400).json({error:'unsupported command'});
      if(!pin) return res.status(400).json({error:'PIN required'});
      const result = await OPERATOR_SKILLS[tool](tenant,{...(body.args||{}),confirm:true,pin,confirm_token:confirmToken});
      await audit(result.speak,{tool,executed:!!(result.booked||result.cancelled||result.moved||result.sent)});
      return res.status(200).json({ok:true,mode:'action',tool,result,speak:result.speak,executed:!!(result.booked||result.cancelled||result.moved||result.sent)});
    }

    if(!text) return res.status(400).json({error:'text required'});
    const intent = parseOperatorIntent(text);
    if(intent && OPERATOR_SKILLS[intent.tool]){
      const result = await OPERATOR_SKILLS[intent.tool](tenant,intent.args);
      await audit(result.speak,{tool:intent.tool,needs_confirmation:!!result.needs_confirmation,executed:!!result.booked});
      return res.status(200).json({
        ok:true,
        mode:'action',
        tool:intent.tool,
        args:intent.args,
        result,
        speak:result.speak,
        needs_confirmation:!!result.needs_confirmation,
        confirm_token:result.confirm_token||null,
        executed:!!result.booked
      });
    }

    let history=[];
    try{ if(conversation?.id) history=await getConversationHistory(conversation.id,10); }catch{}
    const brain=await answerOwner(tenant,history,text,{channel:'dashboard'});
    const reply=brain.ok?brain.text:"I can check your schedule, pull revenue, find overdue clients, book, move or cancel appointments, and text client segments.";
    await audit(reply,{});
    return res.status(200).json({ok:true,mode:'conversation',speak:reply});
  }catch(error){
    return res.status(500).json({error:String(error?.message||error)});
  }
}
