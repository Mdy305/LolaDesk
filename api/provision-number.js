import { getUserFromToken, bearer } from './lib/auth.js';
import { resolveTenantForUser } from './lib/tenant-access.js';
import { db, upsertTenantNumber } from './lib/db.js';
import { invalidateRouting } from './lib/tenant-resolver.js';

const TELNYX='https://api.telnyx.com/v2';
function telnyxH(){return{'Content-Type':'application/json','Authorization':'Bearer '+process.env.TELNYX_API_KEY};}
function appUrl(){return process.env.APP_URL||'https://www.loladesk.com';}

async function tFetch(path,opts={}){
  const r=await fetch(TELNYX+path,{...opts,headers:{...telnyxH(),...(opts.headers||{})}});
  const j=await r.json().catch(()=>({errors:[{detail:'No body'}]}));
  if(!r.ok)throw new Error(j?.errors?.[0]?.detail||j?.error||'Telnyx '+r.status);
  return j;
}

async function searchNumbers(areaCode){
  // Use Telnyx's array-style feature filters and the correct area-code
  // param. The old comma-separated `filter[features]=sms,mms,voice` +
  // `filter[area_code]` form returns zero results, which broke the
  // onboarding number picker with a permanent "No numbers available".
  const p=new URLSearchParams();
  p.set('filter[country_code]','US');
  p.set('filter[features][]','voice');
  p.append('filter[features][]','sms');
  p.set('filter[limit]','10');
  p.set('filter[phone_number_type]','local');
  if(areaCode&&/^\d{3}$/.test(areaCode))p.set('filter[national_destination_code]',areaCode);
  const j=await tFetch('/available_phone_numbers?'+p);
  const nums=(j?.data||[]).filter(n=>n?.phone_number);
  if(!nums.length)throw new Error('No numbers available'+(areaCode?' in area code '+areaCode:'')+'. Try a different area code.');
  return nums;
}

async function getOrCreateTexmlApp(){
  const webhookUrl=appUrl()+'/api/telnyx-voice';
  const list=await tFetch('/texml_applications?page[size]=20').catch(()=>({data:[]}));
  const ex=(list?.data||[]).find(a=>a?.webhook_url===webhookUrl||a?.name==='LolaDesk');
  if(ex)return ex;
  const j=await tFetch('/texml_applications',{method:'POST',body:JSON.stringify({friendly_name:'LolaDesk',webhook_url:webhookUrl,webhook_api_version:'2',inbound:{channel_limit:10},outbound:{channel_limit:10}})});
  return j?.data||{};
}

async function purchaseNumber(phoneNumber,texmlAppId){
  const body={phone_numbers:[{phone_number:phoneNumber}]};
  if(texmlAppId)body.connection_id=texmlAppId;
  const j=await tFetch('/number_orders',{method:'POST',body:JSON.stringify(body)});
  return j?.data||{};
}

async function linkMessagingProfile(phoneNumberId){
  const profileId=process.env.TELNYX_MESSAGING_PROFILE_ID;
  if(!profileId)return false;
  await tFetch('/phone_numbers/'+phoneNumberId+'/messaging',{method:'PATCH',body:JSON.stringify({messaging_profile_id:profileId})}).catch(e=>console.warn('[PROVISION] SMS profile:',e.message));
  return true;
}

async function linkLolaBrain(phoneNumberId){
  const assistantId=process.env.TELNYX_LOLA_BRAIN_ID;
  if(!assistantId)return false;
  await tFetch('/ai/assistants/'+assistantId+'/phone_numbers',{method:'POST',body:JSON.stringify({phone_number_id:phoneNumberId})}).catch(e=>console.warn('[PROVISION] LolaBrain:',e.message));
  return true;
}

async function setDynamicVariablesWebhook(){
  const assistantId=process.env.TELNYX_LOLA_BRAIN_ID;
  if(!assistantId)return false;
  await tFetch('/ai/assistants/'+assistantId,{method:'PATCH',body:JSON.stringify({dynamic_variables_webhook_url:appUrl()+'/api/agent-variables'})}).catch(e=>console.warn('[PROVISION] DynVars:',e.message));
  return true;
}

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

    const phoneNumber=requestedNumber||(await searchNumbers(areaCode||''))[0].phone_number;
    const texmlApp=await getOrCreateTexmlApp();
    const texmlAppId=texmlApp?.id||texmlApp?.data?.id;
    await purchaseNumber(phoneNumber,texmlAppId);
    await new Promise(r=>setTimeout(r,3000));

    const numbersRes=await tFetch('/phone_numbers?filter[phone_number]='+encodeURIComponent(phoneNumber)).catch(()=>({data:[]}));
    const phoneNumberId=numbersRes?.data?.[0]?.id;

    const smsLinked=phoneNumberId?await linkMessagingProfile(phoneNumberId):false;
    const brainLinked=phoneNumberId?await linkLolaBrain(phoneNumberId):false;
    await setDynamicVariablesWebhook();

    const c=db();
    if(c){
      await c.from('tenants').update({phone_number:phoneNumber,telnyx_phone_id:phoneNumberId||null,texml_app_id:texmlAppId||null,provisioning_status:'active',provisioned_at:new Date().toISOString(),booking_url:tenant.booking_url||appUrl()+'/book.html?t='+tenant.slug}).eq('id',tenant.id);
      await c.from('tenant_onboarding').update({stage:'phone_provisioned',updated_at:new Date().toISOString()}).eq('tenant_id',tenant.id).maybeSingle().catch(()=>{});
      // Keep the authoritative routing table in sync so inbound calls
      // resolve to this tenant on the very next webhook.
      await upsertTenantNumber(tenant.id, phoneNumber, { kind:'primary', connectionId: texmlAppId || null, status:'active' });
      invalidateRouting(phoneNumber);
    }

    return res.json({ok:true,phoneNumber,texmlAppId,messagingProfileLinked:smsLinked,lolaBrainLinked:brainLinked,message:'Your Lola number is ready: '+phoneNumber});
  }catch(e){
    console.error('[PROVISION]',e.message);
    return res.status(500).json({ok:false,error:String(e?.message||e)});
  }
}
