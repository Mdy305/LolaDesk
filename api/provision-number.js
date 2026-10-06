import { getUserFromToken, bearer, isAdminEmail } from './lib/auth.js';
import { resolveTenantForUser } from './lib/tenant-access.js';
import { searchNumbers, getAccountBalance, provisionNumberForTenant, attachOwnedNumberForTenant, freePlatformNumbers } from './lib/telnyx-provision.js';
import { ensureBookingBaseline } from './lib/booking-seed.js';
import { db, e164 } from './lib/db.js';

// A number already routed to ANOTHER salon can never be attached here.
async function ownedByAnotherSalon(tenantId, number){
  const c = db(); const n = e164(number); if(!c || !n) return false;
  const [a, b] = await Promise.all([
    c.from('tenant_numbers').select('tenant_id').eq('phone_number', n).limit(5),
    c.from('tenants').select('id').eq('phone_number', n).limit(5),
  ]);
  return (a.data || []).some(r => r.tenant_id && r.tenant_id !== tenantId) || (b.data || []).some(r => r.id !== tenantId);
}

// Wire the tenant's booking configuration (settings, services, staff+
// schedule, hours) right after their number is live, so "She is ready"
// actually means she can take the first booking. Best-effort: the number is
// already wired, so a seed failure must surface in the response, not fail
// the whole provision.
const isAdmin = (email) => isAdminEmail(email);

// LolaDesk's own lines (owner line, support/customer-care, demo/sender numbers) can NEVER be
// attached to a salon — not even by an admin through this endpoint.
export async function platformReservedNumbers(){
  const set = new Set();
  for (const k of ['OWNER_LINE_NUMBER', 'LOLADESK_OWNER_LINE', 'TELNYX_FROM_NUMBER', 'TELNYX_NUMBER', 'DEMO_FROM_NUMBER', 'SUPPORT_TRANSFER_NUMBER', 'CUSTOMER_CARE_NUMBER']) {
    const n = e164(process.env[k] || ''); if (n) set.add(n);
  }
  try{
    const c = db();
    if (c) {
      const { data } = await c.from('platform_settings').select('key,value').in('key', ['customer_care', 'owner_line', 'support_line']);
      for (const r of (data || [])) { const v = r?.value || {}; for (const x of [v.number, v.phone_number, v.phone]) { const n = e164(x || ''); if (n) set.add(n); } }
    }
  }catch(_){}
  return set;
}

async function seedBookability(tenant){
  try{
    return await ensureBookingBaseline(tenant.id);
  }catch(e){
    console.error('[PROVISION] booking-seed', e.message);
    return { seeded: [], error: e.message };
  }
}

