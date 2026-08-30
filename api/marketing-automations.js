import { bearer, getUserFromToken } from './lib/auth.js';
import { db, logUsage } from './lib/db.js';
import { resolveTenantAccessForUser } from './lib/tenant-access.js';
import { sendSMS } from './telnyx-sms.js';

const DAY=86400000;
const APPROVERS=new Set(['owner','admin','manager']);
const id=()=>globalThis.crypto?.randomUUID?.()||`cmp_${Date.now()}_${Math.random().toString(36).slice(2)}`;
const daysSince=ts=>ts?Math.floor((Date.now()-new Date(ts).getTime())/DAY):9999;
const parseBody=req=>typeof req.body==='string'?JSON.parse(req.body||'{}'):(req.body||{});
const cleanMessage=value=>String(value||'').replace(/\s+/g,' ').trim().slice(0,420);
const firstName=name=>String(name||'there').trim().split(/\s+/)[0]||'there';

function defaultCopy(campaign,business){
  if(campaign==='vip-retention') return `Hi {{first_name}}, ${business} would love to reserve your next visit. Reply here and Lola will find the best time for you. Reply STOP to opt out.`;
  if(campaign==='post-visit') return `Hi {{first_name}}, thank you for visiting ${business}. Ready to plan your next appointment? Reply here and Lola will help. Reply STOP to opt out.`;
  return `Hi {{first_name}}, we miss you at ${business}. Reply here and Lola will find a beautiful time for your next visit. Reply STOP to opt out.`;
}

function segments(clients){
  return {
    winback:clients.filter(x=>daysSince(x.last_visit)>=60),
    'vip-retention':clients.filter(x=>!!x.is_vip||Number(x.lifetime_value||0)>=1200),
    'post-visit':clients.filter(x=>daysSince(x.last_visit)<=21)
  };
}

