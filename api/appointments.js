import { bearer, getUserFromToken } from './lib/auth.js';
import { resolveTenantForUser } from './lib/tenant-access.js';
import { db, upsertClient } from './lib/db.js';
import { sendSMS } from './telnyx-sms.js';

async function sendConfirmation(c,tenantId,booking){
  try{
    const [{data:tenant},{data:client},{data:svc}]=await Promise.all([
      c.from('tenants').select('name,phone_number').eq('id',tenantId).maybeSingle(),
      c.from('clients').select('name,phone').eq('id',booking.client_id).maybeSingle(),
      c.from('services').select('name').eq('id',booking.service_id).maybeSingle()
    ]);
    if(!client?.phone||!tenant?.phone_number)return;
    const when=new Date(booking.start_time).toLocaleString('en-US',{weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
    await sendSMS({from:tenant.phone_number,to:client.phone,text:'Confirmed at '+(tenant.name||'the salon')+': '+(svc?.name||'Appointment')+' on '+when+'. Reply STOP to opt out.',tenantId});
  }catch(e){console.warn('[appt] SMS:',e.message);}
}

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization');
  if(req.method==='OPTIONS')return res.status(204).end();
  try{
    const user=await getUserFromToken(bearer(req));
    if(!user)return res.status(401).json({ok:false,error:'Not authenticated'});
    const tenant=await resolveTenantForUser(user);
    if(!tenant?.id)return res.status(404).json({ok:false,error:'No tenant found'});
    const c=db();
    if(!c)return res.status(503).json({ok:false,error:'Database not configured'});

    if(req.method==='GET'){
      const date=req.query?.date||new Date().toISOString().slice(0,10);
      const start=new Date(date);start.setHours(0,0,0,0);
      const end=new Date(date);end.setHours(23,59,59,999);
      const {data,error}=await c.from('bookings').select('id,client_id,service_id,staff_id,start_time,end_time,status,total_amount,notes').eq('tenant_id',tenant.id).gte('start_time',start.toISOString()).lte('start_time',end.toISOString()).neq('status','cancelled').order('start_time');
      if(error)throw error;
      const [svcs,stff,clients]=await Promise.all([
        c.from('services').select('id,name,duration_minutes,price').eq('tenant_id',tenant.id).eq('is_active',true),
        c.from('staff').select('id,name,role').eq('tenant_id',tenant.id).eq('is_active',true),
        c.from('clients').select('id,name,phone').eq('tenant_id',tenant.id)
      ]);
      const svcMap=Object.fromEntries((svcs.data||[]).map(s=>[s.id,s]));
      const stfMap=Object.fromEntries((stff.data||[]).map(s=>[s.id,s]));
      const cliMap=Object.fromEntries((clients.data||[]).map(s=>[s.id,s]));
      return res.json({ok:true,date,bookings:(data||[]).map(b=>({...b,service:svcMap[b.service_id]||null,staff:stfMap[b.staff_id]||null,client:cliMap[b.client_id]||null})),services:svcs.data||[],staff:stff.data||[]});
    }

    const body=typeof req.body==='string'?JSON.parse(req.body||'{}'):(req.body||{});

    if(req.method==='POST'){
      const {service_id,staff_id,start_time,notes,client_name,client_phone}=body;
      if(!service_id||!start_time)return res.status(400).json({ok:false,error:'service_id and start_time required'});
      let clientId=body.client_id||null;
      if(!clientId&&(client_phone||client_name)){const cl=await upsertClient(tenant.id,{phone:client_phone,name:client_name});clientId=cl?.id||null;}
      const svc=(await c.from('services').select('duration_minutes,price').eq('id',service_id).maybeSingle()).data;
      const durMin=Number(svc?.duration_minutes||60);
      const startDt=new Date(start_time);
      const endDt=new Date(startDt.getTime()+durMin*60000);
      if(staff_id){
        const {data:conflicts}=await c.from('bookings').select('id').eq('tenant_id',tenant.id).eq('staff_id',staff_id).neq('status','cancelled').lt('start_time',endDt.toISOString()).gt('end_time',startDt.toISOString());
        if(conflicts?.length)return res.status(200).json({ok:false,conflict:true,error:'That time is already booked'});
      }
      const {data,error}=await c.from('bookings').insert({tenant_id:tenant.id,client_id:clientId,service_id,staff_id:staff_id||null,start_time:startDt.toISOString(),end_time:endDt.toISOString(),status:'confirmed',total_amount:Number(svc?.price||0),notes:notes||null,source:body.source||'dashboard'}).select().single();
      if(error)throw error;
      sendConfirmation(c,tenant.id,data).catch(()=>{});
      return res.json({ok:true,booking:data});
    }

    if(req.method==='PATCH'){
      const {id,status,start_time,end_time}=body;
      if(!id)return res.status(400).json({ok:false,error:'id required'});
      const patch={};
      if(status)patch.status=status;
      if(start_time)patch.start_time=start_time;
      if(end_time)patch.end_time=end_time;
      const {data,error}=await c.from('bookings').update(patch).eq('id',id).eq('tenant_id',tenant.id).select().single();
      if(error)throw error;
      return res.json({ok:true,booking:data});
    }

    if(req.method==='DELETE'){
      const id=req.query?.id;
      if(!id)return res.status(400).json({ok:false,error:'id required'});
      const {error}=await c.from('bookings').update({status:'cancelled'}).eq('id',id).eq('tenant_id',tenant.id);
      if(error)throw error;
      return res.json({ok:true});
    }

    return res.status(405).json({ok:false,error:'Method not allowed'});
  }catch(e){return res.status(500).json({ok:false,error:String(e?.message||e)});}
}