// Telnyx rejects an order when available credit < the number's cost. Detect
// that specific failure and give the owner a clear next step instead of a 500.
const INSUFFICIENT_CREDIT = /not enough credit|insufficient (credit|funds)|credit available/i;

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization');
  if(req.method==='OPTIONS')return res.status(204).end();

  if(req.method==='GET'){
    try{
      const areaCode=req.query?.areaCode||req.query?.area_code||'';
      const nums=await searchNumbers(areaCode);
      // Balance is advisory — the Settings page shows it so owners top up
      // BEFORE a purchase fails, instead of learning mid-checkout.
      // Account balance and the platform's owned numbers are only for signed-in owners.
      const who=await getUserFromToken(bearer(req)).catch(()=>null);
      const balance=who&&isAdmin(who.email)?await getAccountBalance().catch(()=>null):null;
      // Free platform numbers (no salon uses them) — attaching one costs nothing, so onboarding
      // never stalls on credit. Never another salon's number.
      const reserved=who?await platformReservedNumbers():new Set();
      const owned=who?(await freePlatformNumbers().catch(()=>[])).filter(n=>!reserved.has(e164(n.phone_number))).map(n=>({phone_number:n.phone_number,status:n.status,sms_enabled:n.sms_enabled})):[];
      return res.json({ok:true,balance,numbers:nums.slice(0,10).map(n=>({phone_number:n.phone_number,region:n.region_information?.[0]?.region_name||'United States',monthly_cost:(()=>{ const v = n.cost_information?.monthly_cost ?? n.cost?.amount; return v!=null && v!=='' ? '$'+Number(v).toFixed(2)+'/mo' : ''; })()})),owned});
    }catch(e){return res.status(200).json({ok:false,error:e.message});}
  }

  if(req.method!=='POST')return res.status(405).json({ok:false,error:'Method not allowed'});

  try{
    const user=await getUserFromToken(bearer(req));
    if(!user)return res.status(401).json({ok:false,error:'Not authenticated'});
    const tenant=await resolveTenantForUser(user);
    if(!tenant?.id)return res.status(404).json({ok:false,error:'No tenant found'});
    const body=typeof req.body==='string'?JSON.parse(req.body||'{}'):(req.body||{});
    const {areaCode,phone_number:requestedNumber,use_existing:useExisting}=body;

    // Zero-cost path: attach a number the owner already has on Telnyx instead
    // of buying one. No purchase, no credit consumed — same activation result.
    // One Lola number per salon from the wizard (more from Settings → Phone with the owner's plan).
    try{
      const c=db();
      const { data: mine }=c?await c.from('tenant_numbers').select('phone_number,status').eq('tenant_id',tenant.id).limit(5):{data:[]};
      const has=(mine||[]).find(r=>r.status!=='released')?.phone_number||tenant.phone_number||null;
      if(has && !isAdmin(user.email) && !body.additional) return res.json({ok:true,phoneNumber:has,already:true,messagingProfileLinked:true,lolaBrainLinked:true,message:'Your Lola number is already live: '+has});
    }catch(_){}
    // Extra numbers (beyond the one Lola line) are a platform-admin action — never self-serve.
    if(body.additional && !isAdmin(user.email)) return res.status(403).json({ok:false,error:'Additional numbers are added by LolaDesk support. Contact support to add another line.'});
    if(useExisting && requestedNumber){
      const wanted=e164(requestedNumber);
      if(!wanted || !/^\+\d{10,15}$/.test(wanted)) return res.status(400).json({ok:false,error:'Enter a valid phone number, e.g. +13055550100'});
      if((await platformReservedNumbers()).has(wanted)) return res.status(403).json({ok:false,error:'That number is reserved for LolaDesk and cannot be attached to a salon.'});
      if(await ownedByAnotherSalon(tenant.id, requestedNumber)) return res.status(409).json({ok:false,error:'That number already belongs to another salon on LolaDesk.'});
      // Owners may only take a number from the free LolaDesk pool offered to them (GET → owned);
      // attaching any other number on the platform account is an admin action.
      if(!isAdmin(user.email)){
        const pool=await freePlatformNumbers().catch(()=>[]);
        if(!pool.some(n=>e164(n.phone_number)===wanted)) return res.status(403).json({ok:false,error:'That number is not available. Pick a ready LolaDesk number or a new local number.'});
      }
      const result=await attachOwnedNumberForTenant(tenant,requestedNumber);
      const bookingSeed=await seedBookability(tenant);
      return res.json({ok:true,phoneNumber:result.phoneNumber,texmlAppId:result.voiceLinked?process.env.TELNYX_VOICE_APP_ID:null,messagingProfileLinked:result.smsLinked,lolaBrainLinked:result.brainLinked,attachedExisting:true,message:'Your number is wired to Lola: '+result.phoneNumber,bookingSeed});
    }

    const result=await provisionNumberForTenant(tenant,{areaCode,requestedNumber});
    const bookingSeed=await seedBookability(tenant);
    return res.json({ok:true,phoneNumber:result.phoneNumber,texmlAppId:result.texmlAppId,messagingProfileLinked:result.smsLinked,lolaBrainLinked:result.brainLinked,message:'Your Lola number is ready: '+result.phoneNumber,bookingSeed});
  }catch(e){
    const msg=String(e?.message||e);
    if(INSUFFICIENT_CREDIT.test(msg)){
      // 402 Payment Required — the owner's action: top up Telnyx credit.
      const balance=await getAccountBalance().catch(()=>null);
      return res.status(402).json({
        ok:false,error:'Your LolaDesk account needs a small Telnyx credit top-up before buying this number.',
        code:'insufficient_credit',balance,detail:msg
      });
    }
    console.error('[PROVISION]',e.message);
    return res.status(500).json({ok:false,error:msg});
  }
}