function eventState(events){
  const drafts=new Map();
  for(const event of [...events].reverse()){
    const m=event.metadata||{}, draftId=m.draft_id;
    if(!draftId) continue;
    if(event.kind==='campaign_draft') drafts.set(draftId,{draftId,status:'draft',createdAt:event.created_at,...m});
    else if(drafts.has(draftId)){
      const row=drafts.get(draftId);
      if(event.kind==='campaign_cancelled') Object.assign(row,{status:'cancelled',updatedAt:event.created_at});
      if(event.kind==='campaign_sent') Object.assign(row,{status:'sent',updatedAt:event.created_at,result:m.result||null});
      if(event.kind==='campaign_send_failed') Object.assign(row,{status:'failed',updatedAt:event.created_at,result:m.result||null});
    }
  }
  return [...drafts.values()].sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
}

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  if(req.method==='OPTIONS') return res.status(200).end();
  if(!['GET','POST'].includes(req.method)) return res.status(405).json({error:'Method not allowed'});

  try{
    const user=await getUserFromToken(bearer(req));
    if(!user) return res.status(401).json({error:'not authenticated'});
    const access=await resolveTenantAccessForUser(user);
    const tenant=access?.tenant, role=String(access?.role||'staff').toLowerCase();
    if(!tenant?.id) return res.status(404).json({error:'no tenant found for this account'});
    const c=db();
    if(!c) return res.status(503).json({error:'database not configured'});

    const [{data:clients=[],error:clientError},{data:events=[],error:eventError}]=await Promise.all([
      c.from('clients').select('id,name,last_visit,is_vip,lifetime_value,phone_number').eq('tenant_id',tenant.id).limit(500),
      c.from('usage_events').select('kind,units,metadata,created_at').eq('tenant_id',tenant.id).in('kind',['campaign_draft','campaign_sent','campaign_send_failed','campaign_cancelled']).order('created_at',{ascending:false}).limit(500)
    ]);
    if(clientError||eventError) throw clientError||eventError;
    const grouped=segments(clients), drafts=eventState(events);

    if(req.method==='GET'){
      return res.status(200).json({
        tenant:tenant.name,role,canApprove:APPROVERS.has(role),phoneReady:!!tenant.phone_number,
        segments:[
          {id:'winback',name:'Win-back',count:grouped.winback.length,desc:'No visit in 60+ days'},
          {id:'vip-retention',name:'VIP Retention',count:grouped['vip-retention'].length,desc:'High-value recurring clients'},
          {id:'post-visit',name:'Post-visit Follow-up',count:grouped['post-visit'].length,desc:'Visited in last 21 days'}
        ],
        drafts:drafts.slice(0,20)
      });
    }

    const body=parseBody(req), action=String(body.action||'draft');
    if(action==='draft'){
      const campaign=grouped[body.campaign]?body.campaign:'winback';
      const max=Math.min(Math.max(Number(body.limit||40),1),80);
      const target=grouped[campaign].filter(x=>x.phone_number).slice(0,max);
      const draftId=id(), message=cleanMessage(body.message)||defaultCopy(campaign,tenant.name||'our salon');
      await logUsage(tenant.id,'campaign_draft',target.length,{
        draft_id:draftId,campaign,message,target_ids:target.map(x=>x.id),target_count:target.length,
        created_by:user.id,created_by_role:role
      });
      return res.status(200).json({ok:true,status:'draft',draftId,campaign,message,targeted:target.length,speak:`Draft ready for ${target.length} contacts. Nothing has been sent.`});
    }

    const draftId=String(body.draftId||'');
    const draft=drafts.find(x=>x.draftId===draftId);
    if(!draft) return res.status(404).json({error:'campaign draft not found'});
    if(action==='cancel'){
      await logUsage(tenant.id,'campaign_cancelled',0,{draft_id:draftId,cancelled_by:user.id,cancelled_by_role:role});
      return res.status(200).json({ok:true,status:'cancelled',draftId});
    }
    if(action!=='approve_send') return res.status(400).json({error:'unknown action'});
    if(!APPROVERS.has(role)) return res.status(403).json({error:'owner, admin, or manager approval required'});
    if(draft.status==='sent') return res.status(409).json({error:'campaign already sent',result:draft.result});
    if(!tenant.phone_number) return res.status(409).json({error:'connect a tenant messaging number before sending'});
    if(!process.env.TELNYX_API_KEY) return res.status(503).json({error:'Telnyx is not configured'});

    const targetIds=Array.isArray(draft.target_ids)?draft.target_ids:[];
    const targets=clients.filter(x=>targetIds.includes(x.id)&&x.phone_number).slice(0,80);
    let delivered=0,skipped=0,failed=0;
    for(let i=0;i<targets.length;i+=10){
      const batch=targets.slice(i,i+10);
      const results=await Promise.allSettled(batch.map(client=>sendSMS({
        from:tenant.phone_number,to:client.phone_number,tenantId:tenant.id,
        profileId:process.env.TELNYX_MESSAGING_PROFILE,
        text:cleanMessage(draft.message).replace(/{{\s*first_name\s*}}/gi,firstName(client.name))
      })));
      for(const result of results){
        if(result.status==='rejected'){failed++;continue;}
        const value=result.value||{};
        if(value.skipped){skipped++;continue;}
        if(value.errors||value.error){failed++;continue;}
        if(value.data?.id||value.id){delivered++;continue;}
        failed++;
      }
    }
    const result={targeted:targets.length,delivered,skipped,failed};
    await logUsage(tenant.id,delivered?'campaign_sent':'campaign_send_failed',delivered,{
      draft_id:draftId,campaign:draft.campaign,result,approved_by:user.id,approved_by_role:role
    });
    if(delivered) await logUsage(tenant.id,'campaign_run',delivered,{campaign:draft.campaign,draft_id:draftId,target_count:delivered});
    return res.status(delivered?200:502).json({ok:delivered>0,status:delivered?'sent':'failed',draftId,result,speak:`Campaign complete: ${delivered} sent, ${skipped} skipped, ${failed} failed.`});
  }catch(error){
    console.error('[marketing-automations]',error);
    return res.status(500).json({error:String(error?.message||error)});
  }
}