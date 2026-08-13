import { executeLolaAction, resolveExecutionTenant } from './lib/lola-executor.js';

function bodyOf(req){ if(!req.body)return {}; if(typeof req.body==='string'){ try{return JSON.parse(req.body||'{}')}catch{return {}} } return req.body; }

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization,x-lola-number');
  if(req.method==='OPTIONS') return res.status(204).end();
  if(req.method!=='POST') return res.status(405).json({ok:false,error:'method_not_allowed'});
  const body=bodyOf(req), action=String(body.action||body.tool||'').trim();
  if(!action) return res.status(400).json({ok:false,error:'action_required'});
  try{
    const tenant=await resolveExecutionTenant({...body,to:body.to||req.headers['x-lola-number']});
    if(!tenant?.id) return res.status(404).json({ok:false,error:'tenant_not_found'});
    const result=await executeLolaAction({
      action,
      tenant,
      input:body.input||body,
      channel:body.channel||'lola',
      conversationId:body.conversation_id||null,
      actor:body.actor||'lola'
    });
    return res.status(200).json(result);
  }catch(error){
    console.error('[lola-execute]',error);
    return res.status(500).json({ok:false,error:'execution_route_failed'});
  }
}
