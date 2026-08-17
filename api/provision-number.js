import { getUserFromToken, bearer } from './lib/auth.js';
import { resolveTenantForUser } from './lib/tenant-access.js';
import { searchNumbers, provisionNumberForTenant } from './lib/telnyx-provision.js';

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization');
  if(req.method==='OPTIONS')return res.status(204).end();

  if(req.method==='GET'){
    try{
      const areaCode=req.query?.areaCode||req.query?.area_code||'';
      const nums=await searchNumbers(areaCode);
      return res.json({ok:true,numbers:nums.slice(0,10).map(n=>({phone_number:n.phone_number,region:n.region_information?.[0]?.region_name||'United States',monthly_cost:n.cost?.amount?'$'+Number(n.cost.amount).toFixed(2)+'/mo':''}))});
    }catch(e){return res.status(200).json({ok:false,error:e.message});}
  }

  if(req.method!=='POST')return res.status(405).json({ok:false,error:'Method not allowed'});

  try{
    const user=await getUserFromToken(bearer(req));
    if(!user)return res.status(401).json({ok:false,error:'Not authenticated'});
    const tenant=await resolveTenantForUser(user);
    if(!tenant?.id)return res.status(404).json({ok:false,error:'No tenant found'});
    const body=typeof req.body==='string'?JSON.parse(req.body||'{}'):(req.body||{});
    const {areaCode,phone_number:requestedNumber}=body;

    const result=await provisionNumberForTenant(tenant,{areaCode,requestedNumber});
    return res.json({ok:true,phoneNumber:result.phoneNumber,texmlAppId:result.texmlAppId,messagingProfileLinked:result.smsLinked,lolaBrainLinked:result.brainLinked,message:'Your Lola number is ready: '+result.phoneNumber});
  }catch(e){
    console.error('[PROVISION]',e.message);
    return res.status(500).json({ok:false,error:String(e?.message||e)});
  }
}
